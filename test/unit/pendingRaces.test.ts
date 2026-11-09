/**
 * Uploads the server commits although the client aborted them (FakeDrive's
 * commitDespiteAbort): what landed must not survive under a stale name or
 * be mistaken for someone else's edit.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { ServerError } from '@protontech/drive-sdk';

import { closedNewFile, type PendingSetup, setupPending } from '../pendingSetup';
import { sleep, waitFor } from '../support';

/** Holds uploads (committing even if aborted) and starts a flush; resolves once an upload is in flight. */
async function heldFlush(s: PendingSetup) {
    s.fake.commitDespiteAbort = true;
    const release = s.fake.holdUploads();
    const flushed = s.pending.flush();
    await waitFor(() => s.fake.inFlight === 1, 3000, 'the upload to start');
    return { release, flushed };
}

test('a new file renamed while its upload lands anyway: the temp name is trashed, the final name uploads', { timeout: 5000 }, async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/.x.tmp', 'content');
    const { release, flushed } = await heldFlush(s);
    s.pending.move('/.x.tmp', '/x', s.fake.rootUid, 'x');
    release();
    await flushed;
    await s.pending.flush();
    const x = s.fake.find('/x');
    assert.ok(x, 'x exists');
    assert.equal(s.fake.contentOf(x), 'content');
    assert.equal(s.fake.find('/.x.tmp'), undefined, '.x.tmp is trashed');
    assert.ok(s.fake.uploads.every((u) => u.name === '.x.tmp' || u.name === 'x'));
});

test('a new file renamed over a Drive file while its upload lands anyway becomes a revision of that file', { timeout: 5000 }, async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const uid = s.fake.addFile(s.fake.rootUid, 'x', 'old');
    const base = (await s.fake.client.getNode(uid)).activeRevision?.uid;
    await closedNewFile(s, '/.x.tmp', 'mine');
    const { release, flushed } = await heldFlush(s);
    s.pending.move('/.x.tmp', '/x', s.fake.rootUid, 'x', { nodeUid: uid, baseRevisionUid: base });
    release();
    await flushed;
    await s.pending.flush();
    assert.equal(s.fake.find('/x'), uid);
    assert.equal(s.fake.contentOf(uid), 'mine');
    const last = s.fake.uploads.at(-1);
    assert.deepEqual([last?.kind, last?.nodeUid], ['revision', uid]);
    assert.ok(!s.fake.uploads.some((u) => u.name.includes('conflict')), 'no conflict copy');
    assert.equal(s.fake.find('/.x.tmp'), undefined, '.x.tmp is trashed');
});

test('cancel during an upload that lands anyway trashes what landed', { timeout: 5000 }, async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/c.txt', 'c');
    const { release, flushed } = await heldFlush(s);
    const cancelled = s.pending.cancel('/c.txt');
    release();
    assert.equal(await cancelled, undefined);
    await flushed;
    assert.equal(s.fake.uploads.length, 1, 'the upload did land');
    assert.equal(s.fake.find('/c.txt'), undefined, 'and was trashed');
});

test('our own revision that landed despite a cancel is not taken for a remote edit', { timeout: 5000 }, async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const uid = s.fake.addFile(s.fake.rootUid, 'r.txt', 'v1');
    const node = await s.fake.client.getNode(uid);
    await s.content.ensureDownloaded(node);
    const edit = s.pending.beginRevision('/r.txt', node, s.fake.rootUid, 'r.txt', 1);
    await edit.ready;
    await writeFile(edit.localPath, 'v2');
    s.pending.closed(edit);
    const { release, flushed } = await heldFlush(s);
    const base = s.pending.get('/r.txt')?.baseRevisionUid;
    await closedNewFile(s, '/.r.swp', 'v3');
    // An editor saves: its swap file replaces r.txt, whose own upload is still in flight.
    const cancelled = s.pending.cancel('/r.txt');
    s.pending.move('/.r.swp', '/r.txt', s.fake.rootUid, 'r.txt', { nodeUid: uid, baseRevisionUid: base });
    release();
    await cancelled;
    await flushed;
    await s.pending.flush();
    assert.equal(s.fake.contentOf(uid), 'v3');
    assert.ok(!s.fake.uploads.some((u) => u.name.includes('conflict')), 'no conflict copy');
    const last = s.fake.uploads.at(-1);
    assert.deepEqual([last?.kind, last?.nodeUid], ['revision', uid]);
});

test('flush does not wait on a file reopened and changed during its upload', { timeout: 5000 }, async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const entry = await closedNewFile(s, '/e.txt', 'first');
    const release = s.fake.holdUploads();
    const flushed = s.pending.flush();
    await waitFor(() => s.fake.inFlight === 1, 3000, 'the upload to start');
    s.pending.opened(entry);
    await writeFile(entry.localPath, 'second');
    s.pending.touched(entry);
    release();
    assert.deepEqual(await flushed, { uploaded: 0, failed: 0, retrying: 0, open: 1 });
    s.pending.closed(entry);
    assert.equal((await s.pending.flush()).uploaded, 1);
    const last = s.fake.uploads.at(-1);
    assert.equal(s.fake.contentOf(last?.nodeUid as string), 'second');
});

test('a transient failure while the file is open retries after the last close', { timeout: 5000 }, async (t) => {
    const s = await setupPending({ settleMs: 30 });
    t.after(s.cleanup);
    const entry = await closedNewFile(s, '/f.txt', 'f');
    const release = s.fake.holdUploads();
    const flushed = s.pending.flush();
    await waitFor(() => s.fake.inFlight === 1, 3000, 'the upload to start');
    s.pending.opened(entry);
    s.fake.failNextUpload(new ServerError('down'));
    release();
    assert.deepEqual(await flushed, { uploaded: 0, failed: 0, retrying: 1, open: 0 });
    await sleep(100); // past any retry delay (at most 40 ms): no retry while open
    assert.equal(s.fake.uploads.length, 0);
    s.pending.closed(entry);
    await waitFor(() => s.fake.uploads.length === 1, 3000, 'the upload after the close');
});
