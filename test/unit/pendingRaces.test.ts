/**
 * Uploads the server commits although the client aborted them (FakeDrive's
 * commitDespiteAbort): what landed must not survive under a stale name or
 * be mistaken for someone else's edit.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { closedNewFile, type PendingSetup, setupPending } from '../pendingSetup';
import { waitFor } from '../support';

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
