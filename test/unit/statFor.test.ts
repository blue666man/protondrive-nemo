import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { NodeType, type NodeEntity } from '@protontech/drive-sdk';

import { statFor } from '../../src/fuseOps';
import { mount } from '../../src/mount';
import { FakeDrive } from '../fakeDrive';
import { callOp, fakeDrive, tempDir } from '../helpers';
import Fuse from '../stubs/fuse-native';

const CLAIMED = new Date('2001-02-03T04:05:06.789Z');
const SERVER = new Date('2030-01-01T00:00:00Z');

function node(fields: Record<string, unknown>): NodeEntity {
    return { uid: 'n', name: { ok: true, value: 'n' }, modificationTime: SERVER, ...fields } as unknown as NodeEntity;
}

test('files: mtime and atime are the claimed time, ctime is the server time', () => {
    const st = statFor(
        node({ type: NodeType.File, activeRevision: { claimedSize: 3, claimedModificationTime: CLAIMED } }),
    );
    assert.equal(st.mtime.getTime(), CLAIMED.getTime());
    assert.equal(st.atime.getTime(), CLAIMED.getTime());
    assert.equal(st.ctime.getTime(), SERVER.getTime());
    assert.equal(st.size, 3);
});

test('files without a claimed time fall back to the server time', () => {
    const st = statFor(node({ type: NodeType.File, activeRevision: { claimedSize: 1 } }));
    assert.equal(st.mtime.getTime(), SERVER.getTime());
});

test('folders use folder.claimedModificationTime', () => {
    const st = statFor(node({ type: NodeType.Folder, folder: { claimedModificationTime: CLAIMED, isImported: false } }));
    assert.equal(st.mtime.getTime(), CLAIMED.getTime());
    assert.equal(st.ctime.getTime(), SERVER.getTime());
});

test('getattr on the mount reports the claimed time of a file on Drive', async (t) => {
    const tmp = tempDir();
    const fake = new FakeDrive();
    fake.addFile(fake.rootUid, 'old.txt', 'abc', CLAIMED);
    Fuse.reset();
    const handle = await mount({ ...fakeDrive(path.join(tmp.dir, 'cache')), sdk: fake.client }, path.join(tmp.dir, 'mnt'));
    t.after(async () => {
        await handle.ipc.stop();
        await handle.releaseLock();
        tmp.cleanup();
    });
    const [err, st] = (await callOp(Fuse.last().ops.getattr, '/old.txt')) as [number, { mtime: Date }];
    assert.equal(err, 0);
    assert.equal(st.mtime.getTime(), CLAIMED.getTime());
});
