import { constants as fsConstants, type Stats } from 'node:fs';
import { open as fsOpen, stat as fsStat, truncate as fsTruncate, utimes as fsUtimes, type FileHandle } from 'node:fs/promises';

import Fuse from '@cocalc/fuse-native';
import { NodeType } from '@protontech/drive-sdk';
import type { Logger, NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';

import { ContentStore } from './contentStore';
import { DriveTree, NodeNotFoundError } from './driveTree';
import type { PendingUpload, PendingUploads } from './pendingUploads';

interface OpenFile {
    /** Path under the mount; follows renames. */
    path: string;
    handle: FileHandle;
    /** The Drive file this handle was opened on; undefined for a file not on Drive yet. */
    node?: NodeEntity;
    parentUid: string;
    name: string;
    /** The pending upload this handle holds a reference on, once its content is pending. */
    entry?: PendingUpload;
}

/**
 * Drive keeps two times per file: the server's ModifyTime
 * (`node.modificationTime`, which also changes on rename and move) and the
 * time the uploading client claimed for the content
 * (`activeRevision.claimedModificationTime`, or
 * `folder.claimedModificationTime`). mtime is the claimed time when there is
 * one, so copies keep their times; ctime is the server time.
 */
export function statFor(node: NodeEntity): Fuse.Stats {
    const isFolder = node.type === NodeType.Folder;
    const size = isFolder ? 4096 : (node.activeRevision?.claimedSize ?? 0);
    const serverTime = node.modificationTime ?? new Date();
    const claimed = isFolder ? node.folder?.claimedModificationTime : node.activeRevision?.claimedModificationTime;
    const mtime = claimed ?? serverTime;
    const uid = process.getuid ? process.getuid() : 0;
    const gid = process.getgid ? process.getgid() : 0;
    return {
        mtime,
        atime: mtime,
        ctime: serverTime,
        nlink: 1,
        size,
        mode: isFolder ? fsConstants.S_IFDIR | 0o755 : fsConstants.S_IFREG | 0o644,
        uid,
        gid,
    } as Fuse.Stats;
}

/** A file whose content is not on Drive yet: its local copy is the truth. */
function statForLocal(local: Stats): Fuse.Stats {
    const uid = process.getuid ? process.getuid() : 0;
    const gid = process.getgid ? process.getgid() : 0;
    return {
        mtime: local.mtime,
        atime: local.atime,
        ctime: local.ctime,
        nlink: 1,
        size: local.size,
        mode: fsConstants.S_IFREG | 0o644,
        uid,
        gid,
    } as Fuse.Stats;
}

/**
 * libfuse 2 passes UTIME_NOW and UTIME_OMIT as tv_sec 0 plus a marker
 * tv_nsec, which fuse-native turns into ~1073 ms after the epoch. The two
 * read the same, so both mean "leave this time unchanged".
 */
function isUtimeMarker(ms: number): boolean {
    return ms >= 0 && ms < 2000;
}

/**
 * FUSE operation handlers backing the `~/ProtonDrive` mount. Only "My
 * Files" is exposed (no Trash/Devices/Shared/Photos in v1). Content is
 * fully materialized locally on open; changes are uploaded by
 * PendingUploads once the file has settled — see pendingUploads.ts.
 */
export interface FuseOperationsHandle {
    ops: Fuse.OPERATIONS;
    /** True if the path has changes that are not on Drive yet. */
    hasUnsavedChanges: (path: string) => boolean;
}

export function createFuseOperations(
    sdk: ProtonDriveClient,
    tree: DriveTree,
    content: ContentStore,
    pending: PendingUploads,
    logger: Logger,
): FuseOperationsHandle {
    const openFiles = new Map<number, OpenFile>();
    let nextFd = 1000;

    function register(file: OpenFile): number {
        const fd = nextFd++;
        openFiles.set(fd, file);
        return fd;
    }

    /** Open handles on `path` that still belong to a live file (not to one deleted while open). */
    function handlesOn(path: string): OpenFile[] {
        return [...openFiles.values()].filter((file) => file.path === path && !file.entry?.cancelled);
    }

    /** Starts a pending revision of the Drive file at `path`, shared by every handle open on it. */
    function startRevision(path: string, node: NodeEntity, parentUid: string, name: string): PendingUpload {
        const handles = handlesOn(path);
        const entry = pending.beginRevision(path, node, parentUid, name, handles.length);
        for (const handle of handles) {
            handle.entry = entry;
        }
        return entry;
    }

    /** After a write or truncate through `file`: make sure its content gets uploaded. */
    async function markDirty(file: OpenFile): Promise<void> {
        if (file.entry?.cancelled) {
            return; // deleted while open: like any unlinked file, the writes go nowhere
        }
        const current = pending.get(file.path);
        if (current) {
            file.entry = current;
            pending.touched(current);
            return;
        }
        // On Drive only: this change starts a new revision of it.
        const node = file.entry === undefined && file.node ? file.node : await tree.resolve(file.path);
        const raced = pending.get(file.path); // a concurrent write may have started it meanwhile
        if (raced) {
            file.entry = raced;
            pending.touched(raced);
            return;
        }
        startRevision(file.path, node, file.parentUid, file.name);
    }

    /** Resolves if `path` exists, as a pending file or on Drive. */
    async function requireExists(path: string): Promise<void> {
        if (path !== '/' && !pending.has(path)) {
            await tree.resolve(path);
        }
    }

    async function trash(uid: string): Promise<void> {
        await drain(sdk.trashNodes([uid]));
        tree.forgetNode(uid);
        await content.forget(uid);
    }

    /** Drops the pending entry at `path` (PendingUploads trashes anything its upload put on Drive anyway). */
    async function cancelPending(path: string): Promise<void> {
        await pending.cancel(path);
    }

    function retargetHandles(src: string, dest: string, parentUid: string, name: string): void {
        for (const file of openFiles.values()) {
            if (file.path === src) {
                file.path = dest;
                file.parentUid = parentUid;
                file.name = name;
            } else if (file.path.startsWith(`${src}/`)) {
                file.path = dest + file.path.slice(src.length);
            }
        }
    }

    const ops: Fuse.OPERATIONS = {
        getattr(path, cb) {
            if (path === '/') {
                cb(0, {
                    mtime: new Date(),
                    atime: new Date(),
                    ctime: new Date(),
                    nlink: 1,
                    size: 4096,
                    mode: fsConstants.S_IFDIR | 0o755,
                    uid: process.getuid ? process.getuid() : 0,
                    gid: process.getgid ? process.getgid() : 0,
                } as Fuse.Stats);
                return;
            }
            const entry = pending.get(path);
            if (entry) {
                entry.ready
                    .then(() => fsStat(entry.localPath))
                    .then(statForLocal)
                    // Landed and moved into the content cache meanwhile: Drive has it now.
                    .catch(() => tree.resolve(path).then(statFor))
                    .then(
                        (stat) => cb(0, stat),
                        (err) => cb(errnoFor(err)),
                    );
                return;
            }
            tree
                .resolve(path)
                .then((node) => cb(0, statFor(node)))
                .catch((err) => cb(errnoFor(err)));
        },

        readdir(path, cb) {
            (path === '/' ? tree.getRootUid() : tree.resolve(path).then((n) => n.uid))
                .then(async (parentUid) => {
                    const names = new Set((await tree.listChildren(parentUid)).keys());
                    // Files not on Drive yet are listed too.
                    for (const entry of pending.inFolder(parentUid)) {
                        names.add(entry.name);
                    }
                    cb(0, [...names]);
                })
                .catch((err) => cb(errnoFor(err)));
        },

        open(path, _flags, cb) {
            // A pending file (just created, or changed and not uploaded yet) is
            // served from its local copy, and the open handle holds off its
            // upload until it is closed. This also covers the
            // create→close→reopen-to-write idiom of xdg-document-portal and
            // Chromium downloads.
            const entry = pending.get(path);
            if (entry) {
                pending.opened(entry);
                entry.ready
                    .then(() => fsOpen(entry.localPath, 'r+'))
                    .then((handle) =>
                        cb(0, register({ path, handle, parentUid: entry.parentUid, name: entry.name, entry })),
                    )
                    .catch((err) => {
                        pending.closed(entry);
                        cb(errnoFor(err));
                    });
                return;
            }
            tree
                .resolve(path)
                .then(async (node) => {
                    const localPath = await content.ensureDownloaded(node);
                    const { parent, name } = await tree.resolveParent(path);
                    const handle = await fsOpen(localPath, 'r+');
                    cb(0, register({ path, handle, node, parentUid: parent.uid, name }));
                })
                .catch((err) => cb(errnoFor(err)));
        },

        create(path, _mode, cb) {
            tree
                .resolveParent(path)
                .then(async ({ parent, name }) => {
                    const entry = await pending.createNew(path, parent.uid, name);
                    const handle = await fsOpen(entry.localPath, 'r+');
                    cb(0, register({ path, handle, parentUid: parent.uid, name, entry }));
                })
                .catch((err) => cb(errnoFor(err)));
        },

        read(_path, fd, buffer, length, position, cb) {
            const file = openFiles.get(fd);
            if (!file) {
                cb(Fuse.EBADF);
                return;
            }
            file.handle
                .read(buffer, 0, length, position)
                .then((res) => cb(res.bytesRead))
                .catch(() => cb(0));
        },

        write(_path, fd, buffer, length, position, cb) {
            const file = openFiles.get(fd);
            if (!file) {
                cb(Fuse.EBADF);
                return;
            }
            file.handle
                .write(buffer, 0, length, position)
                .then(async (res) => {
                    await markDirty(file);
                    cb(res.bytesWritten);
                })
                .catch((err) => {
                    logger.error(`Write to ${file.path} failed`, err);
                    cb(errnoFor(err));
                });
        },

        ftruncate(_path, fd, size, cb) {
            const file = openFiles.get(fd);
            if (!file) {
                cb(Fuse.EBADF);
                return;
            }
            file.handle
                .truncate(size)
                .then(() => markDirty(file))
                .then(() => cb(0))
                .catch((err) => cb(errnoFor(err)));
        },

        truncate(path, size, cb) {
            // Without a handle (e.g. `truncate -s`, or O_TRUNC on reopen, which
            // the kernel sends as its own call). On a file already on Drive it
            // starts a pending revision, like a write.
            (async () => {
                let entry = pending.get(path);
                if (!entry) {
                    const node = await tree.resolve(path);
                    await content.ensureDownloaded(node);
                    const { parent, name } = await tree.resolveParent(path);
                    entry = pending.get(path) ?? startRevision(path, node, parent.uid, name);
                }
                await entry.ready;
                await fsTruncate(entry.localPath, size);
                pending.touched(entry);
            })().then(
                () => cb(0),
                (err) => cb(errnoFor(err)),
            );
        },

        release(_path, fd, cb) {
            const file = openFiles.get(fd);
            if (!file) {
                cb(0);
                return;
            }
            openFiles.delete(fd);
            file.handle
                .close()
                .catch(() => {})
                .then(() => {
                    // The kernel returned from close() before sending this, so the
                    // upload never happens here: it waits for the settle window
                    // (pendingUploads.ts), where a following utimens or rename
                    // still counts.
                    if (file.entry && pending.get(file.path) === file.entry) {
                        pending.closed(file.entry);
                    }
                    cb(0);
                });
        },

        utimens(path, atime, mtime, cb) {
            const entry = pending.get(path);
            if (entry) {
                (async () => {
                    await entry.ready;
                    const local = await fsStat(entry.localPath);
                    // fuse-native passes milliseconds, whatever its typings say.
                    const at = Number(atime);
                    const mt = Number(mtime);
                    await fsUtimes(
                        entry.localPath,
                        isUtimeMarker(at) ? local.atime : new Date(at),
                        isUtimeMarker(mt) ? local.mtime : new Date(mt),
                    );
                    pending.touched(entry);
                })().then(
                    () => cb(0),
                    (err) => cb(errnoFor(err)),
                );
                return;
            }
            // On Drive already: a claimed time can only change with a new
            // revision (a folder's only at creation). Accept and ignore, as
            // an error would fail every `rsync -t` and `cp -p` over files
            // already uploaded.
            requireExists(path).then(
                () => cb(0),
                (err) => cb(errnoFor(err)),
            );
        },

        // Drive has no POSIX modes or owners. Refuse rather than pretend, so
        // callers see the change did not happen; sync with `rsync -rlt`.
        chmod(path, _mode, cb) {
            requireExists(path).then(
                () => cb(Fuse.EPERM),
                (err) => cb(errnoFor(err)),
            );
        },

        chown(path, _uid, _gid, cb) {
            requireExists(path).then(
                () => cb(Fuse.EPERM),
                (err) => cb(errnoFor(err)),
            );
        },

        mkdir(path, _mode, cb) {
            tree
                .resolveParent(path)
                .then(async ({ parent, name }) => {
                    await sdk.createFolder(parent.uid, name);
                    tree.invalidate(parent.uid);
                    cb(0);
                })
                .catch((err) => cb(errnoFor(err)));
        },

        unlink(path, cb) {
            (async () => {
                const { parent } = await tree.resolveParent(path);
                const entry = pending.get(path);
                if (entry) {
                    await cancelPending(path);
                    if (entry.kind === 'revision' && entry.nodeUid) {
                        await trash(entry.nodeUid);
                    }
                } else {
                    await trash((await tree.resolve(path)).uid);
                }
                tree.invalidate(parent.uid);
            })().then(
                () => cb(0),
                (err) => cb(errnoFor(err)),
            );
        },

        rmdir(path, cb) {
            (async () => {
                const [node, { parent }] = await Promise.all([tree.resolve(path), tree.resolveParent(path)]);
                // Drive trashes a folder together with everything in it; rmdir
                // must only ever remove an empty one.
                const children = await tree.listChildren(node.uid);
                if (children.size > 0 || pending.inFolder(node.uid).length > 0) {
                    throw Object.assign(new Error(`${path} is not empty`), { code: 'ENOTEMPTY' });
                }
                await drain(sdk.trashNodes([node.uid]));
                tree.forgetNode(node.uid);
                tree.invalidate(parent.uid);
            })().then(
                () => cb(0),
                (err) => cb(errnoFor(err)),
            );
        },

        rename(src, dest, cb) {
            (async () => {
                const destCtx = await tree.resolveParent(dest);
                const srcEntry = pending.get(src);
                const destEntry = pending.get(dest);

                if (srcEntry?.kind === 'new') {
                    // Not on Drive yet: rsync's temp file, a download's .part
                    // file, or GLib's g_file_replace_contents save (which
                    // renames while its write handle is still open). The
                    // rename stays local; the upload goes out under the final
                    // name.
                    let revisionOf: { nodeUid: string; baseRevisionUid?: string } | undefined;
                    if (destEntry) {
                        if (destEntry.kind === 'revision' && destEntry.nodeUid) {
                            revisionOf = { nodeUid: destEntry.nodeUid, baseRevisionUid: destEntry.baseRevisionUid };
                        }
                        await cancelPending(dest);
                    } else {
                        const existing = await tree.resolve(dest).catch(() => undefined);
                        if (existing) {
                            // Replacing a file already on Drive: upload a new
                            // revision of it, keeping its history, rather than
                            // trashing it and starting over.
                            revisionOf = { nodeUid: existing.uid, baseRevisionUid: existing.activeRevision?.uid };
                            await content.forget(existing.uid);
                        }
                    }
                    pending.move(src, dest, destCtx.parent.uid, destCtx.name, revisionOf);
                    retargetHandles(src, dest, destCtx.parent.uid, destCtx.name);
                    return;
                }

                const [node, srcCtx] = await Promise.all([tree.resolve(src), tree.resolveParent(src)]);
                if (destEntry) {
                    await cancelPending(dest);
                }
                // POSIX rename() atomically replaces an existing destination.
                const existingDest = await tree.resolve(dest).catch(() => undefined);
                if (existingDest && existingDest.uid !== node.uid) {
                    await trash(existingDest.uid);
                }
                if (srcCtx.parent.uid !== destCtx.parent.uid) {
                    await drain(sdk.moveNodes([node.uid], destCtx.parent.uid));
                }
                if (srcCtx.name !== destCtx.name) {
                    await sdk.renameNode(node.uid, destCtx.name);
                }
                tree.invalidate(srcCtx.parent.uid, destCtx.parent.uid);
                if (srcEntry) {
                    pending.move(src, dest, destCtx.parent.uid, destCtx.name); // the revision follows its node
                }
                if (node.type === NodeType.Folder) {
                    pending.moveFolder(src, dest);
                }
                retargetHandles(src, dest, destCtx.parent.uid, destCtx.name);
            })().then(
                () => cb(0),
                (err) => cb(errnoFor(err)),
            );
        },
    };

    return { ops, hasUnsavedChanges: (path) => pending.has(path) };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
    for await (const _item of iterable) {
        // Consume the async generator so the operation actually executes.
    }
}

function errnoFor(err: unknown): number {
    if (err instanceof NodeNotFoundError) {
        return Fuse.ENOENT;
    }
    // Local errors (ENOENT, ENOTEMPTY, EEXIST, ...) keep their meaning.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const value = typeof code === 'string' ? (Fuse as unknown as Record<string, unknown>)[code] : undefined;
    return typeof value === 'number' ? value : Fuse.EIO;
}
