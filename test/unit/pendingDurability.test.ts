import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { closedNewFile, type PendingSetup, setupPending } from '../pendingSetup';
import { sleep, waitFor } from '../support';

const T1 = new Date('2001-02-03T04:05:06Z');

function records(s: PendingSetup): string[] {
    return readdirSync(path.join(s.dir, 'pending')).filter((name) => name.endsWith('.json'));
}

test('a closed file is journaled; after a crash the next mount uploads it with its time', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/a.txt', 'hello', T1);
    await waitFor(() => records(s).length === 1, 3000, 'the journal record');
    // Crash: the first instance is simply abandoned.
    const next = await s.restart();
    await waitFor(() => s.fake.uploads.length === 1, 3000, 'the replayed upload');
    assert.equal(s.fake.uploads[0].name, 'a.txt');
    assert.equal(s.fake.uploads[0].claimedModificationTime?.toISOString(), T1.toISOString());
    await waitFor(() => !next.has('/a.txt') && records(s).length === 0, 3000, 'the entry to finish');
});

test('the next mount drops content without a record, and keeps failed entries failed', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const dir = path.join(s.dir, 'pending');
    writeFileSync(path.join(dir, 'orphan.blob'), 'never closed');
    writeFileSync(path.join(dir, 'f1.blob'), 'q');
    writeFileSync(
        path.join(dir, 'f1.json'),
        JSON.stringify({
            id: 'f1',
            kind: 'new',
            path: '/q.txt',
            parentUid: s.fake.rootUid,
            name: 'q.txt',
            claimedMtime: T1.getTime(),
            attempts: 1,
            state: 'failed',
            error: 'Insufficient quota',
        }),
    );
    const next = await s.restart();
    assert.equal(existsSync(path.join(dir, 'orphan.blob')), false);
    assert.deepEqual(next.status().failures, [{ path: '/q.txt', error: 'Insufficient quota' }]);
    assert.equal(statSync(path.join(dir, 'f1.blob')).mtimeMs, T1.getTime(), 'claimed time restored on the content');
    await sleep(50);
    assert.equal(s.fake.uploads.length, 0);
});

test('shutdown aborts uploads still running after the grace period and journals them', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/big.bin', 'lots', T1);
    const release = s.fake.holdUploads();
    void s.pending.flush();
    await waitFor(() => s.fake.inFlight === 1, 3000, 'the upload to start');
    const started = Date.now();
    assert.equal(await s.pending.shutdown(100), 1);
    assert.ok(Date.now() - started < 1500, `shutdown took ${Date.now() - started} ms`);
    assert.equal(s.fake.uploads.length, 0);
    assert.equal(records(s).length, 1);
    release();
    await s.restart();
    await waitFor(() => s.fake.uploads.length === 1, 3000, 'the upload after restart');
    assert.equal(s.fake.uploads[0].claimedModificationTime?.toISOString(), T1.toISOString());
});

test('an upload that finishes within the grace period is not aborted', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/quick.txt', 'q');
    const release = s.fake.holdUploads();
    void s.pending.flush();
    await waitFor(() => s.fake.inFlight === 1, 3000, 'the upload to start');
    setTimeout(release, 50);
    assert.equal(await s.pending.shutdown(2000), 0);
    assert.equal(s.fake.uploads.length, 1);
    assert.equal(records(s).length, 0);
});

test('shutdown journals files that are still open, and nothing starts after it', async (t) => {
    const s = await setupPending({ settleMs: 20 });
    t.after(s.cleanup);
    await s.pending.createNew('/open.txt', s.fake.rootUid, 'open.txt');
    const closed = await closedNewFile(s, '/closed.txt', 'c');
    assert.equal(await s.pending.shutdown(0), 2);
    assert.equal(records(s).length, 2);
    s.pending.touched(closed);
    await sleep(100);
    assert.equal(s.fake.uploads.length, 0);
});
