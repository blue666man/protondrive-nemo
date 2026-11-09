import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NodeWithSameNameExistsValidationError } from '@protontech/drive-sdk';

import { FakeDrive } from '../fakeDrive';
import { waitFor } from '../support';

const T1 = new Date('2001-02-03T04:05:06.789Z');

function streamOf(text: string): ReadableStream {
    return new Blob([text]).stream();
}

async function upload(fake: FakeDrive, parentUid: string, name: string, text: string, signal?: AbortSignal) {
    const uploader = await fake.client.getFileUploader(
        parentUid,
        name,
        { mediaType: 'text/plain', expectedSize: text.length, modificationTime: T1 },
        signal,
    );
    const controller = await uploader.uploadFromStream(streamOf(text), []);
    return controller.completion();
}

test('lists folders, creates files and records claimed times like the SDK', async () => {
    const fake = new FakeDrive();
    const docs = fake.addFolder(fake.rootUid, 'docs');
    const { nodeUid } = await upload(fake, docs, 'a.txt', 'hi');

    assert.equal(fake.find('/docs/a.txt'), nodeUid);
    const node = await fake.client.getNode(nodeUid);
    assert.equal(node.activeRevision?.claimedModificationTime?.toISOString(), T1.toISOString());
    assert.notEqual(node.modificationTime.getTime(), T1.getTime(), 'server time is not the claimed time');
    assert.deepEqual(
        fake.uploads.map((u) => [u.kind, u.name, u.parentUid, u.size]),
        [['new', 'a.txt', docs, 2]],
    );
    const uids: string[] = [];
    for await (const uid of fake.client.iterateFolderChildrenNodeUids(docs)) {
        uids.push(uid);
    }
    assert.deepEqual(uids, [nodeUid]);
});

test('refuses a second file with the same name, naming the existing node', async () => {
    const fake = new FakeDrive();
    const existing = fake.addFile(fake.rootUid, 'a.txt', 'x');
    await assert.rejects(upload(fake, fake.rootUid, 'a.txt', 'y'), (err: unknown) => {
        assert.ok(err instanceof NodeWithSameNameExistsValidationError);
        assert.equal(err.existingNodeUid, existing);
        return true;
    });
});

test('held uploads wait; their abort signal ends them with AbortError', async () => {
    const fake = new FakeDrive();
    const release = fake.holdUploads();
    const abort = new AbortController();
    const pending = upload(fake, fake.rootUid, 'held.txt', 'x', abort.signal);
    await waitFor(() => fake.inFlight === 1, 3000, 'the upload to be in flight');
    abort.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(fake.uploads.length, 0);
    release();
    await upload(fake, fake.rootUid, 'free.txt', 'x');
    assert.equal(fake.uploads.length, 1);
});

test('remoteEdit replaces the content and the active revision', async () => {
    const fake = new FakeDrive();
    const uid = fake.addFile(fake.rootUid, 'r.txt', 'old');
    const before = (await fake.client.getNode(uid)).activeRevision?.uid;
    fake.remoteEdit(uid, 'theirs');
    const after = await fake.client.getNode(uid);
    assert.notEqual(after.activeRevision?.uid, before);
    assert.equal(fake.contentOf(uid), 'theirs');
    assert.equal(after.activeRevision?.claimedSize, 6);
});

test('failNextUpload makes exactly the next upload fail', async () => {
    const fake = new FakeDrive();
    fake.failNextUpload(new Error('boom'));
    await assert.rejects(upload(fake, fake.rootUid, 'a.txt', 'x'), /boom/);
    await upload(fake, fake.rootUid, 'a.txt', 'x');
    assert.equal(fake.uploads.length, 1);
});
