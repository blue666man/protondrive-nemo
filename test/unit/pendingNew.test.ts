import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { closedNewFile, setupPending } from '../pendingSetup';
import { sleep, waitFor } from '../support';

const T1 = new Date('2001-02-03T04:05:06Z');

test('a closed new file uploads once after the settle window, claiming its local mtime', async (t) => {
    const s = await setupPending({ settleMs: 30 });
    t.after(s.cleanup);
    const entry = await closedNewFile(s, '/a.txt', 'hello', T1);
    assert.equal(s.fake.uploads.length, 0);
    await waitFor(() => s.fake.uploads.length === 1, 3000, 'the upload');
    const [up] = s.fake.uploads;
    assert.deepEqual(
        [up.kind, up.name, up.parentUid, up.claimedModificationTime?.toISOString()],
        ['new', 'a.txt', s.fake.rootUid, T1.toISOString()],
    );
    // Done: the entry and its record are gone, and the content is the cached copy.
    await waitFor(
        () => !s.pending.has('/a.txt') && readdirSync(path.join(s.dir, 'pending')).length === 0,
        3000,
        'the entry to finish',
    );
    assert.equal(readFileSync(s.content.localPathFor(up.nodeUid), 'utf8'), 'hello');
    assert.equal(existsSync(entry.localPath), false);
});

test('nothing uploads while a handle is open; the last close starts the window', async (t) => {
    const s = await setupPending({ settleMs: 30 });
    t.after(s.cleanup);
    const entry = await s.pending.createNew('/b.txt', s.fake.rootUid, 'b.txt');
    s.pending.opened(entry);
    s.pending.closed(entry);
    await sleep(100);
    assert.equal(s.fake.uploads.length, 0);
    assert.equal(entry.state, 'open');
    s.pending.closed(entry);
    await waitFor(() => s.fake.uploads.length === 1, 3000, 'the upload');
});

test('touched restarts the settle window', async (t) => {
    const s = await setupPending({ settleMs: 300 });
    t.after(s.cleanup);
    const entry = await closedNewFile(s, '/c.txt', 'x');
    await sleep(200);
    s.pending.touched(entry);
    await sleep(200); // ~400 ms after the close, ~200 ms after the touch
    assert.equal(s.fake.uploads.length, 0);
    await waitFor(() => s.fake.uploads.length === 1, 3000, 'the upload');
});

test('flush uploads everything closed at once and reports what happened', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/d1.txt', '1');
    await closedNewFile(s, '/d2.txt', '2');
    await s.pending.createNew('/d3.txt', s.fake.rootUid, 'd3.txt'); // still open
    assert.deepEqual(await s.pending.flush(), { uploaded: 2, failed: 0, retrying: 0, open: 1 });
    assert.deepEqual(s.fake.uploads.map((u) => u.name).sort(), ['d1.txt', 'd2.txt']);
});

test('move retargets a pending new file: one upload, under the final name and folder', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const docs = s.fake.addFolder(s.fake.rootUid, 'docs');
    await closedNewFile(s, '/.e.txt.Xy12Zq', 'e', T1);
    s.pending.move('/.e.txt.Xy12Zq', '/docs/e.txt', docs, 'e.txt');
    assert.equal(s.pending.has('/.e.txt.Xy12Zq'), false);
    assert.equal(s.pending.get('/docs/e.txt')?.name, 'e.txt');
    await s.pending.flush();
    assert.deepEqual(s.fake.uploads.map((u) => [u.parentUid, u.name]), [[docs, 'e.txt']]);
});

test('moveFolder rewrites the paths of entries below a renamed folder', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const docs = s.fake.addFolder(s.fake.rootUid, 'docs');
    await closedNewFile(s, '/docs/f.txt', 'f', undefined, docs);
    s.pending.moveFolder('/docs', '/papers');
    assert.ok(s.pending.has('/papers/f.txt'));
    assert.equal(s.pending.has('/docs/f.txt'), false);
});

test('cancel drops the entry and its content; nothing uploads', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    const entry = await closedNewFile(s, '/g.txt', 'g');
    assert.equal(await s.pending.cancel('/g.txt'), undefined);
    assert.equal(s.pending.has('/g.txt'), false);
    assert.equal(existsSync(entry.localPath), false);
    assert.deepEqual(await s.pending.flush(), { uploaded: 0, failed: 0, retrying: 0, open: 0 });
    assert.equal(s.fake.uploads.length, 0);
});

test('inFolder lists the pending files of one folder; status counts them by state', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/h1.txt', 'h');
    await s.pending.createNew('/h2.txt', s.fake.rootUid, 'h2.txt');
    assert.deepEqual(s.pending.inFolder(s.fake.rootUid).map((e) => e.name).sort(), ['h1.txt', 'h2.txt']);
    assert.deepEqual(s.pending.status(), { open: 1, pending: 1, uploading: 0, failed: 0, failures: [] });
});

test('createNew refuses a path that is already pending', async (t) => {
    const s = await setupPending();
    t.after(s.cleanup);
    await closedNewFile(s, '/i.txt', 'i');
    await assert.rejects(s.pending.createNew('/i.txt', s.fake.rootUid, 'i.txt'), { code: 'EEXIST' });
});
