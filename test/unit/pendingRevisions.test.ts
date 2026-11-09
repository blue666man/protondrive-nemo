import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { NodeWithSameNameExistsValidationError, ServerError, ValidationError } from '@protontech/drive-sdk';

import { CONFLICT_STAMP, closedNewFile, type PendingSetup, setupPending } from '../pendingSetup';
import { waitFor } from '../support';

/** A Drive file `name` holding `text`, opened (cached) and rewritten locally to `mine`; one handle still open. */
async function editedFile(s: PendingSetup, name: string, text: string, mine: string) {
    const uid = s.fake.addFile(s.fake.rootUid, name, text);
    const node = await s.fake.client.getNode(uid);
    const cached = await s.content.ensureDownloaded(node);
    const entry = s.pending.beginRevision(`/${name}`, node, s.fake.rootUid, name, 1, cached);
    await entry.ready;
    assert.equal(existsSync(cached), false, 'the cached copy moved into the pending dir');
    await writeFile(entry.localPath, mine);
    return { uid, entry };
}

test('a changed Drive file uploads as a new revision of the same node', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const { uid, entry } = await editedFile(s, 'r.txt', 'old', 'new');
    s.pending.closed(entry);
    assert.equal((await s.pending.flush()).uploaded, 1);
    assert.deepEqual(s.fake.uploads.map((u) => [u.kind, u.nodeUid]), [['revision', uid]]);
    assert.equal(s.fake.contentOf(uid), 'new');
    assert.equal(readFileSync(s.content.localPathFor(uid), 'utf8'), 'new', 'the upload is the cached copy again');
});

test('if the file changed on Drive meanwhile, ours becomes a conflict copy and theirs stays', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const { uid, entry } = await editedFile(s, 'r.txt', 'old', 'mine');
    s.fake.remoteEdit(uid, 'theirs');
    s.pending.closed(entry);
    await s.pending.flush();
    assert.equal(s.fake.contentOf(uid), 'theirs');
    const copy = s.fake.find(`/r (conflict ${CONFLICT_STAMP}).txt`);
    assert.ok(copy, 'the conflict copy exists');
    assert.equal(s.fake.contentOf(copy), 'mine');
});

test('a remote revision with our content counts as already uploaded', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const { uid, entry } = await editedFile(s, 'r.txt', 'old', 'same');
    s.fake.remoteEdit(uid, 'same');
    s.pending.closed(entry);
    assert.equal((await s.pending.flush()).uploaded, 1);
    assert.equal(s.fake.uploads.length, 0);
    assert.equal(s.pending.has('/r.txt'), false);
});

test('a new file whose name appeared on Drive meanwhile becomes a conflict copy', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/n.txt', 'mine');
    const theirs = s.fake.addFile(s.fake.rootUid, 'n.txt', 'theirs');
    await s.pending.flush();
    assert.equal(s.fake.contentOf(theirs), 'theirs');
    assert.deepEqual(s.fake.uploads.map((u) => u.name), [`n (conflict ${CONFLICT_STAMP}).txt`]);
});

test('a new file already on Drive with the same content is not uploaded twice', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/n.txt', 'same');
    s.fake.addFile(s.fake.rootUid, 'n.txt', 'same');
    assert.equal((await s.pending.flush()).uploaded, 1);
    assert.equal(s.fake.uploads.length, 0);
});

test('a revision of a file deleted on Drive meanwhile is uploaded as a new file', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const { uid, entry } = await editedFile(s, 'r.txt', 'old', 'mine');
    for await (const _result of s.fake.client.trashNodes([uid])) {
        // drain
    }
    s.pending.closed(entry);
    await s.pending.flush();
    assert.deepEqual(s.fake.uploads.map((u) => [u.kind, u.name]), [['new', 'r.txt']]);
});

test('a permanent error marks the entry failed and keeps it; a change retries it', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const entry = await closedNewFile(s, '/q.txt', 'q');
    s.fake.failNextUpload(new ValidationError('Insufficient quota', 200001));
    assert.deepEqual(await s.pending.flush(), { uploaded: 0, failed: 1, retrying: 0, open: 0 });
    assert.equal(entry.state, 'failed');
    assert.deepEqual(s.pending.status().failures, [{ path: '/q.txt', error: 'Insufficient quota' }]);
    assert.ok(existsSync(entry.localPath));
    // Flushing again does not retry a failed entry ...
    assert.deepEqual(await s.pending.flush(), { uploaded: 0, failed: 1, retrying: 0, open: 0 });
    // ... a change to it does.
    s.pending.touched(entry);
    assert.equal((await s.pending.flush()).uploaded, 1);
});

test('a transient error retries with backoff', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/t.txt', 't');
    s.fake.failNextUpload(new ServerError('Service unavailable'));
    assert.deepEqual(await s.pending.flush(), { uploaded: 0, failed: 0, retrying: 1, open: 0 });
    await waitFor(() => s.fake.uploads.length === 1, 3000, 'the retry');
});

test('a change during the upload aborts it; the new content goes up afterwards', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const entry = await closedNewFile(s, '/u.txt', 'first');
    const release = s.fake.holdUploads();
    const firstFlush = s.pending.flush();
    await waitFor(() => s.fake.inFlight === 1, 3000, 'the upload to start');
    s.pending.opened(entry);
    await writeFile(entry.localPath, 'second');
    s.pending.touched(entry);
    s.pending.closed(entry);
    release();
    await s.pending.flush();
    await firstFlush;
    assert.equal(s.fake.uploads.length, 1);
    assert.equal(s.fake.contentOf(s.fake.uploads[0].nodeUid), 'second');
});

test('an HTTP 4xx from the server is permanent', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/g.txt', 'g');
    s.fake.failNextUpload(Object.assign(new ServerError('Forbidden'), { statusCode: 403 }));
    assert.deepEqual(await s.pending.flush(), { uploaded: 0, failed: 1, retrying: 0, open: 0 });
});

test("another client's unfinished upload holding the name is waited out", async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/h.txt', 'h');
    s.fake.failNextUpload(new NodeWithSameNameExistsValidationError('draft', 2500, undefined, true));
    assert.deepEqual(await s.pending.flush(), { uploaded: 0, failed: 0, retrying: 1, open: 0 });
    await waitFor(() => s.fake.uploads.length === 1, 3000, 'the retry');
});

test('an API error code we do not classify is retried, but not forever', { timeout: 5000 }, async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/i.txt', 'i');
    for (let n = 0; n < 5; n++) {
        s.fake.failNextUpload(Object.assign(new ServerError('odd'), { code: 2011 }));
    }
    for (let n = 1; n <= 4; n++) {
        assert.equal((await s.pending.flush()).retrying, 1, `attempt ${n}`);
    }
    assert.deepEqual(await s.pending.flush(), { uploaded: 0, failed: 1, retrying: 0, open: 0 });
});

test('a revision blob is private even under umask 022', { timeout: 5000 }, async (t) => {
    const previous = process.umask(0o022);
    t.after(() => process.umask(previous));
    const s = await setupPending();
    t.after(s.cleanup);
    const uid = s.fake.addFile(s.fake.rootUid, 'r.txt', 'old');
    const node = await s.fake.client.getNode(uid);
    const cached = await s.content.ensureDownloaded(node);
    const entry = s.pending.beginRevision('/r.txt', node, s.fake.rootUid, 'r.txt', 1, cached);
    await entry.ready;
    assert.equal(statSync(entry.localPath).mode & 0o777, 0o600);
});
