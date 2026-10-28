import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeEntity } from '@protontech/drive-sdk';

import { createCachePolicy } from '../../src/cachePolicy';
import { ContentStore } from '../../src/contentStore';
import { DriveTree, NodeNotFoundError } from '../../src/driveTree';
import { createFuseOperations } from '../../src/fuseOps';
import { errno } from '../stubs/fuse-native';
import { callOp, fileNode, silentLogger } from '../helpers';

function ops() {
    const files: Record<string, NodeEntity> = { '/a.txt': fileNode('node-a', 1) };
    const tree = {
        resolve: async (p: string) => {
            if (!files[p]) {
                throw new NodeNotFoundError(p);
            }
            return files[p];
        },
    } as unknown as DriveTree;
    const content = new ContentStore({} as never, '/nonexistent', silentLogger);
    const policy = createCachePolicy({ cachePaths: [], ephemeralCache: false });
    return createFuseOperations({} as never, tree, content, policy, silentLogger).ops;
}

test('access succeeds on root and existing paths, ENOENT otherwise', async () => {
    const o = ops();
    assert.deepEqual(await callOp(o.access, '/', 0), [0]);
    assert.deepEqual(await callOp(o.access, '/a.txt', 0), [0]);
    assert.deepEqual(await callOp(o.access, '/missing', 0), [errno('ENOENT')]);
});

test('flush, fsync and fsyncdir succeed (content is uploaded on release)', async () => {
    const o = ops();
    assert.deepEqual(await callOp(o.flush, '/a.txt', 1000), [0]);
    assert.deepEqual(await callOp(o.fsync, '/a.txt', false, 1000), [0]);
    assert.deepEqual(await callOp(o.fsyncdir, '/', false, 1000), [0]);
});

test('statfs reports 4 KiB blocks and 255-byte names', async () => {
    const [err, st] = (await callOp(ops().statfs, '/')) as [number, { bsize: number; namemax: number }];
    assert.equal(err, 0);
    assert.equal(st.bsize, 4096);
    assert.equal(st.namemax, 255);
});

test('xattrs: none to read; no setxattr/removexattr, so writes get EOPNOTSUPP', async () => {
    const o = ops();
    assert.deepEqual(await callOp(o.getxattr, '/a.txt', 'user.x', 0), [errno('ENODATA')]);
    assert.deepEqual(await callOp(o.listxattr, '/a.txt'), [0, []]);
    assert.equal(o.setxattr, undefined);
    assert.equal(o.removexattr, undefined);
});

test('chmod, chown and utimens are not ported as no-ops', () => {
    const o = ops();
    assert.equal(o.chmod, undefined);
    assert.equal(o.chown, undefined);
    assert.equal(o.utimens, undefined);
});
