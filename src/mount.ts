import path from 'node:path';

import Fuse from '@cocalc/fuse-native';

import { createCachePolicy } from './cachePolicy';
import { ContentStore } from './contentStore';
import { DriveTree } from './driveTree';
import { createFuseOperations } from './fuseOps';
import { acquireInstanceLock } from './instanceLock';
import { IpcServer, socketPathFor } from './ipcServer';
import { PendingJournal } from './pendingJournal';
import { PendingUploads } from './pendingUploads';
import type { initDrive } from './sdk-bootstrap/init';

export interface MountOptions {
    /** Quiet time before a changed file uploads. Default: PROTONDRIVE_NEMO_SETTLE_MS, else 2000. */
    settleMs?: number;
    /** How long shutdown waits for running uploads. Default: PROTONDRIVE_NEMO_SHUTDOWN_GRACE_MS, else 10000. */
    shutdownGraceMs?: number;
}

export interface MountHandle {
    fuse: Fuse;
    ipc: IpcServer;
    pending: PendingUploads;
    shutdownGraceMs: number;
    /** Releases the one-daemon-per-account lock; call it last, after unmounting. */
    releaseLock: () => Promise<void>;
    /** Wipes the throwaway content cache (tmp/), or all of it in ephemeral mode. Call after unmounting, before releasing the lock. */
    cleanup: () => Promise<void>;
}

/** Whole milliseconds from environment variable `name`, or `fallback` when it is unset. */
export function msFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a whole number of milliseconds, got "${raw}"`);
    }
    return value;
}

export async function mount(
    drive: Awaited<ReturnType<typeof initDrive>>,
    mountPoint: string,
    options: MountOptions = {},
): Promise<MountHandle> {
    if (!drive.auth.isLoggedIn()) {
        throw new Error('Not logged in. Run `protondrive-nemo login` first.');
    }
    const settleMs = options.settleMs ?? msFromEnv('PROTONDRIVE_NEMO_SETTLE_MS', 2000);
    const shutdownGraceMs = options.shutdownGraceMs ?? msFromEnv('PROTONDRIVE_NEMO_SHUTDOWN_GRACE_MS', 10_000);

    const tree = new DriveTree(drive.sdk, drive.logger);
    // The cache root: blobs/ and tmp/ come from ContentStore.dirFor.
    const content = new ContentStore(drive.sdk, drive.config.cacheDir, drive.logger);
    const policy = createCachePolicy(drive.config);
    // Changes wait here, content and journal record, until they are on Drive.
    const pending = new PendingUploads({
        sdk: drive.sdk,
        tree,
        content,
        journal: new PendingJournal(path.join(drive.config.cacheDir, 'pending')),
        logger: drive.logger,
        settleMs,
        policy,
    });
    // Before the journal is loaded: a second daemon would take the first
    // one's open files for leftovers and delete them.
    const releaseLock = await acquireInstanceLock(drive.config.cacheDir);
    let fuse: Fuse | undefined;
    try {
        // Under the lock: a second daemon must not wipe the first one's open copies.
        // pending/ is not touched; the uploads waiting there resume below. tmp/
        // only holds copies of open files, so whatever is there was left by a crash.
        await (drive.config.ephemeralCache ? content.wipe() : content.wipeEphemeral());
        // Before mounting, so files left over from the last run are visible from the start.
        await pending.resume();
        const { ops, hasUnsavedChanges } = createFuseOperations(drive.sdk, tree, content, policy, pending, drive.logger);

        const isDefaultProfile = drive.config.profile === 'default';
        const mounting = new Fuse(mountPoint, ops, {
            // force: a mount left by a killed daemon (ENOTCONN) is lazily
            // unmounted first. mkdir: creates a missing mount point. Our own
            // mkdir must not run before this: on a dead mount it fails with
            // ENOTCONN before force can clear it.
            force: true,
            mkdir: true,
            fsname: isDefaultProfile ? 'protondrive-nemo' : `protondrive-nemo-${drive.config.profile}`,
            displayFolder: isDefaultProfile ? 'Proton Drive' : `Proton Drive (${drive.config.profile})`,
            debug: process.env.PROTONDRIVE_NEMO_FUSE_DEBUG === '1',
            // Lets root use the mount too (e.g. a backup job). libfuse only allows
            // this with `user_allow_other` in /etc/fuse.conf; see README.
            allowRoot: process.env.PROTONDRIVE_NEMO_FUSE_ALLOW_ROOT === '1',
        });
        await new Promise<void>((resolve, reject) => {
            mounting.mount((err) => (err ? reject(err) : resolve()));
        });
        fuse = mounting;

        const ipc = new IpcServer(socketPathFor(drive.config.cacheDir), tree, content, hasUnsavedChanges, drive.logger, pending);
        await ipc.start();

        const cleanup = async (): Promise<void> => {
            await (drive.config.ephemeralCache ? content.wipe() : content.wipeEphemeral());
        };

        return { fuse, ipc, pending, shutdownGraceMs, releaseLock, cleanup };
    } catch (err) {
        // Undo what was started, so the lock is not released under running uploads or a live mount.
        if (fuse) {
            const mounted = fuse;
            await new Promise<void>((resolve) => mounted.unmount(() => resolve()));
        }
        // Resumed uploads stop and stay in the journal.
        await pending.shutdown(0).catch(() => {});
        await releaseLock();
        throw err;
    }
}

export async function unmount(mountPoint: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        Fuse.unmount(mountPoint, (err) => (err ? reject(err) : resolve()));
    });
}
