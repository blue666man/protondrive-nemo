import assert from 'node:assert/strict';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { mount, type MountHandle } from '../src/mount';
import { FakeDrive } from './fakeDrive';
import { callOp, fakeDrive, tempDir } from './helpers';
import Fuse from './stubs/fuse-native';

export interface MountedFake {
    fake: FakeDrive;
    handle: MountHandle;
    cacheDir: string;
    /** Calls FUSE handler `name`; resolves with the arguments it passed to its callback. */
    op(name: string, ...args: unknown[]): Promise<unknown[]>;
}

/**
 * mount() over a FakeDrive with the stubbed FUSE binding; settle window 60 s
 * (tests flush). `prepare` runs on the cache dir before mounting. Shuts down
 * as SIGTERM would when the test ends.
 */
export async function mountFake(
    t: TestContext,
    fake = new FakeDrive(),
    prepare?: (cacheDir: string) => void,
): Promise<MountedFake> {
    const tmp = tempDir();
    const cacheDir = path.join(tmp.dir, 'cache');
    const drive = { ...fakeDrive(cacheDir), sdk: fake.client };
    prepare?.(cacheDir);
    Fuse.reset();
    const handle = await mount(drive, path.join(tmp.dir, 'mnt'), { settleMs: 60_000, shutdownGraceMs: 500 });
    const ops = Fuse.last().ops;
    t.after(async () => {
        await handle.pending.shutdown(handle.shutdownGraceMs);
        await handle.ipc.stop();
        tmp.cleanup();
    });
    return { fake, handle, cacheDir, op: (name, ...args) => callOp(ops[name], ...args) };
}

/** `printf TEXT > PATH` through the mount: create, one write, release. */
export async function writeNew(m: MountedFake, filePath: string, text: string): Promise<void> {
    const [err, fd] = await m.op('create', filePath, 0o644);
    assert.equal(err, 0, `create ${filePath}`);
    const data = Buffer.from(text);
    assert.deepEqual(await m.op('write', filePath, fd, data, data.length, 0), [data.length]);
    assert.deepEqual(await m.op('release', filePath, fd), [0]);
}

export interface StatResult {
    size: number;
    mtime: Date;
    ctime: Date;
}

/** stat() through the mount. */
export async function getattr(m: MountedFake, filePath: string): Promise<StatResult> {
    const [err, st] = await m.op('getattr', filePath);
    assert.equal(err, 0, `getattr ${filePath}`);
    return st as StatResult;
}
