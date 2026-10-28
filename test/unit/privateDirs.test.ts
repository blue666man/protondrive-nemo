import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { ensurePrivateDir, mkdirPrivate } from '../../src/privateDirs';
import { tempDir } from '../helpers';

// With umask 0 the defaults would be 0777, so a 0700 result proves the mode
// is explicit rather than inherited from the umask.
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

test('mkdirPrivate creates the dir and its missing parents 0700', async () => {
    await mkdirPrivate(path.join(tmp.dir, 'a', 'b'));
    assert.equal(mode(path.join(tmp.dir, 'a')), '700');
    assert.equal(mode(path.join(tmp.dir, 'a', 'b')), '700');
});

test('mkdirPrivate leaves the mode of an existing dir alone', async () => {
    const existing = path.join(tmp.dir, 'chosen-by-admin');
    mkdirSync(existing);
    chmodSync(existing, 0o740);
    await mkdirPrivate(existing);
    assert.equal(mode(existing), '740');
});

test('ensurePrivateDir tightens an existing dir to 0700', async () => {
    const existing = path.join(tmp.dir, 'blobs');
    mkdirSync(existing);
    chmodSync(existing, 0o755);
    await ensurePrivateDir(existing);
    assert.equal(mode(existing), '700');
});
