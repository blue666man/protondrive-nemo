import assert from 'node:assert/strict';
import { test } from 'node:test';

import { guardedShutdown } from '../../src/shutdown';

/** A guardedShutdown whose drain and steps record their order in `calls`; `fail` names the ones that throw. */
function recorded(fail: string[] = [], remaining = 2) {
    const calls: string[] = [];
    const logs: string[] = [];
    const step = (name: string) => async () => {
        calls.push(name);
        if (fail.includes(name)) {
            throw new Error(`${name} broke`);
        }
    };
    const shutdown = guardedShutdown({
        drain: async () => {
            await step('drain')();
            return remaining;
        },
        steps: [
            ['ipc', step('ipc')],
            ['fuse', step('fuse')],
            ['lock', step('lock')],
            ['dispose', step('dispose')],
        ],
        log: (message) => logs.push(message),
        error: (message) => logs.push(`error: ${message}`),
    });
    return { calls, logs, shutdown };
}

test('shutdown drains, then runs every step in order, and exits 0', { timeout: 5000 }, async () => {
    const r = recorded();
    const run = r.shutdown('SIGTERM');
    assert.equal(await run.drained, 2);
    assert.equal(await run.done, 0);
    assert.deepEqual(r.calls, ['drain', 'ipc', 'fuse', 'lock', 'dispose']);
    assert.ok(r.logs.some((line) => line.includes('2 upload(s) still pending')), r.logs.join('\n'));
});

test('a failing step does not skip the rest; the exit code is 1', { timeout: 5000 }, async () => {
    const r = recorded(['fuse']);
    assert.equal(await r.shutdown('SIGINT').done, 1);
    assert.deepEqual(r.calls, ['drain', 'ipc', 'fuse', 'lock', 'dispose']);
    assert.ok(r.logs.some((line) => line.startsWith('error:') && line.includes('fuse')), r.logs.join('\n'));
});

test('a failing drain rejects drained, still runs the steps, and exits 1', { timeout: 5000 }, async () => {
    const r = recorded(['drain']);
    const run = r.shutdown('SIGTERM');
    await assert.rejects(run.drained, /drain broke/);
    assert.equal(await run.done, 1);
    assert.deepEqual(r.calls, ['drain', 'ipc', 'fuse', 'lock', 'dispose']);
});

test('a second request while shutting down logs and shares the first run', { timeout: 5000 }, async () => {
    const r = recorded();
    const first = r.shutdown('SIGTERM');
    const second = r.shutdown('SIGINT');
    assert.ok(r.logs.includes('Already shutting down…'), r.logs.join('\n'));
    assert.equal(second.drained, first.drained);
    assert.equal(second.done, first.done);
    assert.equal(await first.done, 0);
    assert.equal(r.calls.filter((name) => name === 'drain').length, 1);
});

test('the steps wait until whoever awaits drained has run (an IPC reply goes out before ipc.stop)', { timeout: 5000 }, async () => {
    const r = recorded();
    const run = r.shutdown('unmount');
    const replied = run.drained.then(() => r.calls.push('reply'));
    await run.done;
    await replied;
    assert.deepEqual(r.calls, ['drain', 'reply', 'ipc', 'fuse', 'lock', 'dispose']);
});
