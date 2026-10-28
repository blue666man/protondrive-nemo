import { constants as fsConstants } from 'node:fs';
import { open as fsOpen, stat as fsStat, truncate as fsTruncate, type FileHandle } from 'node:fs/promises';

import Fuse from '@cocalc/fuse-native';
import { MemberRole, NodeType } from '@protontech/drive-sdk';
import type { Logger, NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';

import type { CachePolicy } from './cachePolicy';
import { ContentStore } from './contentStore';
import { DriveTree, NodeNotFoundError } from './driveTree';

interface OpenFile {
    path: string;
    node: NodeEntity;
    localPath: string;
    handle: FileHandle;
    dirty: boolean;
    isNewFile: boolean;
    /** True when the policy says this file's content must not persist locally; removed when the last handle closes. */
    ephemeral: boolean;
    parentUid: string;
    name: string;
}

/**
 * Shared, ref-counted state for a path that's been create()'d but not yet
 * uploaded, tracked across every fd opened against it (not just the
 * original creator's). Some writers — the xdg-document-portal, and
 * Chromium's own download code — create the file, close that fd almost
 * immediately with nothing written (a "claim the name" step), then reopen
 * the same path moments later to do the real writing. A single fd's
 * release() can't tell that apart from a genuine empty file (e.g. `touch`),
 * so finalizing is driven by refCount + a short grace window instead of by
 * any one fd's close.
 */
interface NewFileState {
    parentUid: string;
    name: string;
    localPath: string;
    node: NodeEntity;
    dirty: boolean;
    refCount: number;
    finalizeTimer: NodeJS.Timeout | null;
}

function statFor(node: NodeEntity): Fuse.Stats {
    const isFolder = node.type === NodeType.Folder;
    const size = isFolder ? 4096 : (node.activeRevision?.claimedSize ?? 0);
    const mtime = node.modificationTime ?? new Date();
    const uid = process.getuid ? process.getuid() : 0;
    const gid = process.getgid ? process.getgid() : 0;
    return {
        mtime,
        atime: mtime,
        ctime: mtime,
        nlink: 1,
        size,
        mode: isFolder ? fsConstants.S_IFDIR | 0o755 : fsConstants.S_IFREG | 0o644,
        uid,
        gid,
    } as Fuse.Stats;
}

async function statForOpenFile(file: OpenFile): Promise<Fuse.Stats> {
    const local = await fsStat(file.localPath);
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

function placeholderNode(path: string, name: string): NodeEntity {
    return {
        uid: `pending:${path}`,
        name: { ok: true, value: name },
        type: NodeType.File,
        keyAuthor: {} as NodeEntity['keyAuthor'],
        nameAuthor: {} as NodeEntity['nameAuthor'],
        directRole: MemberRole.Editor,
        ownedBy: {},
        isShared: false,
        isSharedByUrl: false,
        creationTime: new Date(),
        modificationTime: new Date(),
        treeEventScopeId: '',
    };
}

/**
 * FUSE operation handlers backing the `~/ProtonDrive` mount. Only "My
 * Files" is exposed (no Trash/Devices/Shared/Photos in v1). Content is
 * fully materialized locally on open and uploaded on release — see
 * contentStore.ts.
 */
export interface FuseOperationsHandle {
    ops: Fuse.OPERATIONS;
    /** True if the path has a locally open handle with changes not yet uploaded (dirty write or brand-new file). */
    hasUnsavedChanges: (path: string) => boolean;
}

export function createFuseOperations(
    sdk: ProtonDriveClient,
    tree: DriveTree,
    content: ContentStore,
    policy: CachePolicy,
    logger: Logger,
): FuseOperationsHandle {
    const openFiles = new Map<number, OpenFile>();
    // Mirrors openFiles, keyed by path: a file that was just create()'d
    // doesn't exist as a Drive node yet (it's uploaded on release), but the
    // kernel calls getattr() on it immediately as part of completing the
    // create — this is how getattr answers for it in the meantime.
    const openFilesByPath = new Map<string, OpenFile>();
    // Keyed by path, one entry per path currently in "just created, not yet
    // uploaded" limbo — shared across every fd opened against that path.
    const newFileStates = new Map<string, NewFileState>();
    let nextFd = 1000;

    // Long enough to cover the create→close→reopen-to-write idiom observed
    // from both xdg-document-portal and Chromium's own download code
    // (reopen followed within single-digit milliseconds in practice), short
    // enough not to be perceptible for a genuine empty-file create.
    const NEW_FILE_FINALIZE_GRACE_MS = 500;

    async function openLocal(
        path: string,
        node: NodeEntity,
        localPath: string,
        extra: Omit<OpenFile, 'path' | 'node' | 'localPath' | 'handle'>,
    ): Promise<number> {
        const handle = await fsOpen(localPath, 'r+');
        const fd = nextFd++;
        const file: OpenFile = { path, node, localPath, handle, ...extra };
        openFiles.set(fd, file);
        openFilesByPath.set(path, file);
        return fd;
    }

    async function finalizeNewFile(path: string, state: NewFileState): Promise<void> {
        newFileStates.delete(path);
        try {
            const created = await content.uploadNewFile(state.parentUid, state.name, state.localPath);
            tree.rememberNode(created);
            tree.invalidate(state.parentUid);
            await content.forget(state.node.uid);
        } catch (err) {
            logger.error(`Failed to upload ${state.name} on release`, err);
        }
        const rep = openFilesByPath.get(path);
        if (rep && rep.node.uid === state.node.uid) {
            openFilesByPath.delete(path);
        }
    }

    /**
     * Removes a non-cacheable file's throwaway copy, but only once no other
     * handle (or pending create) still points at the same local file — the
     * kernel can have several fds open on one path.
     */
    async function evictIfUnused(file: OpenFile): Promise<void> {
        for (const other of openFiles.values()) {
            if (other.localPath === file.localPath) {
                return;
            }
        }
        const pending = newFileStates.get(file.path);
        if (pending && pending.localPath === file.localPath) {
            return;
        }
        await content
            .forget(file.node.uid)
            .catch((err) => logger.warn(`Failed to remove cached copy of ${file.name}: ${err}`));
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
            const openFile = openFilesByPath.get(path);
            if (openFile) {
                statForOpenFile(openFile)
                    .then((stat) => cb(0, stat))
                    .catch((err) => cb(errnoFor(err)));
                return;
            }
            tree
                .resolve(path)
                .then((node) => cb(0, statFor(node)))
                .catch((err) => cb(errnoFor(err)));
        },

        readdir(path, cb) {
            (path === '/' ? tree.getRootUid() : tree.resolve(path).then((n) => n.uid))
                .then((parentUid) => tree.listChildren(parentUid))
                .then((children) => cb(0, [...children.keys()]))
                .catch((err) => cb(errnoFor(err)));
        },

        open(path, _flags, cb) {
            // A file created moments ago may still be sitting in the
            // finalize grace window (or still uploading) — reopening it
            // should read/write the same local copy, not fail because it's
            // not a Drive node yet. Bumping refCount and clearing any
            // pending finalize timer means the eventual close of *this*
            // handle decides whether/when the upload actually happens.
            const state = newFileStates.get(path);
            if (state) {
                state.refCount++;
                if (state.finalizeTimer) {
                    clearTimeout(state.finalizeTimer);
                    state.finalizeTimer = null;
                }
                openLocal(path, state.node, state.localPath, {
                    dirty: false,
                    isNewFile: true,
                    ephemeral: false,
                    parentUid: state.parentUid,
                    name: state.name,
                })
                    .then((fd) => cb(0, fd))
                    .catch((err) => cb(errnoFor(err)));
                return;
            }
            tree
                .resolve(path)
                .then(async (node) => {
                    const ephemeral = !policy.isCacheable(path);
                    const localPath = await content.ensureDownloaded(node, { ephemeral });
                    const { parent, name } = await tree.resolveParent(path);
                    const fd = await openLocal(path, node, localPath, {
                        dirty: false,
                        isNewFile: false,
                        ephemeral,
                        parentUid: parent.uid,
                        name,
                    });
                    cb(0, fd);
                })
                .catch((err) => cb(errnoFor(err)));
        },

        create(path, _mode, cb) {
            tree
                .resolveParent(path)
                .then(async ({ parent, name }) => {
                    const node = placeholderNode(path, name);
                    const localPath = await content.createEmptyLocal(node.uid, {
                        ephemeral: !policy.isCacheable(path),
                    });
                    const state: NewFileState = {
                        parentUid: parent.uid,
                        name,
                        localPath,
                        node,
                        dirty: false,
                        refCount: 1,
                        finalizeTimer: null,
                    };
                    newFileStates.set(path, state);
                    const fd = await openLocal(path, node, localPath, {
                        dirty: false,
                        isNewFile: true,
                        ephemeral: false,
                        parentUid: parent.uid,
                        name,
                    });
                    cb(0, fd);
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
                .then((res) => {
                    file.dirty = true;
                    const state = newFileStates.get(file.path);
                    if (state) {
                        state.dirty = true;
                    }
                    cb(res.bytesWritten);
                })
                .catch(() => cb(0));
        },

        ftruncate(_path, fd, size, cb) {
            const file = openFiles.get(fd);
            if (!file) {
                cb(Fuse.EBADF);
                return;
            }
            file.handle
                .truncate(size)
                .then(() => {
                    file.dirty = true;
                    const state = newFileStates.get(file.path);
                    if (state) {
                        state.dirty = true;
                    }
                    cb(0);
                })
                .catch((err) => cb(errnoFor(err)));
        },

        truncate(path, size, cb) {
            // A reopen with O_TRUNC of a still-pending new file arrives here
            // (the kernel issues this as a separate call after open()) — it
            // isn't a real Drive node yet, so tree.resolve() would 404.
            const state = newFileStates.get(path);
            if (state) {
                fsTruncate(state.localPath, size)
                    .then(() => {
                        state.dirty = true;
                        cb(0);
                    })
                    .catch((err) => cb(errnoFor(err)));
                return;
            }
            tree
                .resolve(path)
                .then((node) => content.ensureDownloaded(node, { ephemeral: !policy.isCacheable(path) }))
                .then((localPath) => fsTruncate(localPath, size))
                .then(() => cb(0))
                .catch((err) => cb(errnoFor(err)));
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
                .then(async () => {
                    if (!file.isNewFile) {
                        // Once this fd is closed, getattr()/open() must stop
                        // answering from this handle's local snapshot (via
                        // openFilesByPath) and fall back to tree.resolve()
                        // instead — otherwise a later evict of the local
                        // cache leaves them stat()ing/reading a file that no
                        // longer exists on disk. Guarded on identity in case
                        // another open() already replaced this path's entry.
                        const rep = openFilesByPath.get(file.path);
                        if (rep === file) {
                            openFilesByPath.delete(file.path);
                        }

                        try {
                            if (file.dirty) {
                                await content.uploadRevision(file.node, file.localPath);
                                tree.invalidate(file.parentUid);
                            }
                        } catch (err) {
                            logger.error(`Failed to upload ${file.name} on release`, err);
                            cb(errnoFor(err));
                            return;
                        }
                        // A non-cacheable file (outside the allowlist, or
                        // ephemeral mode) only needs its decrypted copy while
                        // it is open; drop it now that the last handle closed.
                        if (file.ephemeral) {
                            await evictIfUnused(file);
                        }
                        cb(0);
                        return;
                    }

                    const state = newFileStates.get(file.path);
                    if (!state || state.node.uid !== file.node.uid) {
                        // Already finalized (or superseded) by another handle.
                        cb(0);
                        return;
                    }
                    state.refCount = Math.max(0, state.refCount - 1);
                    if (state.refCount > 0) {
                        cb(0);
                        return;
                    }
                    if (state.dirty) {
                        // Real content was written before this close — finalize
                        // now, and hold the close() acknowledgement until it's
                        // actually resolvable on Drive. A writer that renames
                        // this path right after closing it (e.g. a browser's
                        // .crdownload -> final-name rename) must not race ahead
                        // of the upload finishing.
                        await finalizeNewFile(file.path, state);
                        cb(0);
                    } else {
                        // Still empty: either a genuine `touch`, or a writer
                        // that's about to reopen this same path to write the
                        // real content (document portal / Chromium download
                        // idiom). The kernel doesn't wait for this callback to
                        // complete a close() syscall, so ack it right away — a
                        // reopen needs that to happen — and decide later,
                        // after a brief grace window, whether to upload it as
                        // an empty file.
                        cb(0);
                        state.finalizeTimer = setTimeout(() => {
                            finalizeNewFile(file.path, state);
                        }, NEW_FILE_FINALIZE_GRACE_MS);
                    }
                });
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
            Promise.all([tree.resolve(path), tree.resolveParent(path)])
                .then(async ([node, { parent }]) => {
                    await drain(sdk.trashNodes([node.uid]));
                    tree.forgetNode(node.uid);
                    tree.invalidate(parent.uid);
                    await content.forget(node.uid);
                    cb(0);
                })
                .catch((err) => cb(errnoFor(err)));
        },

        rmdir(path, cb) {
            Promise.all([tree.resolve(path), tree.resolveParent(path)])
                .then(async ([node, { parent }]) => {
                    await drain(sdk.trashNodes([node.uid]));
                    tree.forgetNode(node.uid);
                    tree.invalidate(parent.uid);
                    cb(0);
                })
                .catch((err) => cb(errnoFor(err)));
        },

        rename(src, dest, cb) {
            (async () => {
                // If dest is a pending, not-yet-uploaded placeholder (e.g. a
                // downloader pre-creating the final filename before writing
                // the real content to a separate temp name), it's about to
                // be superseded — drop it rather than let it upload later as
                // an orphan empty file.
                const destPending = newFileStates.get(dest);
                if (destPending) {
                    if (destPending.finalizeTimer) {
                        clearTimeout(destPending.finalizeTimer);
                    }
                    newFileStates.delete(dest);
                    await content.forget(destPending.node.uid).catch(() => {});
                }

                // If src is itself a pending, not-yet-uploaded placeholder,
                // there's no Drive node yet for tree.resolve(src) to find —
                // GLib's g_file_replace_contents (gedit/GNOME Text Editor's
                // save path) issues RENAME while its temp file's write
                // handle is still open, well before the eventual close()
                // that would otherwise finalize and upload it. Re-target the
                // in-flight state onto `dest` instead of resolving; the
                // eventual close uploads it under the new name/location.
                const srcPending = newFileStates.get(src);
                if (srcPending) {
                    const destCtx = await tree.resolveParent(dest);
                    const existingDest = await tree.resolve(dest).catch(() => undefined);
                    if (existingDest) {
                        await drain(sdk.trashNodes([existingDest.uid]));
                        tree.forgetNode(existingDest.uid);
                    }

                    newFileStates.delete(src);
                    srcPending.parentUid = destCtx.parent.uid;
                    srcPending.name = destCtx.name;
                    newFileStates.set(dest, srcPending);

                    const openRep = openFilesByPath.get(src);
                    if (openRep) {
                        openFilesByPath.delete(src);
                        openFilesByPath.set(dest, openRep);
                    }
                    for (const file of openFiles.values()) {
                        if (file.path === src) {
                            file.path = dest;
                            file.parentUid = destCtx.parent.uid;
                            file.name = destCtx.name;
                        }
                    }

                    tree.invalidate(destCtx.parent.uid);
                    return;
                }

                const [node, srcCtx, destCtx] = await Promise.all([
                    tree.resolve(src),
                    tree.resolveParent(src),
                    tree.resolveParent(dest),
                ]);

                // POSIX rename() atomically replaces an existing destination.
                // If a different, already-uploaded node currently sits at
                // dest (e.g. that same placeholder, already finalized by the
                // time this rename arrived), trash it so we don't end up
                // with two nodes sharing the same name.
                const existingDest = await tree.resolve(dest).catch(() => undefined);
                if (existingDest && existingDest.uid !== node.uid) {
                    await drain(sdk.trashNodes([existingDest.uid]));
                    tree.forgetNode(existingDest.uid);
                }

                if (srcCtx.parent.uid !== destCtx.parent.uid) {
                    await drain(sdk.moveNodes([node.uid], destCtx.parent.uid));
                }
                if (srcCtx.name !== destCtx.name) {
                    await sdk.renameNode(node.uid, destCtx.name);
                }
                tree.invalidate(srcCtx.parent.uid, destCtx.parent.uid);
            })()
                .then(() => cb(0))
                .catch((err) => cb(errnoFor(err)));
        },
    };

    function hasUnsavedChanges(path: string): boolean {
        const file = openFilesByPath.get(path);
        return !!file && (file.dirty || file.isNewFile);
    }

    return { ops, hasUnsavedChanges };
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
    return Fuse.EIO;
}
