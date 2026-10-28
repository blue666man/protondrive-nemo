import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import type { NodeEntity } from '@protontech/drive-sdk';

import { createCachePolicy } from '../../src/cachePolicy';
import { ContentStore } from '../../src/contentStore';
import { DriveTree, NodeNotFoundError } from '../../src/driveTree';
import { createFuseOperations } from '../../src/fuseOps';
import { mount } from '../../src/mount';
import { getConfig } from '../../src/sdk-bootstrap/config';
import Fuse from '../stubs/fuse-native';
import { callOp, downloadingSdk, fakeDrive, fileNode, silentLogger, tempDir } from '../helpers';

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

/** A DriveTree that knows exactly `files`, all directly under one root folder. */
function fakeTree(files: Record<string, NodeEntity>): DriveTree {
    return {
        resolve: async (p: string) => {
            const node = files[p];
            if (!node) {
                throw new NodeNotFoundError(p);
            }
            return node;
        },
        resolveParent: async (p: string) => ({ parent: { uid: 'root' }, name: path.posix.basename(p) }),
        invalidate() {},
        rememberNode() {},
        forgetNode() {},
    } as unknown as DriveTree;
}

function setup(cachePaths: string[], ephemeralCache = false) {
    const files = { '/Docs/a.txt': fileNode('node-a', 5), '/Other/b.txt': fileNode('node-b', 5) };
    const content = new ContentStore(downloadingSdk('hello'), tmp.dir, silentLogger);
    const policy = createCachePolicy({ cachePaths, ephemeralCache });
    const { ops } = createFuseOperations(downloadingSdk('hello'), fakeTree(files), content, policy, silentLogger);
    const blob = (dir: 'blobs' | 'tmp', uid: string) => path.join(tmp.dir, dir, encodeURIComponent(uid));
    return { ops, blob };
}

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

test('an allowlisted file is cached in blobs/ and kept after close', async () => {
    const { ops, blob } = setup(['/Docs']);
    const [err, fd] = await callOp(ops.open, '/Docs/a.txt', 0);
    assert.equal(err, 0);
    assert.ok(existsSync(blob('blobs', 'node-a')));

    assert.deepEqual(await callOp(ops.release, '/Docs/a.txt', fd), [0]);
    assert.ok(existsSync(blob('blobs', 'node-a')));
});

test('a file outside the allowlist uses tmp/ and is removed when its last handle closes', async () => {
    const { ops, blob } = setup(['/Docs']);
    const [, fd1] = await callOp(ops.open, '/Other/b.txt', 0);
    const [, fd2] = await callOp(ops.open, '/Other/b.txt', 0);
    assert.ok(existsSync(blob('tmp', 'node-b')));
    assert.ok(!existsSync(blob('blobs', 'node-b')));

    await callOp(ops.release, '/Other/b.txt', fd1);
    assert.ok(existsSync(blob('tmp', 'node-b')), 'still open through fd2');

    await callOp(ops.release, '/Other/b.txt', fd2);
    assert.ok(!existsSync(blob('tmp', 'node-b')));
});

test('ephemeral mode keeps no file after close, allowlisted or not', async () => {
    const { ops, blob } = setup(['/Docs'], true);
    const [, fd] = await callOp(ops.open, '/Docs/a.txt', 0);
    await callOp(ops.release, '/Docs/a.txt', fd);
    assert.ok(!existsSync(blob('blobs', 'node-a')));
    assert.ok(!existsSync(blob('tmp', 'node-a')));
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
