import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { ContentStore } from '../../src/contentStore';
import { FakeDrive } from '../fakeDrive';
import { silentLogger, tempDir } from '../helpers';

function setup(t: TestContext) {
    const tmp = tempDir();
    t.after(tmp.cleanup);
    const fake = new FakeDrive();
    const store = new ContentStore(fake.client, path.join(tmp.dir, 'blobs'), silentLogger);
    const file = path.join(tmp.dir, 'f');
    writeFileSync(file, 'hello');
    return { fake, store, file };
}

test('uploads store the given modification time, not the time of upload', async (t) => {
    const { fake, store, file } = setup(t);
    const first = new Date('2001-02-03T04:05:06.789Z');
    const node = await store.uploadNewFile(fake.rootUid, 'f.txt', file, { modificationTime: first });
    assert.equal(node.name.ok && node.name.value, 'f.txt');

    const second = new Date('2002-01-01T00:00:00Z');
    const revisionUid = await store.uploadRevision(node.uid, 'f.txt', file, { modificationTime: second });

    assert.deepEqual(
        fake.uploads.map((u) => [u.kind, u.nodeUid, u.claimedModificationTime?.toISOString()]),
        [
            ['new', node.uid, first.toISOString()],
            ['revision', node.uid, second.toISOString()],
        ],
    );
    assert.equal(fake.uploads[1].revisionUid, revisionUid);
});

test('an aborted signal stops the upload before anything lands', async (t) => {
    const { fake, store, file } = setup(t);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
        store.uploadNewFile(fake.rootUid, 'g.txt', file, { modificationTime: new Date(), signal: abort.signal }),
        { name: 'AbortError' },
    );
    assert.equal(fake.uploads.length, 0);
});
