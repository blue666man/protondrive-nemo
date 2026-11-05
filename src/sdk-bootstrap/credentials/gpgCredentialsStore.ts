import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { Logger, ValidationError } from '@protontech/drive-sdk';

import type { Credentials, CredentialsStore } from './interface';
import { parseStoredSnapshot } from './parseCredentials';

/**
 * Credentials store backed by GnuPG: the session snapshot is encrypted to the
 * recipient key named by `PROTONDRIVE_NEMO_GPG_RECIPIENT` and written to a local
 * file. Only ciphertext touches disk; decryption happens in memory through the
 * user's gpg-agent, so no passphrase has to be supplied to this tool.
 */
export class GpgCredentialsStore implements CredentialsStore {
    constructor(
        private readonly credentialsFile: string,
        private readonly recipient: string,
        private readonly logger: Logger,
    ) {}

    async load(): Promise<Credentials | null> {
        let encrypted: Buffer;
        try {
            encrypted = await readFile(this.credentialsFile);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                this.logger.debug('No encrypted credentials file present');
                return null;
            }
            throw error;
        }

        let plaintext: string;
        try {
            // No key fetch while decrypting either (a signed message would
            // otherwise look up its signer if gpg.conf asks for that).
            const decrypted = await runGpg(
                ['--batch', '--quiet', '--no-tty', '--no-auto-key-retrieve', '--decrypt'],
                encrypted,
            );
            plaintext = decrypted.toString('utf8');
        } catch (error: unknown) {
            // gpg missing altogether: say that, not "is the secret key available".
            if (error instanceof ValidationError) throw error;
            throw new ValidationError(
                `Failed to decrypt ${this.credentialsFile} with GPG (is the secret key for ${this.recipient} available to gpg-agent?)`,
                undefined,
                { cause: error },
            );
        }

        const snapshot = parseStoredSnapshot(plaintext);
        if (!snapshot) {
            throw new ValidationError(`${this.credentialsFile} does not contain a valid credentials snapshot`);
        }
        return snapshot;
    }

    async save(snapshot: Credentials): Promise<void> {
        const encrypted = await runGpg(
            [
                '--batch',
                '--yes',
                '--no-tty',
                '--trust-model',
                'always',
                // Only a key already in the local keyring may be used: gpg's
                // default lookup includes WKD, which for a mistyped or
                // not-yet-imported recipient would fetch some key from the
                // network and encrypt the account-wide session to it,
                // unchecked under `--trust-model always`. `clear` first,
                // because mechanisms from gpg.conf otherwise still apply.
                '--auto-key-locate',
                'clear,local',
                '--no-auto-key-retrieve',
                '--armor',
                '--encrypt',
                '--recipient',
                this.recipient,
            ],
            Buffer.from(JSON.stringify(snapshot), 'utf8'),
        );
        await this.writeAtomically(encrypted);
        this.logger.debug(`Wrote GPG-encrypted credentials to ${this.credentialsFile}`);
    }

    /**
     * The session is re-saved on every token refresh, so a crash or a full
     * disk mid-write must not leave a torn file: write a fresh, uniquely
     * named 0600 temp file, fsync it, rename it over the old one and fsync
     * the directory. The old file or the new one survives, never a truncated
     * one.
     */
    private async writeAtomically(data: Buffer): Promise<void> {
        const dir = path.dirname(this.credentialsFile);
        // A temp name of its own per write: two saves of one profile racing
        // (e.g. two token refreshes) must not share, unlink or rename each
        // other's half-written file.
        const tmp = `${this.credentialsFile}.${process.pid}.${randomUUID()}.tmp`;
        await mkdir(dir, { recursive: true });
        try {
            const handle = await open(tmp, 'wx', 0o600);
            try {
                await handle.writeFile(data);
                await handle.sync();
            } finally {
                await handle.close();
            }
            await rename(tmp, this.credentialsFile);
        } catch (error: unknown) {
            await rm(tmp, { force: true });
            throw error;
        }
        const dirHandle = await open(dir, 'r');
        try {
            await dirHandle.sync();
        } finally {
            await dirHandle.close();
        }
    }

    async remove(): Promise<void> {
        await rm(this.credentialsFile, { force: true });
        this.logger.debug(`Removed encrypted credentials file ${this.credentialsFile}`);
    }
}

/**
 * Runs `gpg` with `args`, feeding `input` on stdin; resolves with stdout or
 * rejects on a non-zero exit. A missing `gpg` binary rejects with a
 * ValidationError saying so; every other failure is a plain Error.
 */
function runGpg(args: string[], input: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn('gpg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
                reject(new ValidationError('gpg not found on PATH (install GnuPG)', undefined, { cause: error }));
                return;
            }
            reject(error);
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve(Buffer.concat(stdout));
                return;
            }
            const message = Buffer.concat(stderr).toString('utf8').trim();
            reject(new Error(`gpg exited with code ${code}${message ? `: ${message}` : ''}`));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}
