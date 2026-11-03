import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { mount, type MountHandle } from '../../src/mount';
import { FakeDrive } from '../fakeDrive';
import { callOp, fakeDrive, tempDir } from '../helpers';
import Fuse from '../stubs/fuse-native';

/** A pid that cannot belong to a live process: above Linux's default pid_max (2^22). */
const DEAD_PID = 2 ** 22 + 12345;

/** Shuts a mount down as SIGTERM would, and releases its lock. */
async function shutdown(handle: MountHandle): Promise<void> {
    try {
        await handle.pending.shutdown(handle.shutdownGraceMs);
    } finally {
        await handle.ipc.stop();
    }
    await handle.releaseLock();
}

/** A cache dir and a mount() over one FakeDrive on it; every handle mounted is shut down when the test ends. */
function profile(t: TestContext) {
    const tmp = tempDir();
    const cacheDir = path.join(tmp.dir, 'cache');
    const fake = new FakeDrive();
    const handles: MountHandle[] = [];
    t.after(async () => {
        // Every handle, even if one fails: a server left listening keeps the test process alive.
        const results = await Promise.allSettled(handles.map(shutdown));
        tmp.cleanup();
        for (const result of results) {
            if (result.status === 'rejected') {
                throw result.reason;
            }
        }
    });
    return {
        cacheDir,
        lockFile: path.join(cacheDir, 'daemon.lock'),
        async mount(): Promise<MountHandle> {
            Fuse.reset();
            const handle = await mount({ ...fakeDrive(cacheDir), sdk: fake.client }, path.join(tmp.dir, 'mnt'), {
                settleMs: 60_000,
                shutdownGraceMs: 500,
            });
            handles.push(handle);
            return handle;
        },
        forget(handle: MountHandle): void {
            handles.splice(handles.indexOf(handle), 1);
        },
    };
}

test('a second mount on the same account is refused and leaves the first one alone', { timeout: 5000 }, async (t) => {
    const p = profile(t);
    await p.mount();
    const ops = Fuse.last().ops;
    const [err] = await callOp(ops.create, '/open.txt', 0o644);
    assert.equal(err, 0);
    const pendingDir = path.join(p.cacheDir, 'pending');
    const blobs = () => readdirSync(pendingDir).filter((name) => name.endsWith('.blob'));
    assert.equal(blobs().length, 1, 'the open file has its content in the pending dir');

    await assert.rejects(p.mount(), /already running for this account \(pid \d+\)/);
    assert.equal(blobs().length, 1, "the first mount's open file still has its content");
});

test('a lock left by a process that is gone is taken over', { timeout: 5000 }, async (t) => {
    try {
        process.kill(DEAD_PID, 0);
        t.skip(`pid ${DEAD_PID} exists on this machine`);
        return;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
            t.skip(`pid ${DEAD_PID} is not known to be dead: ${(err as Error).message}`);
            return;
        }
    }
    const p = profile(t);
    mkdirSync(p.cacheDir, { recursive: true });
    writeFileSync(p.lockFile, `${DEAD_PID}\n`);
    await p.mount();
    assert.equal(readFileSync(p.lockFile, 'utf8').trim(), String(process.pid));
});

test('after the first mount shuts down and releases its lock, a new mount succeeds', { timeout: 5000 }, async (t) => {
    const p = profile(t);
    const first = await p.mount();
    assert.equal(readFileSync(p.lockFile, 'utf8').trim(), String(process.pid), 'the lock holds our pid');
    p.forget(first);
    await shutdown(first);
    assert.equal(existsSync(p.lockFile), false, 'release removed the lock');
    await p.mount();
    assert.equal(existsSync(p.lockFile), true);
});
