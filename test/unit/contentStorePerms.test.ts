import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import type { ProtonDriveClient } from '@protontech/drive-sdk';

import { ContentStore } from '../../src/contentStore';
import { downloadingSdk, fileNode, silentLogger, tempDir } from '../helpers';

// The modes must hold whatever the umask: with umask 0 the defaults would be
// 0777 for directories and 0666 for files.
let tmp: ReturnType<typeof tempDir>;
let savedUmask: number;

beforeEach(() => {
    tmp = tempDir();
    savedUmask = process.umask(0);
});

afterEach(() => {
    process.umask(savedUmask);
    tmp.cleanup();
});

function mode(p: string): string {
    return (statSync(p).mode & 0o777).toString(8);
}

test('createEmptyLocal creates the blob dir 0700 and the blob 0600', async () => {
    const blobs = path.join(tmp.dir, 'blobs');
    const store = new ContentStore({} as ProtonDriveClient, blobs, silentLogger);

    const local = await store.createEmptyLocal('pending:/new.txt');

    assert.equal(mode(blobs), '700');
    assert.equal(mode(local), '600');
});

test('ensureDownloaded writes the decrypted blob 0600 in a 0700 dir', async () => {
    const blobs = path.join(tmp.dir, 'blobs');
    const store = new ContentStore(downloadingSdk('secret'), blobs, silentLogger);

    const local = await store.ensureDownloaded(fileNode('node-1', 6));

    assert.equal(mode(blobs), '700');
    assert.equal(mode(local), '600');
});

test('an existing world-readable blob dir is tightened to 0700', async () => {
    const blobs = path.join(tmp.dir, 'blobs');
    mkdirSync(blobs);
    chmodSync(blobs, 0o755);
    writeFileSync(path.join(blobs, 'old'), 'plaintext from an older version', { mode: 0o644 });
    const store = new ContentStore({} as ProtonDriveClient, blobs, silentLogger);

    await store.createEmptyLocal('pending:/new.txt');

    assert.equal(mode(blobs), '700');
});
