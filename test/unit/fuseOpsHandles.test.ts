import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeDrive } from '../fakeDrive';
import { type MountedFake, mountFake, writeNew } from '../mountFake';
import { errno } from '../stubs/fuse-native';

const flush = (m: MountedFake) => m.handle.pending.flush();

async function write(m: MountedFake, filePath: string, fd: unknown, text: string, position: number): Promise<void> {
    const data = Buffer.from(text);
    assert.deepEqual(await m.op('write', filePath, fd, data, data.length, position), [data.length], `write ${filePath}`);
}

async function readAll(m: MountedFake, filePath: string): Promise<string> {
    const [err, fd] = await m.op('open', filePath, 0);
    assert.equal(err, 0, `open ${filePath}`);
    const buf = Buffer.alloc(64);
    const [n] = (await m.op('read', filePath, fd, buf, buf.length, 0)) as [number];
    await m.op('release', filePath, fd);
    return buf.subarray(0, n).toString();
}

test('writes through a handle on an unlinked file stay local; the name is free again', { timeout: 5000 }, async (t) => {
    const fake = new FakeDrive();
    const uid = fake.addFile(fake.rootUid, 'log.txt', 'old');
    const m = await mountFake(t, fake);
    const [, fd] = await m.op('open', '/log.txt', 2);
    assert.deepEqual(await m.op('unlink', '/log.txt'), [0]);
    await write(m, '/log.txt', fd, 'more', 3);
    assert.deepEqual(await m.op('readdir', '/'), [0, []]);
    assert.deepEqual(await m.op('getattr', '/log.txt'), [errno('ENOENT')]);
    await writeNew(m, '/log.txt', 'fresh');
    await m.op('release', '/log.txt', fd);
    await flush(m);
    assert.deepEqual(m.fake.uploads.map((u) => [u.kind, u.name]), [['new', 'log.txt']]);
    assert.notEqual(m.fake.uploads[0].nodeUid, uid);
    assert.equal(m.fake.contentOf(m.fake.uploads[0].nodeUid), 'fresh');
});

test('writes through a handle on a file replaced by a rename stay local', { timeout: 5000 }, async (t) => {
    const fake = new FakeDrive();
    fake.addFile(fake.rootUid, 'a.txt', 'from a');
    fake.addFile(fake.rootUid, 'b.txt', 'from b');
    const m = await mountFake(t, fake);
    const [, fd] = await m.op('open', '/b.txt', 2);
    assert.deepEqual(await m.op('rename', '/a.txt', '/b.txt'), [0]);
    await write(m, '/b.txt', fd, 'X', 0);
    assert.equal(m.handle.pending.has('/b.txt'), false);
    assert.equal(await readAll(m, '/b.txt'), 'from a');
    await m.op('release', '/b.txt', fd);
    await flush(m);
    assert.equal(m.fake.uploads.length, 0);
});

test('GLib-style save while another handle is open: one revision, the final content', { timeout: 5000 }, async (t) => {
    const fake = new FakeDrive();
    const uid = fake.addFile(fake.rootUid, 'doc.txt', 'v1');
    const m = await mountFake(t, fake);
    const [, h] = await m.op('open', '/doc.txt', 2);
    const [, c] = await m.op('create', '/.doc.tmp', 0o644);
    await write(m, '/.doc.tmp', c, 'part', 0);
    assert.deepEqual(await m.op('rename', '/.doc.tmp', '/doc.txt'), [0]);
    await write(m, '/doc.txt', h, 'X', 0);
    await m.op('release', '/doc.txt', h);
    assert.deepEqual(await flush(m), { uploaded: 0, failed: 0, retrying: 0, open: 1 });
    assert.equal(m.fake.uploads.length, 0);
    await write(m, '/doc.txt', c, '-rest', 4);
    await m.op('release', '/doc.txt', c);
    await flush(m);
    assert.deepEqual(m.fake.uploads.map((u) => [u.kind, u.nodeUid]), [['revision', uid]]);
    assert.equal(m.fake.contentOf(uid), 'part-rest');
});
