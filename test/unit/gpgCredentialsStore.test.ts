import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { ValidationError } from '@protontech/drive-sdk';

import { getConfig } from '../../src/sdk-bootstrap/config';
import { initCredentials } from '../../src/sdk-bootstrap/credentials';
import { GpgCredentialsStore } from '../../src/sdk-bootstrap/credentials/gpgCredentialsStore';
import type { Credentials } from '../../src/sdk-bootstrap/credentials/interface';
import { silentLogger } from '../helpers';

// A throwaway keyring: never the user's ~/.gnupg. Short path: gpg-agent's
// socket path must fit in sun_path.
const home = mkdtempSync(path.join(tmpdir(), 'pdg-'));
const files = mkdtempSync(path.join(tmpdir(), 'pdg-files-'));
const savedHome = process.env.GNUPGHOME;
const RECIPIENT = 'protondrive-nemo-test@example.invalid';

// The shape parseStoredSnapshot() returns, so a round trip deep-equals it.
const snapshot: Credentials = {
    cachePassword: 'cache-pw-4f1d9a',
    userKeyPassword: 'user-key-pw-8c2e71',
    session: {
        uid: 'session-uid-a93b0c',
        accessToken: 'access-token-5d7e22',
        refreshToken: 'refresh-token-e61f48',
    },
    telemetryEnabled: false,
};

let counter = 0;
function credentialsFile(): string {
    counter += 1;
    return path.join(files, `nested-${counter}`, 'auth-session.gpg');
}

before(() => {
    process.env.GNUPGHOME = home;
    // Verified 2026-11-05: `future-default default` gives ed25519 + a cv25519
    // encryption subkey. (`ed25519 cert,encr` makes no encryption key, and gpg
    // then tries a WKD *network* lookup for the recipient: never do that.)
    execFileSync(
        'gpg',
        ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-gen-key', RECIPIENT, 'future-default', 'default', 'never'],
        { stdio: 'ignore' },
    );
});

after(() => {
    execFileSync('gpgconf', ['--kill', 'all'], { stdio: 'ignore' });
    if (savedHome === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(files, { recursive: true, force: true });
});

test('save() then load() round-trips the snapshot', async () => {
    const store = new GpgCredentialsStore(credentialsFile(), RECIPIENT, silentLogger);
    await store.save(snapshot);
    assert.deepEqual(await store.load(), snapshot);
});

test('only ASCII-armoured ciphertext, mode 0600, is written to disk', async () => {
    const file = credentialsFile();
    const store = new GpgCredentialsStore(file, RECIPIENT, silentLogger);
    await store.save(snapshot);
    const onDisk = readFileSync(file, 'utf8');
    assert.ok(onDisk.startsWith('-----BEGIN PGP MESSAGE-----'), onDisk.slice(0, 40));
    for (const value of [
        snapshot.cachePassword!,
        snapshot.userKeyPassword,
        snapshot.session.uid,
        snapshot.session.accessToken,
        snapshot.session.refreshToken!,
    ]) {
        assert.ok(!onDisk.includes(value), `ciphertext contains ${value}`);
    }
    assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('load() returns null when there is no file', async () => {
    const store = new GpgCredentialsStore(credentialsFile(), RECIPIENT, silentLogger);
    assert.equal(await store.load(), null);
});

test('load() rejects a file that is not PGP with a ValidationError naming it', async () => {
    const file = path.join(files, 'garbage.gpg');
    writeFileSync(file, 'not pgp');
    const store = new GpgCredentialsStore(file, RECIPIENT, silentLogger);
    await assert.rejects(store.load(), (error: unknown) => {
        assert.ok(error instanceof ValidationError, String(error));
        assert.ok(error.message.includes(file), error.message);
        return true;
    });
});

test('remove() deletes the file and is idempotent', async () => {
    const file = credentialsFile();
    const store = new GpgCredentialsStore(file, RECIPIENT, silentLogger);
    await store.save(snapshot);
    assert.ok(existsSync(file));
    await store.remove();
    assert.ok(!existsSync(file));
    await store.remove();
});

const ENV = ['PROTONDRIVE_NEMO_GPG_RECIPIENT', 'PROTONDRIVE_NEMO_CREDENTIALS_FILE'] as const;

function withEnv(values: Partial<Record<(typeof ENV)[number], string>>, fn: () => void): void {
    const saved = ENV.map((name) => [name, process.env[name]] as const);
    try {
        for (const name of ENV) delete process.env[name];
        Object.assign(process.env, values);
        fn();
    } finally {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

const configOptions = { appVersion: 'test', clientUidPrefix: 'test' };

test('initCredentials() without a GPG recipient throws a ValidationError naming the env var', () => {
    withEnv({}, () => {
        const config = { ...getConfig(configOptions), gpgRecipient: undefined };
        assert.throws(
            () => initCredentials(config, silentLogger),
            (error: unknown) => {
                assert.ok(error instanceof ValidationError, String(error));
                assert.ok(error.message.includes('PROTONDRIVE_NEMO_GPG_RECIPIENT'), error.message);
                return true;
            },
        );
    });
});

test('getConfig() reads the GPG recipient and credentials file from the environment', () => {
    withEnv({}, () => {
        const config = getConfig(configOptions);
        assert.equal(config.gpgRecipient, undefined);
        assert.equal(config.credentialsFile, path.join(config.appDir, 'auth-session.gpg'));
    });
    withEnv(
        { PROTONDRIVE_NEMO_GPG_RECIPIENT: RECIPIENT, PROTONDRIVE_NEMO_CREDENTIALS_FILE: '/tmp/elsewhere/session.gpg' },
        () => {
            const config = getConfig(configOptions);
            assert.equal(config.gpgRecipient, RECIPIENT);
            assert.equal(config.credentialsFile, '/tmp/elsewhere/session.gpg');
        },
    );
});
