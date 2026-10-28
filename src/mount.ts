import { mkdir } from 'node:fs/promises';

import Fuse from '@cocalc/fuse-native';

import { createCachePolicy } from './cachePolicy';
import { ContentStore } from './contentStore';
import { DriveTree } from './driveTree';
import { createFuseOperations } from './fuseOps';
import { IpcServer, socketPathFor } from './ipcServer';
import type { initDrive } from './sdk-bootstrap/init';

export interface MountHandle {
    fuse: Fuse;
    ipc: IpcServer;
    /** Wipes the decrypted content cache in ephemeral mode. Call after unmounting. */
    cleanup: () => Promise<void>;
}

export async function mount(drive: Awaited<ReturnType<typeof initDrive>>, mountPoint: string): Promise<MountHandle> {
    if (!drive.auth.isLoggedIn()) {
        throw new Error('Not logged in. Run `protondrive-nemo login` first.');
    }

    await mkdir(mountPoint, { recursive: true });

    const tree = new DriveTree(drive.sdk, drive.logger);
    const content = new ContentStore(drive.sdk, drive.config.cacheDir, drive.logger);
    if (drive.config.ephemeralCache) {
        // Clear anything a previous (possibly crashed) mount left behind
        // before we start handing out decrypted content again.
        await content.wipe();
    }
    const policy = createCachePolicy(drive.config);
    const { ops, hasUnsavedChanges } = createFuseOperations(drive.sdk, tree, content, policy, drive.logger);

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

    const ipc = new IpcServer(socketPathFor(drive.config.cacheDir), tree, content, hasUnsavedChanges, drive.logger);
    await ipc.start();

    const cleanup = async (): Promise<void> => {
        if (drive.config.ephemeralCache) {
            await content.wipe();
        }
    };

    return { fuse, ipc, cleanup };
}

export async function unmount(mountPoint: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        Fuse.unmount(mountPoint, (err) => (err ? reject(err) : resolve()));
    });
}
