import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';

import { createCachePolicy } from '../../src/cachePolicy';
import { ContentStore } from '../../src/contentStore';
import { mount } from '../../src/mount';
import { guardedShutdown, unmountStep } from '../../src/shutdown';
import { getConfig } from '../../src/sdk-bootstrap/config';
import Fuse from '../stubs/fuse-native';
import { callOp, downloadingSdk, fakeDrive, fileNode, silentLogger, tempDir } from '../helpers';
import { FakeDrive } from '../fakeDrive';
import { mountFake, writeNew } from '../mountFake';
import { setupPending } from '../pendingSetup';
import { waitFor } from '../support';

const ENV_PATHS = 'PROTONDRIVE_NEMO_CACHE_PATHS';
const ENV_EPHEMERAL = 'PROTONDRIVE_NEMO_EPHEMERAL_CACHE';

let tmp: ReturnType<typeof tempDir>;

beforeEach(() => {
    tmp = tempDir();
    Fuse.reset();
});

afterEach(() => {
    delete process.env[ENV_PATHS];
    delete process.env[ENV_EPHEMERAL];
    tmp.cleanup();
});

test('getConfig reads the cache allowlist and ephemeral flag from the environment', () => {
    const base = { appVersion: 'test', clientUidPrefix: 'test' };
    assert.deepEqual(getConfig(base).cachePaths, []);
    assert.equal(getConfig(base).ephemeralCache, false);

    process.env[ENV_PATHS] = '/Docs, /Photos:/Music';
    assert.deepEqual(getConfig(base).cachePaths, ['/Docs', '/Photos', '/Music']);

    for (const on of ['1', 'true', 'YES', ' on ']) {
        process.env[ENV_EPHEMERAL] = on;
        assert.equal(getConfig(base).ephemeralCache, true, on);
    }
    for (const off of ['0', '', 'false']) {
        process.env[ENV_EPHEMERAL] = off;
        assert.equal(getConfig(base).ephemeralCache, false, off);
    }

    assert.deepEqual(getConfig({ ...base, cachePaths: ['/X'], ephemeralCache: true }).cachePaths, ['/X']);
});

test('ContentStore.wipe removes blobs/ and tmp/', async () => {
    const content = new ContentStore(downloadingSdk('hello'), tmp.dir, silentLogger);
    await content.ensureDownloaded(fileNode('n1', 5));
    await content.ensureDownloaded(fileNode('n2', 5), { ephemeral: true });
    await content.wipe();
    assert.ok(!existsSync(path.join(tmp.dir, 'blobs')));
    assert.ok(!existsSync(path.join(tmp.dir, 'tmp')));
});

test('in ephemeral mode mount() wipes leftovers at start and cleanup() wipes again', async () => {
    const cacheDir = path.join(tmp.dir, 'cache');
    mkdirSync(path.join(cacheDir, 'blobs'), { recursive: true });
    writeFileSync(path.join(cacheDir, 'blobs', 'left-by-a-crash'), 'plaintext');

    const handle = await mount(fakeDrive(cacheDir, { ephemeralCache: true }), path.join(tmp.dir, 'mnt'));
    try {
        assert.ok(!existsSync(path.join(cacheDir, 'blobs')));
        mkdirSync(path.join(cacheDir, 'tmp'));
        writeFileSync(path.join(cacheDir, 'tmp', 'still-here'), 'plaintext');
        await handle.cleanup();
        assert.ok(!existsSync(path.join(cacheDir, 'tmp')));
    } finally {
        await handle.ipc.stop();
    }
});

test('without ephemeral mode, mount() keeps the blob cache', async () => {
    const cacheDir = path.join(tmp.dir, 'cache');
    mkdirSync(path.join(cacheDir, 'blobs'), { recursive: true });
    writeFileSync(path.join(cacheDir, 'blobs', 'kept'), 'x');

    const handle = await mount(fakeDrive(cacheDir), path.join(tmp.dir, 'mnt'));
    try {
        await handle.cleanup();
        assert.ok(existsSync(path.join(cacheDir, 'blobs', 'kept')));
    } finally {
        await handle.ipc.stop();
    }
});

/**
 * The pending harness over a FakeDrive holding `/Docs/a.txt` and
 * `/Other/b.txt` ("hello" each), with allowlist `cachePaths`.
 */
async function cacheSetup(t: TestContext, cachePaths: string[], ephemeralCache = false) {
    const s = await setupPending({ policy: createCachePolicy({ cachePaths, ephemeralCache }) });
    t.after(s.cleanup);
    const a = s.fake.addFile(s.fake.addFolder(s.fake.rootUid, 'Docs'), 'a.txt', 'hello');
    const b = s.fake.addFile(s.fake.addFolder(s.fake.rootUid, 'Other'), 'b.txt', 'hello');
    const op = (name: string, ...args: unknown[]) => callOp(s.ops[name as keyof typeof s.ops] as never, ...args);
    /** Where `uid`'s copy would be in the persistent (`blobs`) or throwaway (`tmp`) cache. */
    const blob = (dir: 'blobs' | 'tmp', uid: string) => path.join(s.dir, dir, encodeURIComponent(uid));
    /** Content files in the pending dir. */
    const pendingBlobs = () => readdirSync(path.join(s.dir, 'pending')).filter((name) => name.endsWith('.blob'));
    /** open, one write of `text` at offset 0, release. */
    const overwrite = async (filePath: string, text: string) => {
        const [err, fd] = await op('open', filePath, 0);
        assert.equal(err, 0, `open ${filePath}`);
        const data = Buffer.from(text);
        assert.deepEqual(await op('write', filePath, fd, data, data.length, 0), [data.length]);
        assert.deepEqual(await op('release', filePath, fd), [0]);
    };
    /** create, one write of `text`, release. */
    const createWith = async (filePath: string, text: string) => {
        const [err, fd] = await op('create', filePath, 0o644);
        assert.equal(err, 0, `create ${filePath}`);
        const data = Buffer.from(text);
        assert.deepEqual(await op('write', filePath, fd, data, data.length, 0), [data.length]);
        assert.deepEqual(await op('release', filePath, fd), [0]);
    };
    return { ...s, a, b, op, blob, pendingBlobs, overwrite, createWith };
}

test('an allowlisted Drive file is cached in blobs/ and kept after close', async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    const [err, fd] = await c.op('open', '/Docs/a.txt', 0);
    assert.equal(err, 0);
    assert.ok(existsSync(c.blob('blobs', c.a)));
    assert.deepEqual(await c.op('release', '/Docs/a.txt', fd), [0]);
    assert.ok(existsSync(c.blob('blobs', c.a)));
    assert.ok(!existsSync(c.blob('tmp', c.a)));
});

test('a Drive file outside the allowlist uses tmp/ and is removed when its last handle closes', async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    const [, fd1] = await c.op('open', '/Other/b.txt', 0);
    const [, fd2] = await c.op('open', '/Other/b.txt', 0);
    assert.ok(existsSync(c.blob('tmp', c.b)));
    assert.ok(!existsSync(c.blob('blobs', c.b)));

    assert.deepEqual(await c.op('release', '/Other/b.txt', fd1), [0]);
    assert.ok(existsSync(c.blob('tmp', c.b)), 'still open through fd2');

    assert.deepEqual(await c.op('release', '/Other/b.txt', fd2), [0]);
    assert.ok(!existsSync(c.blob('tmp', c.b)));
    assert.ok(!existsSync(c.blob('blobs', c.b)));
});

test('ephemeral mode keeps no file after close, allowlisted or not', async (t) => {
    const c = await cacheSetup(t, ['/Docs'], true);
    for (const [filePath, uid] of [['/Docs/a.txt', c.a], ['/Other/b.txt', c.b]]) {
        const [err, fd] = await c.op('open', filePath, 0);
        assert.equal(err, 0, filePath);
        assert.deepEqual(await c.op('release', filePath, fd), [0]);
        assert.ok(!existsSync(c.blob('blobs', uid)), filePath);
        assert.ok(!existsSync(c.blob('tmp', uid)), filePath);
    }
});

test('a write to a Drive file outside the allowlist is uploaded, then not kept', async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    await c.overwrite('/Other/b.txt', 'HELLO');
    assert.equal((await c.pending.flush()).uploaded, 1);
    assert.equal(c.fake.contentOf(c.b), 'HELLO');
    assert.ok(!existsSync(c.blob('blobs', c.b)));
    assert.ok(!existsSync(c.blob('tmp', c.b)));
    assert.deepEqual(c.pendingBlobs(), []);
});

test('a write to an allowlisted Drive file is uploaded and kept in blobs/', async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    await c.overwrite('/Docs/a.txt', 'HELLO');
    assert.equal((await c.pending.flush()).uploaded, 1);
    assert.equal(c.fake.contentOf(c.a), 'HELLO');
    assert.equal(readFileSync(c.blob('blobs', c.a), 'utf8'), 'HELLO');
    assert.deepEqual(c.pendingBlobs(), []);
});

test('a new file outside the allowlist is uploaded, then not kept', async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    await c.createWith('/Other/new.txt', 'fresh');
    assert.equal((await c.pending.flush()).uploaded, 1);
    const uid = c.fake.find('/Other/new.txt');
    assert.ok(uid);
    assert.equal(c.fake.contentOf(uid), 'fresh');
    assert.ok(!existsSync(c.blob('blobs', uid)));
    assert.ok(!existsSync(c.blob('tmp', uid)));
    assert.deepEqual(c.pendingBlobs(), []);
});

test('a new allowlisted file is uploaded and kept in blobs/', async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    await c.createWith('/Docs/new.txt', 'fresh');
    assert.equal((await c.pending.flush()).uploaded, 1);
    const uid = c.fake.find('/Docs/new.txt');
    assert.ok(uid);
    assert.equal(readFileSync(c.blob('blobs', uid), 'utf8'), 'fresh');
    assert.deepEqual(c.pendingBlobs(), []);
});

test('truncate without a handle on a Drive file outside the allowlist uploads, then keeps no copy', async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    assert.deepEqual(await c.op('truncate', '/Other/b.txt', 0), [0]);
    // Downloaded to tmp/, not blobs/ (whose directory nothing else here creates).
    assert.ok(!existsSync(path.join(c.dir, 'blobs')));
    assert.equal((await c.pending.flush()).uploaded, 1);
    assert.equal(c.fake.contentOf(c.b), '');
    assert.ok(!existsSync(c.blob('blobs', c.b)));
    assert.ok(!existsSync(c.blob('tmp', c.b)));
    assert.deepEqual(c.pendingBlobs(), []);
});

test('a file outside the allowlist still open when its upload lands keeps a tmp/ copy until closed', { timeout: 5000 }, async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    await c.createWith('/Other/new.txt', 'one');
    const release = c.fake.holdUploads();
    const flushed = c.pending.flush();
    await waitFor(() => c.fake.inFlight === 1, 3000, 'the upload to start');
    const [err, fd] = await c.op('open', '/Other/new.txt', 0);
    assert.equal(err, 0);
    release();
    assert.equal((await flushed).uploaded, 1);
    const uid = c.fake.find('/Other/new.txt');
    assert.ok(uid);
    assert.ok(!existsSync(c.blob('blobs', uid)));
    assert.ok(existsSync(c.blob('tmp', uid)), 'the open handle still has it');

    // A write through that handle is a revision of the uploaded file, not lost.
    const data = Buffer.from('two');
    assert.deepEqual(await c.op('write', '/Other/new.txt', fd, data, data.length, 0), [data.length]);
    assert.deepEqual(await c.op('release', '/Other/new.txt', fd), [0]);
    assert.equal((await c.pending.flush()).uploaded, 1);
    assert.equal(c.fake.contentOf(uid), 'two');
    assert.ok(!existsSync(c.blob('blobs', uid)));
    assert.ok(!existsSync(c.blob('tmp', uid)));
    assert.deepEqual(c.pendingBlobs(), []);
});

test('a read-only handle outside the allowlist, open when the upload lands, drops the tmp/ copy on close', { timeout: 5000 }, async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    await c.createWith('/Other/new.txt', 'one');
    const release = c.fake.holdUploads();
    const flushed = c.pending.flush();
    await waitFor(() => c.fake.inFlight === 1, 3000, 'the upload to start');
    const [, fd] = await c.op('open', '/Other/new.txt', 0);
    release();
    assert.equal((await flushed).uploaded, 1);
    const uid = c.fake.find('/Other/new.txt') as string;
    const buf = Buffer.alloc(3);
    assert.deepEqual(await c.op('read', '/Other/new.txt', fd, buf, 3, 0), [3]);
    assert.equal(buf.toString(), 'one');
    assert.deepEqual(await c.op('release', '/Other/new.txt', fd), [0]);
    assert.ok(!existsSync(c.blob('tmp', uid)));
    assert.ok(!existsSync(c.blob('blobs', uid)));
});

test('a read-only handle outside the allowlist, open when a revision lands, drops the tmp/ copy on close', { timeout: 5000 }, async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    await c.overwrite('/Other/b.txt', 'HELLO');
    const release = c.fake.holdUploads();
    const flushed = c.pending.flush();
    await waitFor(() => c.fake.inFlight === 1, 3000, 'the upload to start');
    const [err, fd] = await c.op('open', '/Other/b.txt', 0);
    assert.equal(err, 0);
    release();
    assert.equal((await flushed).uploaded, 1);
    assert.equal(c.fake.contentOf(c.b), 'HELLO');
    assert.ok(existsSync(c.blob('tmp', c.b)), 'the open handle still has it');
    const buf = Buffer.alloc(5);
    assert.deepEqual(await c.op('read', '/Other/b.txt', fd, buf, 5, 0), [5]);
    assert.equal(buf.toString(), 'HELLO');
    assert.deepEqual(await c.op('release', '/Other/b.txt', fd), [0]);
    assert.ok(!existsSync(c.blob('tmp', c.b)));
    assert.ok(!existsSync(c.blob('blobs', c.b)));
});

test('outside ephemeral mode, a file open as its upload lands during shutdown keeps its tmp/ copy', { timeout: 5000 }, async (t) => {
    const c = await cacheSetup(t, ['/Docs']);
    await c.overwrite('/Other/b.txt', 'HELLO');
    const release = c.fake.holdUploads();
    const flushed = c.pending.flush();
    await waitFor(() => c.fake.inFlight === 1, 3000, 'the upload to start');
    const [, fd] = await c.op('open', '/Other/b.txt', 0);
    // The upload lands during the drain.
    const stopped = c.pending.shutdown(2000);
    release();
    await flushed;
    await stopped;
    assert.equal(c.fake.contentOf(c.b), 'HELLO');
    assert.ok(existsSync(c.blob('tmp', c.b)), 'the open handle still has it');

    // The mount is still live until unmounted: a write through the handle is not lost.
    const data = Buffer.from('again');
    assert.deepEqual(await c.op('write', '/Other/b.txt', fd, data, data.length, 0), [data.length]);
    const entry = c.pending.get('/Other/b.txt');
    assert.ok(entry);
    await entry.ready;
    assert.equal(readFileSync(entry.localPath, 'utf8'), 'again');
    assert.deepEqual(await c.op('release', '/Other/b.txt', fd), [0]);
});

test('with an allowlist, mount() clears tmp/ at start and in cleanup(), and keeps blobs/', async (t) => {
    const m = await mountFake(
        t,
        undefined,
        (cacheDir) => {
            mkdirSync(path.join(cacheDir, 'tmp'), { recursive: true });
            writeFileSync(path.join(cacheDir, 'tmp', 'x'), 'left by a crash');
            mkdirSync(path.join(cacheDir, 'blobs'), { recursive: true });
            writeFileSync(path.join(cacheDir, 'blobs', 'y'), 'cached');
        },
        { cachePaths: ['/Docs'] },
    );
    assert.ok(!existsSync(path.join(m.cacheDir, 'tmp', 'x')));
    assert.ok(existsSync(path.join(m.cacheDir, 'blobs', 'y')));
    mkdirSync(path.join(m.cacheDir, 'tmp'), { recursive: true });
    writeFileSync(path.join(m.cacheDir, 'tmp', 'z'), 'open copy');
    await m.handle.cleanup();
    assert.ok(!existsSync(path.join(m.cacheDir, 'tmp')));
    assert.ok(existsSync(path.join(m.cacheDir, 'blobs', 'y')));
});

test('with an allowlist, a second mount refused by the lock leaves tmp/ alone', { timeout: 5000 }, async (t) => {
    const m = await mountFake(t, undefined, undefined, { cachePaths: ['/Docs'] });
    mkdirSync(path.join(m.cacheDir, 'tmp'), { recursive: true });
    writeFileSync(path.join(m.cacheDir, 'tmp', 'x'), 'open in mount #1');
    const other = tempDir();
    t.after(other.cleanup);
    Fuse.reset();
    await assert.rejects(
        mount({ ...fakeDrive(m.cacheDir, { cachePaths: ['/Docs'] }), sdk: m.fake.client }, path.join(other.dir, 'mnt'), {
            settleMs: 60_000,
        }),
        /already running for this account/,
    );
    assert.ok(existsSync(path.join(m.cacheDir, 'tmp', 'x')));
});

test('mount() applies the cache policy to uploads', async (t) => {
    const fake = new FakeDrive();
    fake.addFolder(fake.rootUid, 'Other');
    const m = await mountFake(t, fake, undefined, { cachePaths: ['/Docs'] });
    await writeNew(m, '/Other/n.txt', 'not kept');
    assert.equal((await m.handle.pending.flush()).uploaded, 1);
    const uid = fake.find('/Other/n.txt');
    assert.ok(uid);
    assert.ok(!existsSync(path.join(m.cacheDir, 'blobs', encodeURIComponent(uid))));
});

test('the ephemeral wipe runs under the instance lock and leaves pending/ alone', { timeout: 5000 }, async (t) => {
    const m = await mountFake(t, undefined, undefined, { ephemeralCache: true });
    // A change waiting to upload (settle window 60 s): its content is in pending/.
    await writeNew(m, '/keep.txt', 'keep');
    const pendingDir = path.join(m.cacheDir, 'pending');
    mkdirSync(path.join(m.cacheDir, 'tmp'), { recursive: true });
    writeFileSync(path.join(m.cacheDir, 'tmp', 'x'), 'open in mount #1');

    // A second daemon on the same cache dir is refused before it wipes anything.
    const other = tempDir();
    t.after(other.cleanup);
    Fuse.reset();
    await assert.rejects(
        mount({ ...fakeDrive(m.cacheDir, { ephemeralCache: true }), sdk: m.fake.client }, path.join(other.dir, 'mnt'), {
            settleMs: 60_000,
        }),
        /already running for this account/,
    );
    assert.ok(existsSync(path.join(m.cacheDir, 'tmp', 'x')));

    // Mount #1 shuts down as the daemon does: the wipe comes after unmounting.
    const h = m.handle;
    const shutdown = guardedShutdown({
        drain: () => h.pending.shutdown(h.shutdownGraceMs),
        steps: [
            ['stop the control socket', () => h.ipc.stop()],
            [
                'unmount',
                unmountStep(() => new Promise<void>((resolve, reject) => h.fuse.unmount((err) => (err ? reject(err) : resolve())))),
            ],
            ['wipe the throwaway content cache', h.cleanup],
            ['release the instance lock', h.releaseLock],
        ],
        log: () => {},
    });
    assert.equal(await shutdown('SIGTERM').done, 0);
    assert.ok(!existsSync(path.join(m.cacheDir, 'tmp')));
    assert.ok(!existsSync(path.join(m.cacheDir, 'blobs')));
    // The change is still journalled, content and record, for the next mount.
    const left = readdirSync(pendingDir).sort();
    assert.equal(left.length, 2, left.join(', '));
    const [blobName, recordName] = left;
    assert.ok(blobName.endsWith('.blob') && recordName === blobName.replace(/\.blob$/, '.json'), left.join(', '));
    assert.equal(readFileSync(path.join(pendingDir, blobName), 'utf8'), 'keep');
});
