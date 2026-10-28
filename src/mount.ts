import { mkdir } from 'node:fs/promises';

import Fuse from '@cocalc/fuse-native';

import { ContentStore } from './contentStore';
import { DriveTree } from './driveTree';
import { createFuseOperations } from './fuseOps';
import { IpcServer, socketPathFor } from './ipcServer';
import type { initDrive } from './sdk-bootstrap/init';

export interface MountHandle {
    fuse: Fuse;
    ipc: IpcServer;
}

export async function mount(drive: Awaited<ReturnType<typeof initDrive>>, mountPoint: string): Promise<MountHandle> {
    if (!drive.auth.isLoggedIn()) {
        throw new Error('Not logged in. Run `protondrive-nemo login` first.');
    }

    await mkdir(mountPoint, { recursive: true });

    const tree = new DriveTree(drive.sdk, drive.logger);
    const contentCacheDir = `${drive.config.cacheDir}/blobs`;
    const content = new ContentStore(drive.sdk, contentCacheDir, drive.logger);
    const { ops, hasUnsavedChanges } = createFuseOperations(drive.sdk, tree, content, drive.logger);

    const isDefaultProfile = drive.config.profile === 'default';
    const fuse = new Fuse(mountPoint, ops, {
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
        fuse.mount((err) => (err ? reject(err) : resolve()));
    });

    const ipc = new IpcServer(socketPathFor(drive.config.cacheDir), tree, content, hasUnsavedChanges, drive.logger);
    await ipc.start();

    return { fuse, ipc };
}

export async function unmount(mountPoint: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        Fuse.unmount(mountPoint, (err) => (err ? reject(err) : resolve()));
    });
}
