/**
 * In-memory stand-in for the slice of ProtonDriveClient the mount uses.
 * Keeps a tree of folders and files with the SDK's two times per node (the
 * server ModifyTime, which ticks on every change, and the claimed time an
 * upload stores), records every upload, and can hold uploads in flight,
 * fail the next one, or edit a file "from another client".
 */
import { createHash } from 'node:crypto';

import {
    AbortError,
    IntegrityError,
    MemberRole,
    NodeType,
    NodeWithSameNameExistsValidationError,
    ValidationError,
} from '@protontech/drive-sdk';
import type {
    MaybeMissingNode,
    NodeEntity,
    NodeOrUid,
    NodeResult,
    ProtonDriveClient,
    UploadMetadata,
} from '@protontech/drive-sdk';

interface FakeNode {
    uid: string;
    parentUid?: string;
    name: string;
    type: NodeType;
    /** Server-side link ModifyTime: changes on every mutation, rename and move included. */
    modificationTime: Date;
    claimedModificationTime?: Date;
    content: Buffer;
    revisionUid?: string;
    trashed: boolean;
}

export interface UploadRecord {
    kind: 'new' | 'revision';
    nodeUid: string;
    revisionUid: string;
    parentUid: string;
    name: string;
    claimedModificationTime?: Date;
    size: number;
    sha1: string;
}

function uidOf(node: NodeOrUid): string {
    return typeof node === 'string' ? node : node.uid;
}

function sha1(data: Buffer): string {
    return createHash('sha1').update(data).digest('hex');
}

export class FakeDrive {
    readonly rootUid = 'root';
    /** Every completed upload, oldest first. */
    readonly uploads: UploadRecord[] = [];
    /** Uploads between uploadFromStream() and the end of completion(). */
    inFlight = 0;
    /**
     * A held upload ignores its abort signal: it waits for release, then
     * commits and succeeds, as when the server finishes an upload just as
     * the client aborts it.
     */
    commitDespiteAbort = false;

    private readonly nodes = new Map<string, FakeNode>();
    private nextId = 1;
    /** Server clock: 2030-01-01, one second per mutation, so it never equals a claimed time by accident. */
    private serverTime = Date.UTC(2030, 0, 1);
    private hold?: Promise<void>;
    private readonly failures: Error[] = [];

    constructor() {
        this.nodes.set(this.rootUid, {
            uid: this.rootUid,
            name: 'My files',
            type: NodeType.Folder,
            modificationTime: this.tick(),
            content: Buffer.alloc(0),
            trashed: false,
        });
    }

    /** This fake, typed as the SDK client the code under test expects. */
    get client(): ProtonDriveClient {
        return this as unknown as ProtonDriveClient;
    }

    // ── test controls ────────────────────────────────────────────────────

    addFolder(parentUid: string, name: string, claimedModificationTime?: Date): string {
        return this.add(parentUid, name, NodeType.Folder, Buffer.alloc(0), claimedModificationTime).uid;
    }

    addFile(parentUid: string, name: string, content: string, claimedModificationTime?: Date): string {
        return this.add(parentUid, name, NodeType.File, Buffer.from(content), claimedModificationTime).uid;
    }

    /** Another client uploads a new revision of `uid`. */
    remoteEdit(uid: string, content: string, claimedModificationTime?: Date): void {
        const node = this.live(uid);
        node.content = Buffer.from(content);
        node.claimedModificationTime = claimedModificationTime;
        node.revisionUid = this.newUid('rev');
        node.modificationTime = this.tick();
    }

    /** The uid at `path` (e.g. '/docs/a.txt'), skipping trashed nodes. */
    find(path: string): string | undefined {
        let uid = this.rootUid;
        for (const name of path.split('/').filter(Boolean)) {
            const child = this.childNamed(uid, name);
            if (!child) {
                return undefined;
            }
            uid = child.uid;
        }
        return uid;
    }

    contentOf(uid: string): string {
        return this.live(uid).content.toString();
    }

    isTrashed(uid: string): boolean {
        return this.nodes.get(uid)?.trashed ?? false;
    }

    /** Uploads wait just before they complete until the returned function is called, or their signal aborts. */
    holdUploads(): () => void {
        let release!: () => void;
        this.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        return () => {
            this.hold = undefined;
            release();
        };
    }

    /** The next upload to complete fails with `error` instead. */
    failNextUpload(error: Error): void {
        this.failures.push(error);
    }

    // ── ProtonDriveClient ────────────────────────────────────────────────

    async getMyFilesRootFolder(): Promise<NodeEntity> {
        return this.entity(this.live(this.rootUid));
    }

    async *iterateFolderChildrenNodeUids(parent: NodeOrUid): AsyncGenerator<string> {
        for (const node of this.children(uidOf(parent))) {
            yield node.uid;
        }
    }

    async *iterateNodes(uids: NodeOrUid[]): AsyncGenerator<MaybeMissingNode> {
        for (const uid of uids.map(uidOf)) {
            const node = this.nodes.get(uid);
            yield node && !node.trashed ? this.entity(node) : { missingUid: uid };
        }
    }

    /** Like the SDK: a trashed node is still returned (with trashTime); an unknown one is an error. */
    async getNode(uid: NodeOrUid): Promise<NodeEntity> {
        const node = this.nodes.get(uidOf(uid));
        if (!node) {
            throw new ValidationError('Node not found', 2501);
        }
        return this.entity(node);
    }

    async createFolder(parent: NodeOrUid, name: string, modificationTime?: Date): Promise<NodeEntity> {
        return this.entity(this.add(uidOf(parent), name, NodeType.Folder, Buffer.alloc(0), modificationTime));
    }

    async renameNode(uid: NodeOrUid, newName: string): Promise<NodeEntity> {
        const node = this.live(uidOf(uid));
        this.assertNameFree(node.parentUid ?? this.rootUid, newName);
        node.name = newName;
        node.modificationTime = this.tick();
        return this.entity(node);
    }

    async *moveNodes(uids: NodeOrUid[], newParent: NodeOrUid): AsyncGenerator<NodeResult> {
        for (const uid of uids.map(uidOf)) {
            const node = this.live(uid);
            this.assertNameFree(uidOf(newParent), node.name);
            node.parentUid = uidOf(newParent);
            node.modificationTime = this.tick();
            yield { uid, ok: true } as NodeResult;
        }
    }

    async *trashNodes(uids: NodeOrUid[]): AsyncGenerator<NodeResult> {
        for (const uid of uids.map(uidOf)) {
            const node = this.live(uid);
            node.trashed = true;
            node.modificationTime = this.tick();
            yield { uid, ok: true } as NodeResult;
        }
    }

    async getFileDownloader(uid: NodeOrUid) {
        const data = new Uint8Array(this.live(uidOf(uid)).content);
        return {
            downloadToStream: (stream: WritableStream<Uint8Array>) => ({
                completion: async () => {
                    const writer = stream.getWriter();
                    await writer.write(data);
                    await writer.close();
                },
            }),
        };
    }

    async getFileUploader(parent: NodeOrUid, name: string, metadata: UploadMetadata, signal?: AbortSignal) {
        if (signal?.aborted) {
            throw new AbortError();
        }
        const parentUid = uidOf(parent);
        this.live(parentUid);
        return this.uploader(metadata, signal, (data) => {
            const node = this.add(parentUid, name, NodeType.File, data, metadata.modificationTime);
            return this.record('new', node, data);
        });
    }

    async getFileRevisionUploader(uid: NodeOrUid, metadata: UploadMetadata, signal?: AbortSignal) {
        if (signal?.aborted) {
            throw new AbortError();
        }
        const nodeUid = uidOf(uid);
        this.live(nodeUid);
        return this.uploader(metadata, signal, (data) => {
            const node = this.live(nodeUid);
            node.content = data;
            node.claimedModificationTime = metadata.modificationTime;
            node.revisionUid = this.newUid('rev');
            node.modificationTime = this.tick();
            return this.record('revision', node, data);
        });
    }

    // ── internals ────────────────────────────────────────────────────────

    private uploader(
        metadata: UploadMetadata,
        signal: AbortSignal | undefined,
        commit: (data: Buffer) => { nodeUid: string; nodeRevisionUid: string },
    ) {
        return {
            uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
                this.inFlight++;
                let data: Buffer;
                try {
                    const chunks: Buffer[] = [];
                    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
                        chunks.push(Buffer.from(chunk));
                    }
                    data = Buffer.concat(chunks);
                } catch (error) {
                    this.inFlight--;
                    throw error;
                }
                return {
                    pause() {},
                    resume() {},
                    completion: async () => {
                        try {
                            await this.waitForRelease(signal);
                            const failure = this.failures.shift();
                            if (failure) {
                                throw failure;
                            }
                            if (metadata.expectedSize !== null && data.length !== metadata.expectedSize) {
                                throw new IntegrityError('Uploaded size does not match the expected size');
                            }
                            return commit(data);
                        } finally {
                            this.inFlight--;
                        }
                    },
                };
            },
        };
    }

    private async waitForRelease(signal?: AbortSignal): Promise<void> {
        const hold = this.hold;
        if (hold && this.commitDespiteAbort) {
            return hold;
        }
        if (signal?.aborted) {
            throw new AbortError();
        }
        if (!hold) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(new AbortError());
            signal?.addEventListener('abort', onAbort, { once: true });
            void hold.then(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            });
        });
    }

    private record(kind: 'new' | 'revision', node: FakeNode, data: Buffer) {
        const revisionUid = node.revisionUid as string;
        this.uploads.push({
            kind,
            nodeUid: node.uid,
            revisionUid,
            parentUid: node.parentUid ?? this.rootUid,
            name: node.name,
            claimedModificationTime: node.claimedModificationTime,
            size: data.length,
            sha1: sha1(data),
        });
        return { nodeUid: node.uid, nodeRevisionUid: revisionUid };
    }

    private add(parentUid: string, name: string, type: NodeType, content: Buffer, claimed?: Date): FakeNode {
        this.live(parentUid);
        this.assertNameFree(parentUid, name);
        const isFile = type === NodeType.File;
        const node: FakeNode = {
            uid: this.newUid(isFile ? 'file' : 'folder'),
            parentUid,
            name,
            type,
            modificationTime: this.tick(),
            claimedModificationTime: claimed,
            content,
            revisionUid: isFile ? this.newUid('rev') : undefined,
            trashed: false,
        };
        this.nodes.set(node.uid, node);
        return node;
    }

    private assertNameFree(parentUid: string, name: string): void {
        const existing = this.childNamed(parentUid, name);
        if (existing) {
            throw new NodeWithSameNameExistsValidationError(
                'A file or folder with that name already exists',
                2500,
                existing.uid,
            );
        }
    }

    private children(parentUid: string): FakeNode[] {
        return [...this.nodes.values()].filter((node) => node.parentUid === parentUid && !node.trashed);
    }

    private childNamed(parentUid: string, name: string): FakeNode | undefined {
        return this.children(parentUid).find((node) => node.name === name);
    }

    private live(uid: string): FakeNode {
        const node = this.nodes.get(uid);
        if (!node || node.trashed) {
            throw new ValidationError('Node not found', 2501);
        }
        return node;
    }

    private newUid(prefix: string): string {
        return `${prefix}-${this.nextId++}`;
    }

    private tick(): Date {
        this.serverTime += 1000;
        return new Date(this.serverTime);
    }

    private entity(node: FakeNode): NodeEntity {
        const isFile = node.type === NodeType.File;
        return {
            uid: node.uid,
            parentUid: node.parentUid,
            name: { ok: true, value: node.name },
            type: node.type,
            directRole: MemberRole.Admin,
            isShared: false,
            isSharedByUrl: false,
            creationTime: node.modificationTime,
            modificationTime: node.modificationTime,
            trashTime: node.trashed ? node.modificationTime : undefined,
            treeEventScopeId: 'fake-scope',
            activeRevision: isFile
                ? {
                      uid: node.revisionUid,
                      creationTime: node.modificationTime,
                      storageSize: node.content.length,
                      claimedSize: node.content.length,
                      claimedModificationTime: node.claimedModificationTime,
                      claimedDigests: { sha1: sha1(node.content), sha1Verified: true },
                  }
                : undefined,
            folder: isFile ? undefined : { claimedModificationTime: node.claimedModificationTime, isImported: false },
        } as unknown as NodeEntity;
    }
}
