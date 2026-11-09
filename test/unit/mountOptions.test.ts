import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { msFromEnv } from '../../src/mount';
import { getattr, mountFake } from '../mountFake';
import { waitFor } from '../support';

test('msFromEnv reads whole milliseconds and rejects anything else', () => {
    delete process.env.PDN_TEST_MS;
    assert.equal(msFromEnv('PDN_TEST_MS', 2000), 2000);
    process.env.PDN_TEST_MS = '250';
    assert.equal(msFromEnv('PDN_TEST_MS', 2000), 250);
    for (const bad of ['-1', '1.5', 'soon']) {
        process.env.PDN_TEST_MS = bad;
        assert.throws(() => msFromEnv('PDN_TEST_MS', 2000), /PDN_TEST_MS/);
    }
    delete process.env.PDN_TEST_MS;
});

test('mount shows and uploads files an earlier run left pending', async (t) => {
    const claimed = new Date('2001-02-03T04:05:06Z');
    const m = await mountFake(t, undefined, (cacheDir) => {
        const dir = path.join(cacheDir, 'pending');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'left.blob'), 'left over');
        writeFileSync(
            path.join(dir, 'left.json'),
            JSON.stringify({
                id: 'left',
                kind: 'new',
                path: '/left.txt',
                parentUid: 'root',
                name: 'left.txt',
                claimedMtime: claimed.getTime(),
                attempts: 0,
                state: 'pending',
            }),
        );
    });
    assert.equal((await getattr(m, '/left.txt')).size, 9);
    await waitFor(() => m.fake.uploads.length === 1, 3000, 'the resumed upload');
    assert.equal(m.fake.uploads[0].claimedModificationTime?.toISOString(), claimed.toISOString());
});
