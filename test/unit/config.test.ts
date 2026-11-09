import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { getConfig } from '../../src/sdk-bootstrap/config';

const ENV = ['PROTONDRIVE_NEMO_CREDENTIALS_FILE', 'PROTONDRIVE_NEMO_DATA_DIR'] as const;

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

const options = { appVersion: 'test', clientUidPrefix: 'test' };

test('PROTONDRIVE_NEMO_CREDENTIALS_FILE applies to the default profile only', () => {
    withEnv({ PROTONDRIVE_NEMO_CREDENTIALS_FILE: '/tmp/elsewhere/session.gpg' }, () => {
        assert.equal(getConfig(options).credentialsFile, '/tmp/elsewhere/session.gpg');
        assert.equal(getConfig({ ...options, profile: 'default' }).credentialsFile, '/tmp/elsewhere/session.gpg');
        const work = getConfig({ ...options, profile: 'work' });
        assert.equal(work.credentialsFile, path.join(work.appDir, 'auth-session.gpg'));
    });
});

test('profile names that would land inside the default data dir are rejected', () => {
    withEnv({ PROTONDRIVE_NEMO_DATA_DIR: '/tmp/pdn-data' }, () => {
        for (const profile of ['tmp', 'blobs', 'pending', 'TMP', 'Pending']) {
            assert.throws(
                () => getConfig({ ...options, profile }),
                (error: unknown) => {
                    assert.ok(error instanceof Error, String(error));
                    assert.match(error.message, new RegExp(`"${profile}" is reserved`));
                    return true;
                },
                profile,
            );
        }
        assert.equal(getConfig({ ...options, profile: 'work' }).cacheDir, path.join('/tmp/pdn-data', 'work'));
    });
});
