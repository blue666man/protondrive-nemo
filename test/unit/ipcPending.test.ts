import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { test } from 'node:test';

import { sendRequest, socketPathFor } from '../../src/ipcServer';
import { guardedShutdown } from '../../src/shutdown';
import { mountFake, writeNew } from '../mountFake';
import { sleep } from '../support';

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

test('a shutdown request runs the daemon\'s hook and returns what is left pending', { timeout: 5000 }, async (t) => {
    const m = await mountFake(t);
    let calls = 0;
    m.handle.ipc.onShutdown = async () => {
        calls++;
        return 3;
    };
    assert.deepEqual(await sendRequest(socketPathFor(m.cacheDir), { op: 'shutdown' }), { ok: true, remaining: 3 });
    assert.equal(calls, 1);
});

test('stop() returns promptly while a client is connected and silent', { timeout: 5000 }, async (t) => {
    const m = await mountFake(t);
    const client = createConnection(socketPathFor(m.cacheDir));
    await once(client, 'connect');
    const outcome = await Promise.race([m.handle.ipc.stop().then(() => 'stopped'), sleep(1000).then(() => 'still waiting')]);
    client.destroy();
    assert.equal(outcome, 'stopped');
});

test('the shutdown reply still arrives when the shutdown stops the control socket, as the CLI wires it', { timeout: 5000 }, async (t) => {
    const m = await mountFake(t);
    await writeNew(m, '/a.txt', 'a');
    const shutdown = guardedShutdown({
        drain: () => m.handle.pending.shutdown(m.handle.shutdownGraceMs),
        steps: [['stop the control socket', () => m.handle.ipc.stop()]],
        log: () => {},
    });
    let done: Promise<number> | undefined;
    m.handle.ipc.onShutdown = () => {
        const run = shutdown('unmount requested');
        done = run.done;
        return run.drained;
    };
    assert.deepEqual(await sendRequest(socketPathFor(m.cacheDir), { op: 'shutdown' }), { ok: true, remaining: 1 });
    assert.equal(await done, 0);
    await assert.rejects(sendRequest(socketPathFor(m.cacheDir), { op: 'pendingStatus' }), /mount-not-running/);
});

test('a failed shutdown still answers, even as the shutdown stops the control socket', { timeout: 5000 }, async (t) => {
    const m = await mountFake(t);
    const shutdown = guardedShutdown({
        drain: async () => {
            throw new Error('drain broke');
        },
        steps: [['stop the control socket', () => m.handle.ipc.stop()]],
        log: () => {},
        error: () => {},
    });
    let done: Promise<number> | undefined;
    m.handle.ipc.onShutdown = () => {
        const run = shutdown('unmount requested');
        done = run.done;
        return run.drained;
    };
    assert.deepEqual(await sendRequest(socketPathFor(m.cacheDir), { op: 'shutdown' }), { ok: false, error: 'drain broke' });
    assert.equal(await done, 1);
});

test('a shutdown hook that rejects still gets its answer to the client', { timeout: 5000 }, async (t) => {
    const m = await mountFake(t);
    m.handle.ipc.onShutdown = async () => {
        void m.handle.ipc.stop();
        throw new Error('drain broke');
    };
    assert.deepEqual(await sendRequest(socketPathFor(m.cacheDir), { op: 'shutdown' }), { ok: false, error: 'drain broke' });
});
