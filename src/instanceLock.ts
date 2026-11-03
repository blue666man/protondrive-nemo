import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Whether process `pid` exists (EPERM: it does, but belongs to someone else). */
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function lockHolder(lockPath: string): Promise<number | undefined> {
    const text = await readFile(lockPath, 'utf8').catch(() => '');
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Makes this process the only mount daemon for the account whose cache dir
 * is `dir`: a second daemon would load the same journal and delete the
 * first one's open files as leftovers. `<dir>/daemon.lock` holds the
 * owner's pid; a lock whose process is gone is stale and taken over.
 * Resolves with a function that releases the lock (deletes the file if it
 * still holds our pid).
 */
export async function acquireInstanceLock(dir: string): Promise<() => Promise<void>> {
    const lockPath = path.join(dir, 'daemon.lock');
    const ours = String(process.pid);
    // Twice at most: once more after removing a stale lock.
    for (let attempt = 0; ; attempt++) {
        try {
            const handle = await open(lockPath, 'wx', 0o600);
            try {
                await handle.writeFile(`${ours}\n`);
            } finally {
                await handle.close();
            }
            break;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw err;
            }
        }
        const pid = await lockHolder(lockPath);
        if (pid !== undefined && isAlive(pid)) {
            throw new Error(`protondrive-nemo is already running for this account (pid ${pid})`);
        }
        if (attempt > 0) {
            throw new Error(`Could not take over the stale lock ${lockPath}`);
        }
        await unlink(lockPath).catch(() => {});
    }
    return async () => {
        if ((await lockHolder(lockPath)) === process.pid) {
            await unlink(lockPath).catch(() => {});
        }
    };
}
