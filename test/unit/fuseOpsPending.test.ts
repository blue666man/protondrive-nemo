import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeDrive } from '../fakeDrive';
import { getattr, type MountedFake, mountFake, writeNew } from '../mountFake';
import { errno } from '../stubs/fuse-native';

const T1 = new Date('2001-02-03T04:05:06Z');
const T2 = new Date('2002-03-04T05:06:07Z');

const flush = (m: MountedFake) => m.handle.pending.flush();
const uploads = (m: MountedFake) =>
    m.fake.uploads.map((u) => ({ kind: u.kind, name: u.name, claimed: u.claimedModificationTime?.toISOString() }));

test('a new file is not uploaded on release, only after the settle window', async (t) => {
    const m = await mountFake(t);
    await writeNew(m, '/a.txt', 'hello');
    assert.equal(m.fake.uploads.length, 0);
    const local = await getattr(m, '/a.txt');
    assert.equal(local.size, 5);
    assert.equal((await flush(m)).uploaded, 1);
    assert.deepEqual(uploads(m), [{ kind: 'new', name: 'a.txt', claimed: local.mtime.toISOString() }]);
});

test('rsync order (release, utimens, rename): one upload, final name, time from utimens', async (t) => {
    const m = await mountFake(t);
    await writeNew(m, '/.a.txt.Xy12Zq', 'hello');
    assert.deepEqual(await m.op('utimens', '/.a.txt.Xy12Zq', T1.getTime(), T1.getTime()), [0]);
    assert.deepEqual(await m.op('rename', '/.a.txt.Xy12Zq', '/a.txt'), [0]);
    assert.equal((await getattr(m, '/a.txt')).mtime.toISOString(), T1.toISOString());
    await flush(m);
    assert.deepEqual(uploads(m), [{ kind: 'new', name: 'a.txt', claimed: T1.toISOString() }]);
});

test('utimens and rename that arrive before the release count too', async (t) => {
    const m = await mountFake(t);
    const [, fd] = await m.op('create', '/.b.txt.Q', 0o644);
    await m.op('write', '/.b.txt.Q', fd, Buffer.from('b'), 1, 0);
    await m.op('utimens', '/.b.txt.Q', T1.getTime(), T1.getTime());
    await m.op('rename', '/.b.txt.Q', '/b.txt');
    assert.deepEqual(await flush(m), { uploaded: 0, failed: 0, retrying: 0, open: 1 });
    await m.op('release', '/b.txt', fd);
    await flush(m);
    assert.deepEqual(uploads(m), [{ kind: 'new', name: 'b.txt', claimed: T1.toISOString() }]);
});

test('readdir and getattr show a pending file before it reaches Drive', async (t) => {
    const m = await mountFake(t);
    await writeNew(m, '/p.txt', 'abc');
    assert.deepEqual(await m.op('readdir', '/'), [0, ['p.txt']]);
    assert.equal((await getattr(m, '/p.txt')).size, 3);
});

test('a new file renamed onto an existing Drive file becomes a revision of it (history kept)', async (t) => {
    const fake = new FakeDrive();
    const uid = fake.addFile(fake.rootUid, 'doc.txt', 'v1');
    const m = await mountFake(t, fake);
    await writeNew(m, '/.doc.txt.swp', 'v2');
    assert.deepEqual(await m.op('rename', '/.doc.txt.swp', '/doc.txt'), [0]);
    assert.equal((await getattr(m, '/doc.txt')).size, 2);
    await flush(m);
    assert.deepEqual(m.fake.uploads.map((u) => [u.kind, u.nodeUid]), [['revision', uid]]);
    assert.equal(m.fake.contentOf(uid), 'v2');
    assert.equal(m.fake.isTrashed(uid), false);
});

test('opening a pending file serves its local copy and holds off the upload', async (t) => {
    const m = await mountFake(t);
    await writeNew(m, '/o.txt', 'one');
    const [err, fd] = await m.op('open', '/o.txt', 0);
    assert.equal(err, 0);
    const buf = Buffer.alloc(3);
    assert.deepEqual(await m.op('read', '/o.txt', fd, buf, 3, 0), [3]);
    assert.equal(buf.toString(), 'one');
    assert.equal((await flush(m)).open, 1);
    await m.op('release', '/o.txt', fd);
    assert.equal((await flush(m)).uploaded, 1);
});

test('writing to or truncating a file on Drive makes a pending revision', async (t) => {
    const fake = new FakeDrive();
    const uid = fake.addFile(fake.rootUid, 'w.txt', 'abc', T1);
    const m = await mountFake(t, fake);
    const [, fd] = await m.op('open', '/w.txt', 2);
    assert.deepEqual(await m.op('write', '/w.txt', fd, Buffer.from('XY'), 2, 0), [2]);
    await m.op('release', '/w.txt', fd);
    assert.equal(m.fake.uploads.length, 0);
    await flush(m);
    assert.equal(m.fake.contentOf(uid), 'XYc');
    // truncate without an open handle used to change only the local copy.
    assert.deepEqual(await m.op('truncate', '/w.txt', 1), [0]);
    assert.equal((await getattr(m, '/w.txt')).size, 1);
    await flush(m);
    assert.equal(m.fake.contentOf(uid), 'X');
    assert.deepEqual(m.fake.uploads.map((u) => u.kind), ['revision', 'revision']);
});

test('unlink of a pending new file cancels it: no upload, nothing trashed', async (t) => {
    const m = await mountFake(t);
    await writeNew(m, '/gone.txt', 'x');
    assert.deepEqual(await m.op('unlink', '/gone.txt'), [0]);
    assert.deepEqual(await flush(m), { uploaded: 0, failed: 0, retrying: 0, open: 0 });
    assert.equal(m.fake.uploads.length, 0);
    assert.deepEqual(await m.op('readdir', '/'), [0, []]);
});

test('unlink of a pending revision cancels it and trashes the Drive file', async (t) => {
    const fake = new FakeDrive();
    const uid = fake.addFile(fake.rootUid, 'r.txt', 'abc');
    const m = await mountFake(t, fake);
    const [, fd] = await m.op('open', '/r.txt', 2);
    await m.op('write', '/r.txt', fd, Buffer.from('z'), 1, 0);
    await m.op('release', '/r.txt', fd);
    assert.deepEqual(await m.op('unlink', '/r.txt'), [0]);
    await flush(m);
    assert.equal(m.fake.uploads.length, 0);
    assert.equal(m.fake.isTrashed(uid), true);
});

test('mv of a pending file into another folder: one upload, in the destination', async (t) => {
    const m = await mountFake(t);
    assert.deepEqual(await m.op('mkdir', '/d', 0o755), [0]);
    await writeNew(m, '/a.txt', 'a');
    assert.deepEqual(await m.op('rename', '/a.txt', '/d/a.txt'), [0]);
    await flush(m);
    assert.deepEqual(m.fake.uploads.map((u) => [u.parentUid, u.name]), [[m.fake.find('/d'), 'a.txt']]);
});

test('renaming a folder carries the pending files inside it along', async (t) => {
    const m = await mountFake(t);
    await m.op('mkdir', '/d', 0o755);
    await writeNew(m, '/d/a.txt', 'a');
    assert.deepEqual(await m.op('rename', '/d', '/e'), [0]);
    assert.equal((await getattr(m, '/e/a.txt')).size, 1);
    await flush(m);
    assert.equal(m.fake.find('/e/a.txt'), m.fake.uploads[0].nodeUid);
});

test('utimens on a file or folder already on Drive is accepted and changes nothing', async (t) => {
    const fake = new FakeDrive();
    fake.addFile(fake.rootUid, 'old.txt', 'x', T1);
    fake.addFolder(fake.rootUid, 'dir', T1);
    const m = await mountFake(t, fake);
    for (const p of ['/old.txt', '/dir', '/']) {
        assert.deepEqual(await m.op('utimens', p, T2.getTime(), T2.getTime()), [0], `utimens ${p}`);
    }
    assert.equal((await getattr(m, '/old.txt')).mtime.toISOString(), T1.toISOString());
    assert.equal((await getattr(m, '/dir')).mtime.toISOString(), T1.toISOString());
    assert.deepEqual(await m.op('utimens', '/missing', T2.getTime(), T2.getTime()), [errno('ENOENT')]);
    assert.equal(m.fake.uploads.length, 0);
});

test('utimens with UTIME_NOW/UTIME_OMIT, as fuse-native passes them, leaves the mtime alone', async (t) => {
    const m = await mountFake(t);
    await writeNew(m, '/t.txt', 't');
    await m.op('utimens', '/t.txt', T1.getTime(), T1.getTime());
    // libfuse 2: tv_sec 0 plus a marker tv_nsec, which fuse-native turns into 1073 ms.
    assert.deepEqual(await m.op('utimens', '/t.txt', 1073, 1073), [0]);
    assert.equal((await getattr(m, '/t.txt')).mtime.toISOString(), T1.toISOString());
});

test('chmod and chown fail with EPERM on existing paths, ENOENT on missing ones', async (t) => {
    const fake = new FakeDrive();
    fake.addFile(fake.rootUid, 'f.txt', 'x');
    const m = await mountFake(t, fake);
    await writeNew(m, '/new.txt', 'n');
    for (const p of ['/', '/f.txt', '/new.txt']) {
        assert.deepEqual(await m.op('chmod', p, 0o600), [errno('EPERM')], `chmod ${p}`);
        assert.deepEqual(await m.op('chown', p, 0, 0), [errno('EPERM')], `chown ${p}`);
    }
    assert.deepEqual(await m.op('chmod', '/missing', 0o600), [errno('ENOENT')]);
    assert.deepEqual(await m.op('chown', '/missing', 0, 0), [errno('ENOENT')]);
});

test('rmdir refuses a folder with files in it, pending or uploaded', async (t) => {
    const m = await mountFake(t);
    await m.op('mkdir', '/d', 0o755);
    await writeNew(m, '/d/a.txt', 'a');
    assert.deepEqual(await m.op('rmdir', '/d'), [errno('ENOTEMPTY')]);
    await flush(m);
    assert.deepEqual(await m.op('rmdir', '/d'), [errno('ENOTEMPTY')]);
    assert.deepEqual(await m.op('unlink', '/d/a.txt'), [0]);
    assert.deepEqual(await m.op('rmdir', '/d'), [0]);
});
