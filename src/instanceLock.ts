import { randomBytes } from 'node:crypto';
import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** An empty or unparsable lock younger than this is a starter still writing it. */
const FRESH_LOCK_MS = 10_000;

/** Lock paths this process holds: a second mount in the same process is refused. */
const held = new Set<string>();

/**
 * Field 22 of /proc/<pid>/stat: when the process started, in clock ticks
 * since boot. With the pid it names one process, even after pid reuse.
 * `-` where /proc is unavailable (not Linux) or unreadable.
 */
async function startTimeOf(pid: number): Promise<string> {
    try {
        const text = await readFile(`/proc/${pid}/stat`, 'utf8');
        // Field 2 (the command) is in parentheses and may hold spaces; field 3 follows the last ')'.
        const start = text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
        return start && /^\d+$/.test(start) ? start : '-';
    } catch {
        return '-';
    }
}

/** `"<pid> <starttime>"`, or undefined for an empty or unparsable lock. A lock without a start time reads as `-`. */
function parseLock(text: string): { pid: number; start: string } | undefined {
    const match = /^(\d+)(?: (\S+))?\s*$/.exec(text);
    if (!match) {
        return undefined;
    }
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, start: match[2] ?? '-' } : undefined;
}

/** Why the existing lock at `lockPath` is held (an error message), or undefined if it is stale. */
async function heldBecause(lockPath: string): Promise<string | undefined> {
    let text: string;
    let mtimeMs: number;
    try {
        [text, { mtimeMs }] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    } catch {
        return undefined; // gone meanwhile
    }
    const lock = parseLock(text);
    if (!lock) {
        return Date.now() - mtimeMs < FRESH_LOCK_MS
            ? 'protondrive-nemo is already running for this account (it is starting up)'
            : undefined;
    }
    if (lock.pid === process.pid) {
        return undefined; // an earlier life of this pid: this process's own locks are in `held`
    }
    try {
        process.kill(lock.pid, 0);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
            return undefined;
        }
        // EPERM: it exists, but belongs to someone else.
    }
    const start = await startTimeOf(lock.pid);
    if (lock.start !== '-' && start !== '-' && lock.start !== start) {
        return undefined; // the pid now belongs to another process
    }
    return `protondrive-nemo is already running for this account (pid ${lock.pid})`;
}

/**
 * Makes this process the only mount daemon for the account whose cache dir
 * is `dir`: a second daemon would load the same journal and delete the
 * first one's open files as leftovers.
 *
 * `<dir>/daemon.lock` holds `"<pid> <starttime>\n"`. It is written whole to
 * a temp file and link()ed into place, so no one sees it half-written. A
 * lock whose process is gone, or whose pid now names a process started at
 * another time, is stale and taken over.
 *
 * Resolves with a function that releases the lock (deletes the file if it
 * is still ours).
 */
export async function acquireInstanceLock(dir: string): Promise<() => Promise<void>> {
    const lockPath = path.resolve(dir, 'daemon.lock');
    if (held.has(lockPath)) {
        throw new Error(`protondrive-nemo is already running for this account (pid ${process.pid})`);
    }
    const ours = `${process.pid} ${await startTimeOf(process.pid)}\n`;
    const tmpPath = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmpPath, ours, { mode: 0o600, flag: 'wx' });
    try {
        // Twice at most: once more after removing a stale lock.
        for (let attempt = 0; ; attempt++) {
            try {
                await link(tmpPath, lockPath);
                break;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw err;
                }
            }
            const reason = await heldBecause(lockPath);
            if (reason) {
                throw new Error(reason);
            }
            if (attempt > 0) {
                throw new Error(`Could not take over the stale lock ${lockPath}`);
            }
            await unlink(lockPath).catch(() => {});
        }
    } finally {
        await unlink(tmpPath).catch(() => {});
    }
    held.add(lockPath);
    return async () => {
        held.delete(lockPath);
        if ((await readFile(lockPath, 'utf8').catch(() => '')) === ours) {
            await unlink(lockPath).catch(() => {});
        }
    };
}
