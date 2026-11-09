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

/** A lock judged stale: its content and inode when judged. */
interface StaleLock {
    text: string;
    ino: number;
}

/**
 * Whether the existing lock at `lockPath` is held (`reason`: an error
 * message) or stale (`stale`). Neither: it is gone meanwhile.
 */
async function judge(lockPath: string): Promise<{ reason?: string; stale?: StaleLock }> {
    let text: string;
    let mtimeMs: number;
    let ino: number;
    try {
        [text, { mtimeMs, ino }] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    } catch {
        return {}; // gone meanwhile
    }
    const stale = { stale: { text, ino } };
    const lock = parseLock(text);
    if (!lock) {
        return Date.now() - mtimeMs < FRESH_LOCK_MS
            ? { reason: 'protondrive-nemo is already running for this account (it is starting up)' }
            : stale;
    }
    if (lock.pid === process.pid) {
        return stale; // an earlier life of this pid: this process's own locks are in `held`
    }
    try {
        process.kill(lock.pid, 0);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
            return stale;
        }
        // EPERM: it exists, but belongs to someone else.
    }
    const start = await startTimeOf(lock.pid);
    if (lock.start !== '-' && start !== '-' && lock.start !== start) {
        return stale; // the pid now belongs to another process
    }
    return { reason: `protondrive-nemo is already running for this account (pid ${lock.pid})` };
}

const TAKEN_OVER = 'protondrive-nemo is already running for this account (another starter took over the stale lock)';

/**
 * Removes the stale lock `stale` from `lockPath`, unless another starter
 * claims it first (throws) or it is no longer there (returns: try link()
 * again).
 *
 * Several starters may judge one lock stale. Unlinking it outright lets a
 * slow one delete the lock a quicker one has put in its place since: two
 * daemons. Renaming it aside first does not help, as the renamed file may
 * already be the quicker one's lock, and while it is put back the lock is
 * missing and a third starter gets in. So the stale lock is claimed
 * instead, by hard-linking it to `daemon.lock.claim.<inode>`: link() fails
 * if that name exists, so only one starter claims a given stale file, and
 * daemon.lock itself is never touched by the others. The claim also keeps
 * the stale inode allocated, so its number cannot be reused meanwhile.
 * Whoever claims it checks that the claim is the file it judged (same inode
 * and content) and only then unlinks daemon.lock: no one else unlinks it,
 * and no one can link() over it while it exists.
 */
async function removeStale(lockPath: string, stale: StaleLock): Promise<void> {
    const claimPath = `${lockPath}.claim.${stale.ino}`;
    try {
        await link(lockPath, claimPath);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return; // gone meanwhile
        }
        if (code !== 'EEXIST') {
            throw err;
        }
        // A starter that died between claiming and unlinking leaves its claim
        // behind; link() updates ctime, so an old one is abandoned. Removing
        // it lets the next start try again.
        const { ctimeMs } = await stat(claimPath).catch(() => ({ ctimeMs: Date.now() }));
        if (Date.now() - ctimeMs >= FRESH_LOCK_MS) {
            await unlink(claimPath).catch(() => {});
        }
        throw new Error(TAKEN_OVER);
    }
    try {
        const [text, { ino }] = await Promise.all([readFile(claimPath, 'utf8'), stat(claimPath)]);
        if (ino !== stale.ino || text !== stale.text) {
            // daemon.lock changed since it was judged: the claim is just another name for someone's lock.
            throw new Error(TAKEN_OVER);
        }
        await unlink(lockPath);
    } finally {
        await unlink(claimPath).catch(() => {});
    }
}

/**
 * Makes this process the only mount daemon for the account whose cache dir
 * is `dir`: a second daemon would load the same journal and delete the
 * first one's open files as leftovers.
 *
 * `<dir>/daemon.lock` holds `"<pid> <starttime>\n"`. It is written whole to
 * a temp file and link()ed into place, so no one sees it half-written. A
 * lock whose process is gone, or whose pid now names a process started at
 * another time, is stale and taken over; of several starters doing so at
 * once, exactly one wins (see removeStale).
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
        // A few times at most: once more after removing a stale lock, or when it went away meanwhile.
        for (let attempt = 0; ; attempt++) {
            let linked = false;
            try {
                await link(tmpPath, lockPath);
                linked = true;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw err;
                }
            }
            if (linked) {
                // Belt and braces: the lock must now be exactly ours.
                const now = await readFile(lockPath, 'utf8').catch(() => undefined);
                if (now !== ours) {
                    throw new Error(TAKEN_OVER);
                }
                break;
            }
            const { reason, stale } = await judge(lockPath);
            if (reason) {
                throw new Error(reason);
            }
            if (attempt >= 2) {
                throw new Error(`Could not take over the stale lock ${lockPath}`);
            }
            if (stale) {
                await removeStale(lockPath, stale);
            }
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
