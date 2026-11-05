import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
            plaintext = (await runGpg(['--batch', '--quiet', '--no-tty', '--decrypt'], encrypted)).toString('utf8');
        } catch (error: unknown) {
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
                '--armor',
                '--encrypt',
                '--recipient',
                this.recipient,
            ],
            Buffer.from(JSON.stringify(snapshot), 'utf8'),
        );
        await mkdir(path.dirname(this.credentialsFile), { recursive: true });
        await writeFile(this.credentialsFile, encrypted, { mode: 0o600 });
        this.logger.debug(`Wrote GPG-encrypted credentials to ${this.credentialsFile}`);
    }

    async remove(): Promise<void> {
        await rm(this.credentialsFile, { force: true });
        this.logger.debug(`Removed encrypted credentials file ${this.credentialsFile}`);
    }
}

/** Runs `gpg` with `args`, feeding `input` on stdin; resolves with stdout or rejects on a non-zero exit. */
function runGpg(args: string[], input: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn('gpg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', reject);
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
