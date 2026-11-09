import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeDrive } from '../fakeDrive';
import { type MountedFake, mountFake, writeNew } from '../mountFake';
import { errno } from '../stubs/fuse-native';

const flush = (m: MountedFake) => m.handle.pending.flush();

/** A FakeDrive whose trashNodes() fails. */
function failingTrash(fake: FakeDrive): FakeDrive {
    fake.trashNodes = async function* () {
        yield* [];
        throw new Error('trash failed');
    };
    return fake;
}

test('rename of a file onto a folder fails with EISDIR, on Drive or pending', { timeout: 5000 }, async (t) => {
    const fake = new FakeDrive();
    const dir = fake.addFolder(fake.rootUid, 'dir');
    const file = fake.addFile(fake.rootUid, 'f.txt', 'f');
    const m = await mountFake(t, fake);
    assert.deepEqual(await m.op('rename', '/f.txt', '/dir'), [errno('EISDIR')]);
    await writeNew(m, '/new.txt', 'n');
    assert.deepEqual(await m.op('rename', '/new.txt', '/dir'), [errno('EISDIR')]);
    assert.equal(m.fake.isTrashed(dir), false);
    assert.equal(m.fake.find('/f.txt'), file);
    await flush(m);
    // The pending file stayed a new file under its own name, not a "revision" of the folder.
    assert.deepEqual(m.fake.uploads.map((u) => [u.kind, u.name]), [['new', 'new.txt']]);
});

test('rename of a folder onto a file fails with ENOTDIR', { timeout: 5000 }, async (t) => {
    const fake = new FakeDrive();
    const dir = fake.addFolder(fake.rootUid, 'dir');
    const file = fake.addFile(fake.rootUid, 'f.txt', 'f');
    const m = await mountFake(t, fake);
    assert.deepEqual(await m.op('rename', '/dir', '/f.txt'), [errno('ENOTDIR')]);
    await writeNew(m, '/p.txt', 'p');
    assert.deepEqual(await m.op('rename', '/dir', '/p.txt'), [errno('ENOTDIR')]);
    assert.equal(m.fake.isTrashed(file), false);
    assert.equal(m.fake.find('/dir'), dir);
    assert.equal(m.handle.pending.has('/p.txt'), true);
});

test('rename of a folder onto a non-empty folder fails with ENOTEMPTY', { timeout: 5000 }, async (t) => {
    const fake = new FakeDrive();
    const src = fake.addFolder(fake.rootUid, 'src');
    const full = fake.addFolder(fake.rootUid, 'full');
    const inside = fake.addFile(full, 'x.txt', 'x');
    const busy = fake.addFolder(fake.rootUid, 'busy');
    const m = await mountFake(t, fake);
    await writeNew(m, '/busy/p.txt', 'p'); // only pending: not on Drive yet
    assert.deepEqual(await m.op('rename', '/src', '/full'), [errno('ENOTEMPTY')]);
    assert.deepEqual(await m.op('rename', '/src', '/busy'), [errno('ENOTEMPTY')]);
    for (const uid of [src, full, inside, busy]) {
        assert.equal(m.fake.isTrashed(uid), false);
    }
    assert.equal(m.fake.find('/src'), src);
});

test('rename of a folder onto an empty folder replaces it', { timeout: 5000 }, async (t) => {
    const fake = new FakeDrive();
    const src = fake.addFolder(fake.rootUid, 'src');
    const empty = fake.addFolder(fake.rootUid, 'empty');
    const m = await mountFake(t, fake);
    assert.deepEqual(await m.op('rename', '/src', '/empty'), [0]);
    assert.equal(m.fake.isTrashed(empty), true);
    assert.equal(m.fake.find('/empty'), src);
    assert.equal(m.fake.find('/src'), undefined);
});

test("a rename that fails keeps the destination's open handles attached", { timeout: 5000 }, async (t) => {
    const fake = new FakeDrive();
    fake.addFile(fake.rootUid, 'a.txt', 'from a');
    const b = fake.addFile(fake.rootUid, 'b.txt', 'from b');
    const m = await mountFake(t, failingTrash(fake));
    const [, fd] = await m.op('open', '/b.txt', 2);
    assert.deepEqual(await m.op('rename', '/a.txt', '/b.txt'), [errno('EIO')]);
    const data = Buffer.from('X');
    assert.deepEqual(await m.op('write', '/b.txt', fd, data, data.length, 0), [data.length]);
    assert.equal(m.handle.pending.get('/b.txt')?.kind, 'revision', 'the write started a revision of b');
    await m.op('release', '/b.txt', fd);
    await flush(m);
    assert.deepEqual(m.fake.uploads.map((u) => [u.kind, u.nodeUid]), [['revision', b]]);
    assert.equal(m.fake.contentOf(b), 'Xrom b');
});
