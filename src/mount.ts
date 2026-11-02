import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import Fuse from '@cocalc/fuse-native';

import { ContentStore } from './contentStore';
import { DriveTree } from './driveTree';
import { createFuseOperations } from './fuseOps';
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

    await mkdir(mountPoint, { recursive: true });

    const tree = new DriveTree(drive.sdk, drive.logger);
    const contentCacheDir = `${drive.config.cacheDir}/blobs`;
    const content = new ContentStore(drive.sdk, contentCacheDir, drive.logger);
    // Changes wait here, content and journal record, until they are on Drive.
    const pending = new PendingUploads({
        sdk: drive.sdk,
        tree,
        content,
        journal: new PendingJournal(path.join(drive.config.cacheDir, 'pending')),
        logger: drive.logger,
        settleMs,
    });
    // Before mounting, so files left over from the last run are visible from the start.
    await pending.resume();
    const { ops, hasUnsavedChanges } = createFuseOperations(drive.sdk, tree, content, pending, drive.logger);

    const isDefaultProfile = drive.config.profile === 'default';
    const fuse = new Fuse(mountPoint, ops, {
        force: true,
        mkdir: true,
        fsname: isDefaultProfile ? 'protondrive-nemo' : `protondrive-nemo-${drive.config.profile}`,
        displayFolder: isDefaultProfile ? 'Proton Drive' : `Proton Drive (${drive.config.profile})`,
        debug: process.env.PROTONDRIVE_NEMO_FUSE_DEBUG === '1',
    });

    await new Promise<void>((resolve, reject) => {
        fuse.mount((err) => (err ? reject(err) : resolve()));
    });

    const ipc = new IpcServer(socketPathFor(drive.config.cacheDir), tree, content, hasUnsavedChanges, drive.logger, pending);
    await ipc.start();

    return { fuse, ipc, pending, shutdownGraceMs };
}

export async function unmount(mountPoint: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        Fuse.unmount(mountPoint, (err) => (err ? reject(err) : resolve()));
    });
}
