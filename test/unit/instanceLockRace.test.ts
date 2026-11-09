import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { acquireInstanceLock } from '../../src/instanceLock';
import { tempDir } from '../helpers';

// The race is between daemons, so it needs several processes: in one
// process every attempt writes the same pid, and a lock with our own pid
// that `held` does not list is (rightly) judged stale. This file therefore
// doubles as the child: with PDN_LOCK_RACE_CHILD set it registers no test
// and instead takes one line per round from stdin, `<dir> <goAtMs>`, waits
// until goAtMs so that every child starts together, tries the lock in <dir>
// and answers `win` or `lose <message>`. Winners keep their lock: each round
// uses its own dir.

/** A pid that cannot belong to a live process: above Linux's default pid_max (2^22). */
const DEAD_PID = 2 ** 22 + 12345;
const CHILDREN = 20;
const ROUNDS = 10;

async function child(): Promise<void> {
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
        const [dir, goAt] = line.split(' ');
        while (Date.now() < Number(goAt)) {
            // Spin: a timer is too coarse to line the children up.
        }
        let answer: string;
        try {
            await acquireInstanceLock(dir);
            answer = 'win';
        } catch (err) {
            answer = `lose ${(err as Error).message}`;
        }
        process.stdout.write(`${answer}\n`);
    }
}

if (process.env.PDN_LOCK_RACE_CHILD) {
    void child();
} else {
    test(
        `${CHILDREN} daemons starting together over a stale lock: exactly one wins (${ROUNDS} rounds)`,
        { timeout: 60_000 },
        async (t) => {
            try {
                process.kill(DEAD_PID, 0);
                t.skip(`pid ${DEAD_PID} exists on this machine`);
                return;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
                    t.skip(`pid ${DEAD_PID} is not known to be dead: ${(err as Error).message}`);
                    return;
                }
            }
            const tmp = tempDir();
            const children: ChildProcess[] = [];
            t.after(() => {
                for (const c of children) {
                    c.kill();
                }
                tmp.cleanup();
            });
            const answers: Array<() => Promise<string>> = [];
            for (let i = 0; i < CHILDREN; i++) {
                // Without NODE_TEST_CONTEXT: the child is a plain script, not a test file.
                const { NODE_TEST_CONTEXT: _, ...env } = process.env;
                const c = spawn(process.execPath, ['--enable-source-maps', __filename], {
                    env: { ...env, PDN_LOCK_RACE_CHILD: '1' },
                    stdio: ['pipe', 'pipe', 'inherit'],
                });
                children.push(c);
                const it = createInterface({ input: c.stdout! })[Symbol.asyncIterator]();
                answers.push(async () => {
                    const next = await it.next();
                    if (next.done) {
                        throw new Error(`child ${c.pid} exited`);
                    }
                    return next.value as string;
                });
            }
            const failures: string[] = [];
            for (let round = 0; round < ROUNDS; round++) {
                const dir = path.join(tmp.dir, `round${round}`);
                mkdirSync(dir);
                const lockFile = path.join(dir, 'daemon.lock');
                writeFileSync(lockFile, `${DEAD_PID}\n`);
                // Late enough for every child to have read its line, the first round also for node to start.
                const goAt = Date.now() + (round === 0 ? 1500 : 100);
                for (const c of children) {
                    c.stdin!.write(`${dir} ${goAt}\n`);
                }
                const results = await Promise.all(answers.map((next) => next()));
                const winners = results.filter((r) => r === 'win').length;
                const lock = readFileSync(lockFile, 'utf8');
                const holder = Number(lock.split(' ')[0]);
                const holderWon = results[children.findIndex((c) => c.pid === holder)] === 'win';
                if (winners !== 1 || !holderWon) {
                    failures.push(`round ${round}: ${winners} winners; lock holds ${JSON.stringify(lock)}`);
                }
                for (const r of results) {
                    if (r !== 'win' && !/already running for this account|Could not take over/.test(r)) {
                        failures.push(`round ${round}: unexpected ${r}`);
                    }
                }
            }
            assert.deepEqual(failures, []);
        },
    );
}
