import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { mount, type MountHandle } from '../../src/mount';
import { FakeDrive } from '../fakeDrive';
import { callOp, fakeDrive, tempDir } from '../helpers';
import Fuse from '../stubs/fuse-native';

/** A pid that cannot belong to a live process: above Linux's default pid_max (2^22). */
const DEAD_PID = 2 ** 22 + 12345;

/** Field 22 (starttime) of /proc/<pid>/stat, or undefined where /proc is not readable. */
function startTimeOf(pid: number): string | undefined {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } catch {
        return undefined;
    }
}

/** What our own lock file holds. */
const OUR_LOCK = `${process.pid} ${startTimeOf(process.pid) ?? '-'}`;

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
    assert.equal(readFileSync(p.lockFile, 'utf8').trim(), OUR_LOCK);
});

test('after the first mount shuts down and releases its lock, a new mount succeeds', { timeout: 5000 }, async (t) => {
    const p = profile(t);
    const first = await p.mount();
    assert.equal(readFileSync(p.lockFile, 'utf8'), `${OUR_LOCK}\n`, 'the lock holds our pid and start time');
    p.forget(first);
    await shutdown(first);
    assert.equal(existsSync(p.lockFile), false, 'release removed the lock');
    await p.mount();
    assert.equal(existsSync(p.lockFile), true);
});

test('a lock with our own pid that this process does not hold is taken over', { timeout: 5000 }, async (t) => {
    const p = profile(t);
    mkdirSync(p.cacheDir, { recursive: true });
    writeFileSync(p.lockFile, `${OUR_LOCK}\n`); // an earlier life of this pid, e.g. before a restart
    await p.mount();
    assert.equal(readFileSync(p.lockFile, 'utf8'), `${OUR_LOCK}\n`);
});

test('a lock whose pid is alive but started at another time (pid reuse) is taken over', { timeout: 5000 }, async (t) => {
    const start = startTimeOf(1);
    if (start === undefined) {
        t.skip('/proc/1/stat is not readable');
        return;
    }
    const p = profile(t);
    mkdirSync(p.cacheDir, { recursive: true });
    writeFileSync(p.lockFile, `1 ${Number(start) + 1}\n`);
    await p.mount();
    assert.equal(readFileSync(p.lockFile, 'utf8'), `${OUR_LOCK}\n`);
});

test('a lock whose pid is alive with the start time it recorded is refused', { timeout: 5000 }, async (t) => {
    const start = startTimeOf(1);
    if (start === undefined) {
        t.skip('/proc/1/stat is not readable');
        return;
    }
    const p = profile(t);
    mkdirSync(p.cacheDir, { recursive: true });
    writeFileSync(p.lockFile, `1 ${start}\n`);
    await assert.rejects(p.mount(), /already running for this account \(pid 1\)/);
    assert.equal(readFileSync(p.lockFile, 'utf8'), `1 ${start}\n`, 'the lock is left alone');
});

test('an empty lock is refused while it is fresh (being written), taken over once old', { timeout: 5000 }, async (t) => {
    const p = profile(t);
    mkdirSync(p.cacheDir, { recursive: true });
    writeFileSync(p.lockFile, '');
    await assert.rejects(p.mount(), /already running for this account/);
    assert.equal(readFileSync(p.lockFile, 'utf8'), '', 'the lock is left alone');
    const old = new Date(Date.now() - 60_000);
    utimesSync(p.lockFile, old, old);
    await p.mount();
    assert.equal(readFileSync(p.lockFile, 'utf8'), `${OUR_LOCK}\n`);
});

test('the lock is written whole, through a temp file that does not stay behind', { timeout: 5000 }, async (t) => {
    const p = profile(t);
    await p.mount();
    assert.equal(readFileSync(p.lockFile, 'utf8'), `${OUR_LOCK}\n`);
    assert.deepEqual(
        readdirSync(p.cacheDir).filter((name) => name.startsWith('daemon.lock')),
        ['daemon.lock'],
    );
});
