import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sendRequest, socketPathFor } from '../../src/ipcServer';
import { mountFake, writeNew } from '../mountFake';

const idle = { open: 0, pending: 0, uploading: 0, failed: 0, failures: [] };

test('pendingStatus and flush over the control socket', async (t) => {
    const m = await mountFake(t);
    const socket = socketPathFor(m.cacheDir);
    await writeNew(m, '/a.txt', 'a');
    assert.deepEqual(await sendRequest(socket, { op: 'pendingStatus' }), {
        ok: true,
        status: { ...idle, pending: 1 },
    });
    assert.deepEqual(await sendRequest(socket, { op: 'flush' }), {
        ok: true,
        result: { uploaded: 1, failed: 0, retrying: 0, open: 0 },
    });
    assert.deepEqual(await sendRequest(socket, { op: 'pendingStatus' }), { ok: true, status: idle });
});

test('evict refuses a file whose changes are not on Drive yet', async (t) => {
    const m = await mountFake(t);
    await writeNew(m, '/a.txt', 'a');
    assert.deepEqual(await sendRequest(socketPathFor(m.cacheDir), { op: 'evict', path: '/a.txt' }), {
        ok: false,
        error: 'open-with-unsaved-changes',
    });
});

test('sendRequest reports a daemon that is not running', async () => {
    await assert.rejects(sendRequest('/nonexistent/daemon.sock', { op: 'pendingStatus' }), /mount-not-running/);
});
