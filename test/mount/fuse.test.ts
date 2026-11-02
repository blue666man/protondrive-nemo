import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { mount, type MountHandle } from '../../src/mount';
import { FakeDrive } from '../fakeDrive';
import { fakeDrive, tempDir } from '../helpers';
import { sleep } from '../support';

// Children and file access under the mount must be asynchronous: this
// process serves the mount, so a synchronous child (spawnSync/execFileSync)
// or a synchronous fs call (statSync/readFileSync) deadlocks on its first access.
const exec = promisify(execFile);

const T1 = new Date('2001-02-03T04:05:06Z');
const T2 = new Date('2002-03-04T05:06:07Z');

let tmp: ReturnType<typeof tempDir>;
let fake: FakeDrive;
let handle: MountHandle;
let mnt: string;

before(async () => {
    tmp = tempDir();
    fake = new FakeDrive();
    mnt = path.join(tmp.dir, 'mnt');
    handle = await mount({ ...fakeDrive(path.join(tmp.dir, 'cache')), sdk: fake.client }, mnt, {
        settleMs: 200,
        shutdownGraceMs: 2000,
    });
});

after(async () => {
    await handle.pending.shutdown(2000);
    await handle.ipc.stop();
    // A failed unmount must not fall through to cleanup(): rmSync would walk
    // into the still-live mount from the thread that serves it and deadlock.
    await new Promise<void>((resolve, reject) =>
        handle.fuse.unmount((err) => (err ? reject(err) : resolve())),
    );
    tmp.cleanup();
});

/** Waits until the children's handles are released, then uploads everything pending. */
async function settled(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (handle.pending.status().open > 0) {
        if (Date.now() > deadline) {
            throw new Error('handles still open');
        }
        await sleep(20);
    }
    const result = await handle.pending.flush();
    assert.equal(result.failed + result.retrying, 0, JSON.stringify(result));
}

/** Local source files: [relative path, content, mtime]. */
function source(name: string, files: Array<[string, string, Date]>): string {
    const dir = path.join(tmp.dir, name);
    for (const [rel, text, time] of files) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), text);
        utimesSync(path.join(dir, rel), time, time);
    }
    return dir;
}

function since(start: number) {
    return fake.uploads.slice(start).map((u) => [u.kind, u.name, u.claimedModificationTime?.toISOString()]);
}

test("the FUSE binding passes utimens' mtime (sagemathinc/fuse-native#3)", async () => {
    const start = fake.uploads.length;
    const f = path.join(mnt, 'binding.txt');
    await exec('sh', ['-c', 'printf x > "$1"', 'sh', f]);
    // One utimensat with distinct times: a binding that hands JS the atime
    // in place of the mtime makes the file report T2.
    await utimes(f, T2, T1);
    assert.equal(
        (await stat(f)).mtime.toISOString(),
        T1.toISOString(),
        'the native binding lacks the fix for https://github.com/sagemathinc/fuse-native/issues/3 ' +
            '(fuse-native.c line 346, utimens: l->atime -> l->mtime); see README, Tests',
    );
    await settled();
    assert.deepEqual(since(start), [['new', 'binding.txt', T1.toISOString()]]);
});

test('rsync -rlt: one upload per file with the source times; a second run uploads nothing', async () => {
    const start = fake.uploads.length;
    const src = source('src1', [
        ['a.txt', 'alpha', T1],
        ['sub/b.txt', 'beta', T2],
    ]);
    const dest = path.join(mnt, 'r1');
    await exec('rsync', ['-rlt', `${src}/`, `${dest}/`]);
    await settled();
    assert.deepEqual(since(start).sort(), [
        ['new', 'a.txt', T1.toISOString()],
        ['new', 'b.txt', T2.toISOString()],
    ]);
    assert.equal((await stat(path.join(dest, 'sub/b.txt'))).mtime.toISOString(), T2.toISOString());

    const before2 = fake.uploads.length;
    const { stdout } = await exec('rsync', ['-rlt', '--itemize-changes', `${src}/`, `${dest}/`]);
    await settled();
    assert.equal(fake.uploads.length, before2, 'the second run uploaded something');
    assert.doesNotMatch(stdout, /^>f/m);
});

test('rsync -a: chmod is refused, so rsync skips every file (exit 23); use rsync -rlt', async () => {
    const start = fake.uploads.length;
    const src = source('src2', [['p.txt', 'private', T1]]);
    chmodSync(path.join(src, 'p.txt'), 0o600);
    const dest = path.join(mnt, 'r2');
    // rsync fchmods its temp file, gets EPERM, then unlinks the temp file
    // and skips the file.
    const err = await exec('rsync', ['-a', `${src}/`, `${dest}/`]).then(
        () => undefined,
        (e: { code?: number; stderr?: string }) => e,
    );
    assert.equal(err?.code, 23);
    assert.match(err?.stderr ?? '', /Operation not permitted/);
    await settled();
    assert.deepEqual(since(start), []);
    assert.ok(!(await readdir(dest)).includes('p.txt'), 'p.txt arrived in the destination');
});

test('cp --preserve=timestamps keeps the time; cp -p too, but reports the refused chmod', async () => {
    const start = fake.uploads.length;
    const src = source('src3', [['c.txt', 'copy', T1]]);
    await exec('cp', ['--preserve=timestamps', path.join(src, 'c.txt'), path.join(mnt, 'cp1.txt')]);
    const err = await exec('cp', ['-p', path.join(src, 'c.txt'), path.join(mnt, 'cp2.txt')]).then(
        () => undefined,
        (e: { code?: number; stderr?: string }) => e,
    );
    assert.equal(err?.code, 1);
    assert.match(err?.stderr ?? '', /preserving permissions/);
    await settled();
    assert.deepEqual(since(start).sort(), [
        ['new', 'cp1.txt', T1.toISOString()],
        ['new', 'cp2.txt', T1.toISOString()],
    ]);
});

test('touch -d on a new file sets its time; touch -a keeps it; touch on an uploaded file is a no-op', async () => {
    const start = fake.uploads.length;
    const f = path.join(mnt, 'touched.txt');
    await exec('sh', ['-c', `printf x > "$1" && touch -d @${T2.getTime() / 1000} "$1" && touch -a "$1"`, 'sh', f]);
    await settled();
    assert.deepEqual(since(start), [['new', 'touched.txt', T2.toISOString()]]);
    await exec('touch', ['-d', `@${T1.getTime() / 1000}`, f]);
    assert.equal((await stat(f)).mtime.toISOString(), T2.toISOString());
    await settled();
    assert.equal(fake.uploads.length, start + 1);
});

test('mv across folders: an uploaded file moves without an upload; a pending one uploads once, at the destination', async () => {
    await exec('sh', ['-c', 'mkdir -p "$1/m1" "$1/m2" && printf u > "$1/m1/up.txt"', 'sh', mnt]);
    await settled();
    const start = fake.uploads.length;
    const uid = fake.find('/m1/up.txt');
    await exec('mv', [path.join(mnt, 'm1/up.txt'), path.join(mnt, 'm2/up.txt')]);
    assert.equal(fake.find('/m2/up.txt'), uid);
    await exec('sh', ['-c', 'printf p > "$1/m1/fresh.txt" && mv "$1/m1/fresh.txt" "$1/m2/fresh.txt"', 'sh', mnt]);
    await settled();
    assert.deepEqual(
        fake.uploads.slice(start).map((u) => [u.parentUid, u.name]),
        [[fake.find('/m2'), 'fresh.txt']],
    );
});

test('editor-style save (temp file renamed over the original) uploads a revision, not a new file', async () => {
    await exec('sh', ['-c', 'printf v1 > "$1/doc.txt"', 'sh', mnt]);
    await settled();
    const uid = fake.find('/doc.txt');
    const start = fake.uploads.length;
    await exec('sh', ['-c', 'printf v2 > "$1/.doc.txt.swp" && mv "$1/.doc.txt.swp" "$1/doc.txt"', 'sh', mnt]);
    await settled();
    assert.deepEqual(fake.uploads.slice(start).map((u) => [u.kind, u.nodeUid]), [['revision', uid]]);
    assert.equal(fake.find('/doc.txt'), uid);
    assert.equal(await readFile(path.join(mnt, 'doc.txt'), 'utf8'), 'v2');
});
