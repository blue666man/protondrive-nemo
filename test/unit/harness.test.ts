import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { mount } from '../../src/mount';
import Fuse, { errno } from '../stubs/fuse-native';
import { callOp, fakeDrive, tempDir } from '../helpers';

let tmp: ReturnType<typeof tempDir>;
let handle: Awaited<ReturnType<typeof mount>> | undefined;

beforeEach(() => {
    tmp = tempDir();
    Fuse.reset();
});

afterEach(async () => {
    await handle?.ipc.stop();
    handle = undefined;
    tmp.cleanup();
});

test('mount() hands its ops and options to the (stubbed) Fuse constructor', async () => {
    handle = await mount(fakeDrive(path.join(tmp.dir, 'cache')), path.join(tmp.dir, 'mnt'));

    const fuse = Fuse.last();
    assert.equal(fuse.mnt, path.join(tmp.dir, 'mnt'));
    assert.equal(fuse.mounted, true);
    assert.equal(fuse.opts.fsname, 'protondrive-nemo');

    const [err, stat] = (await callOp(fuse.ops.getattr, '/')) as [number, { mode: number }];
    assert.equal(err, 0);
    assert.equal(stat.mode & fsConstants.S_IFMT, fsConstants.S_IFDIR);
});

test('the stub exposes fuse-native errno constants', () => {
    assert.equal((Fuse as unknown as Record<string, number>).ENOENT, -2);
    assert.equal(errno('ENOENT'), -2);
});
