import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';

import { mount, type MountHandle } from '../../src/mount';
import { FakeDrive } from '../fakeDrive';
import { fakeDrive, tempDir } from '../helpers';

// A daemon killed with SIGKILL leaves its mount behind with no process
// serving it: every access to the mount point fails with ENOTCONN until
// someone runs `fusermount -u`. The next `mount` has to clear it itself.

// Mounts a mount point with nothing in it and reports "ready" once it is up.
const CHILD = `
const Fuse = require(process.argv[1]);
const now = new Date();
const root = { mode: 0o40755, uid: process.getuid(), gid: process.getgid(), size: 0, nlink: 2, mtime: now, atime: now, ctime: now };
const fuse = new Fuse(process.argv[2], {
    getattr: (p, cb) => (p === '/' ? cb(0, root) : cb(Fuse.ENOENT)),
    readdir: (p, cb) => cb(0, []),
}, { mkdir: true });
fuse.mount((err) => {
    if (err) { console.error(err); process.exit(1); }
    console.log('ready');
});
`;

const tmp = tempDir();
let handle: MountHandle | undefined;

after(async () => {
    if (handle) {
        const h = handle;
        await h.pending.shutdown(2000);
        await h.ipc.stop();
        await new Promise<void>((resolve, reject) => h.fuse.unmount((err) => (err ? reject(err) : resolve())));
        await h.releaseLock();
    } else {
        // mount() failed: the dead mount is still there, and rmSync would stop on it.
        spawnSync('fusermount', ['-uz', path.join(tmp.dir, 'mnt')]);
    }
    tmp.cleanup();
});

/** Mounts `mnt` from a child process, then kills the child with SIGKILL. */
async function leaveDeadMount(mnt: string): Promise<void> {
    const child = spawn(process.execPath, ['-e', CHILD, require.resolve('@cocalc/fuse-native'), mnt], {
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve, reject) => {
        child.once('exit', (code) => reject(new Error(`mount child exited with ${code}`)));
        child.stdout.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('ready')) {
                resolve();
            }
        });
    });
    child.removeAllListeners('exit');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
}

test('mount clears a mount left behind by a daemon killed with SIGKILL', async () => {
    const mnt = path.join(tmp.dir, 'mnt');
    await leaveDeadMount(mnt);
    await assert.rejects(stat(mnt), { code: 'ENOTCONN' }, 'precondition: the mount point is a dead mount');

    const fake = new FakeDrive();
    handle = await mount({ ...fakeDrive(path.join(tmp.dir, 'cache')), sdk: fake.client }, mnt, {
        settleMs: 200,
        shutdownGraceMs: 2000,
    });

    assert.deepEqual(await readdir(mnt), []);
});
