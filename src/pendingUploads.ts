import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    DecryptionError,
    IntegrityError,
    NodeWithSameNameExistsValidationError,
    ServerError,
    ValidationError,
} from '@protontech/drive-sdk';
import type { Logger, NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';

import { conflictName } from './conflictName';
import type { ContentStore, UploadOptions } from './contentStore';
import type { DriveTree } from './driveTree';
import type { JournalRecord, PendingJournal, PendingKind } from './pendingJournal';

/**
 * - open: a file handle is open on it, so it can still change.
 * - settling: closed; uploads once `settleMs` pass without a further change.
 * - uploading: an upload attempt is running.
 * - retrying: the last attempt failed transiently; retried after a backoff.
 * - failed: the last attempt failed for good (e.g. quota); kept until the
 *   file is changed, renamed or deleted.
 * - stopped: the daemon is shutting down; the journal carries it over.
 */
export type PendingState = 'open' | 'settling' | 'uploading' | 'retrying' | 'failed' | 'stopped';

/** A change that is not on Drive yet: a new file, or a new revision of one. */
export interface PendingUpload {
    readonly id: string;
    kind: PendingKind;
    /** Path under the mount; follows renames. */
    path: string;
    parentUid: string;
    name: string;
    /** Revisions: the Drive file this content replaces. */
    nodeUid?: string;
    /** Revisions: that file's active revision when the change began. */
    baseRevisionUid?: string;
    /** The content, in the pending dir. */
    readonly localPath: string;
    /** Open file handles on it. */
    refCount: number;
    state: PendingState;
    attempts: number;
    error?: string;
    /** Resolves once `localPath` holds the content (a revision's copy is moved in asynchronously). */
    ready: Promise<void>;
    /** True once cancelled (deleted, or replaced by a rename): nothing of it may land any more. */
    cancelled: boolean;
    timer?: NodeJS.Timeout;
    abort?: AbortController;
    /** The running attempt. */
    running?: Promise<void>;
    /** What the running attempt uploads to, as it was when the attempt started. */
    target?: UploadTarget;
    changedDuringUpload: boolean;
    /** Serialises this entry's journal writes. */
    saved: Promise<void>;
    waiters: Array<(outcome: AttemptOutcome) => void>;
}

export type UploadTarget = Pick<PendingUpload, 'kind' | 'nodeUid' | 'parentUid' | 'name'>;

export type AttemptOutcome = 'uploaded' | 'failed' | 'retrying' | 'stopped' | 'cancelled';

export interface PendingStatus {
    /** Still open in some application. */
    open: number;
    /** Waiting for the settle window or a retry. */
    pending: number;
    uploading: number;
    failed: number;
    failures: Array<{ path: string; error: string }>;
}

export interface FlushResult {
    uploaded: number;
    failed: number;
    /** Failed transiently, or stopped by shutdown: still pending. */
    retrying: number;
    /** Not attempted: still open in some application. */
    open: number;
}

export interface PendingUploadsOptions {
    sdk: ProtonDriveClient;
    tree: DriveTree;
    content: ContentStore;
    journal: PendingJournal;
    logger: Logger;
    /** Quiet time after the last close, rename or utimens before uploading. */
    settleMs: number;
    /** First retry delay after a transient failure; doubles per attempt up to `retryMaxMs`. */
    retryBaseMs?: number;
    retryMaxMs?: number;
    /** Clock for conflict-copy names. */
    now?: () => Date;
}

/** How long shutdown waits for aborted uploads to wind down before journaling anyway. */
const ABORT_WAIT_MS = 2000;

/** `created`: `node` was made by this attempt (a new file or conflict copy), not found on Drive. */
type Landed = { node?: NodeEntity; revisionUid?: string; created?: boolean };
type Attempt = { landed: Landed } | { error: unknown; permanent: boolean };

/**
 * Holds every change that is not on Drive yet, and uploads it once the
 * file has been quiet for `settleMs`.
 *
 * FUSE `release` arrives after `close()` has already returned, so tools
 * like rsync (close, utimensat, rename onto the final name) and editors
 * (write a temp file, rename it over the original) keep changing a file
 * after closing it. Waiting for the settle window lets each file go up
 * once, under its final name, with its final time, and as a new revision
 * of the file it replaces (keeping that file's history).
 *
 * Every entry is journaled (pendingJournal.ts) from its first close, so
 * it survives unmount, crash and reboot; the next mount resumes it.
 */
export class PendingUploads {
    private readonly byPath = new Map<string, PendingUpload>();
    /**
     * nodeUid → the last revision we uploaded of it, so a revision that
     * landed after its entry moved on (cancelled, or changed) is not taken
     * for an edit by another client. An upload the server committed while
     * the client only saw AbortError is not known here: the next attempt
     * keeps both versions (a spurious conflict copy, never data loss).
     */
    private readonly ownRevisions = new Map<string, string>();
    private stopping = false;

    constructor(private readonly o: PendingUploadsOptions) {}

    get(filePath: string): PendingUpload | undefined {
        return this.byPath.get(filePath);
    }

    has(filePath: string): boolean {
        return this.byPath.has(filePath);
    }

    /** Pending files directly inside folder `parentUid` (readdir lists them before they reach Drive). */
    inFolder(parentUid: string): PendingUpload[] {
        return [...this.byPath.values()].filter((entry) => entry.parentUid === parentUid);
    }

    /** A file being created at `filePath`: an empty local file, held open by its creator. */
    async createNew(filePath: string, parentUid: string, name: string): Promise<PendingUpload> {
        if (this.byPath.has(filePath)) {
            throw Object.assign(new Error(`${filePath} already exists`), { code: 'EEXIST' });
        }
        const entry = this.register({ kind: 'new', path: filePath, parentUid, name, refCount: 1, state: 'open' });
        entry.ready = writeFile(entry.localPath, '', { mode: 0o600 });
        await entry.ready;
        return entry;
    }

    /**
     * The Drive file `node` at `filePath` is about to change. Its cached copy
     * (the file open handles write to) moves out of the content cache into
     * the pending dir, where evict and clear-cache can't delete it.
     * Registered synchronously, so concurrent writers find one entry.
     */
    beginRevision(filePath: string, node: NodeEntity, parentUid: string, name: string, refCount: number): PendingUpload {
        const entry = this.register({
            kind: 'revision',
            path: filePath,
            parentUid,
            name,
            nodeUid: node.uid,
            baseRevisionUid: node.activeRevision?.uid,
            refCount,
            state: 'open',
        });
        entry.ready = rename(this.o.content.localPathFor(node.uid), entry.localPath);
        entry.ready.catch((error) => this.o.logger.error(`Could not move ${name} into the pending dir`, error));
        if (refCount === 0) {
            this.settle(entry);
        }
        return entry;
    }

    /** A handle was opened on the entry: hold off uploading until it is closed. */
    opened(entry: PendingUpload): void {
        entry.refCount++;
        this.clearTimer(entry);
        if (entry.state === 'settling' || entry.state === 'retrying' || entry.state === 'stopped') {
            entry.state = 'open';
        }
    }

    /** A handle on the entry was closed; the last one starts the settle window. */
    closed(entry: PendingUpload): void {
        entry.refCount = Math.max(0, entry.refCount - 1);
        if (entry.refCount === 0 && entry.state === 'open') {
            this.settle(entry);
        }
    }

    /** The content or times changed: restart the settle window, or abort an upload of the old state. */
    touched(entry: PendingUpload): void {
        entry.attempts = 0;
        if (entry.state === 'uploading') {
            entry.changedDuringUpload = true;
            entry.abort?.abort();
        } else if (entry.refCount > 0) {
            entry.state = 'open';
        } else {
            this.settle(entry);
        }
    }

    /**
     * Renames the entry at `src` to `dest` (folder `parentUid`, as `name`).
     * With `revisionOf`, a new file renamed onto an existing Drive file
     * becomes a new revision of that file, keeping its history.
     * The caller clears `dest` first.
     */
    move(
        src: string,
        dest: string,
        parentUid: string,
        name: string,
        revisionOf?: { nodeUid: string; baseRevisionUid?: string },
    ): void {
        const entry = this.byPath.get(src);
        if (!entry) {
            return;
        }
        this.byPath.delete(src);
        entry.path = dest;
        entry.parentUid = parentUid;
        entry.name = name;
        this.byPath.set(dest, entry);
        if (revisionOf) {
            entry.kind = 'revision';
            entry.nodeUid = revisionOf.nodeUid;
            entry.baseRevisionUid = revisionOf.baseRevisionUid;
        }
        if (entry.kind === 'new' || revisionOf) {
            // What gets uploaded changed: settle again (or redo a running upload).
            this.touched(entry);
        } else {
            // A revision follows its Drive node, which the caller already moved.
            void this.save(entry);
        }
    }

    /** A folder was renamed: the entries below it keep their parent uids; only their paths change. */
    moveFolder(srcDir: string, destDir: string): void {
        for (const entry of [...this.byPath.values()]) {
            if (entry.path.startsWith(`${srcDir}/`)) {
                this.byPath.delete(entry.path);
                entry.path = destDir + entry.path.slice(srcDir.length);
                this.byPath.set(entry.path, entry);
                void this.save(entry);
            }
        }
    }

    /**
     * Drops the entry at `filePath` (deleted, or replaced by a rename),
     * aborting an upload in flight. A node that upload created anyway is
     * trashed.
     */
    async cancel(filePath: string): Promise<void> {
        const entry = this.byPath.get(filePath);
        if (!entry) {
            return;
        }
        this.byPath.delete(filePath);
        entry.cancelled = true;
        this.clearTimer(entry);
        entry.abort?.abort();
        await entry.running;
        this.notify(entry, 'cancelled');
        await this.save(entry, 'remove');
    }

    /** Uploads everything not open right now, and waits for one attempt at each. */
    async flush(): Promise<FlushResult> {
        const result: FlushResult = { uploaded: 0, failed: 0, retrying: 0, open: 0 };
        const attempts: Array<Promise<void>> = [];
        for (const entry of this.byPath.values()) {
            if (entry.refCount > 0) {
                result.open++;
            } else if (entry.state === 'failed') {
                result.failed++;
            } else if (this.stopping) {
                result.retrying++;
            } else {
                attempts.push(
                    new Promise<AttemptOutcome>((resolve) => entry.waiters.push(resolve)).then((outcome) => {
                        if (outcome === 'uploaded') {
                            result.uploaded++;
                        } else if (outcome === 'failed') {
                            result.failed++;
                        } else if (outcome !== 'cancelled') {
                            result.retrying++;
                        }
                    }),
                );
                this.start(entry);
            }
        }
        await Promise.all(attempts);
        return result;
    }

    status(): PendingStatus {
        const status: PendingStatus = { open: 0, pending: 0, uploading: 0, failed: 0, failures: [] };
        for (const entry of this.byPath.values()) {
            if (entry.state === 'open') {
                status.open++;
            } else if (entry.state === 'uploading') {
                status.uploading++;
            } else if (entry.state === 'failed') {
                status.failed++;
                status.failures.push({ path: entry.path, error: entry.error ?? 'unknown error' });
            } else {
                status.pending++;
            }
        }
        return status;
    }

    /** Loads what an earlier run left in the journal and starts uploading it. Returns how many entries were restored. */
    async resume(): Promise<number> {
        await this.o.journal.init();
        const { records, problems } = await this.o.journal.loadAll();
        for (const problem of problems) {
            this.o.logger.warn(problem);
        }
        for (const record of records) {
            if (this.byPath.has(record.path)) {
                this.o.logger.warn(`Two pending uploads for ${record.path}; keeping the first`);
                continue;
            }
            const { claimedMtime, state, ...fields } = record;
            const entry = this.register({ ...fields, refCount: 0, state: state === 'failed' ? 'failed' : 'settling' });
            const seconds = claimedMtime / 1000;
            await utimes(entry.localPath, seconds, seconds).catch(() => {});
            if (entry.state !== 'failed') {
                this.start(entry);
            }
        }
        if (records.length > 0) {
            this.o.logger.info(`Resuming ${records.length} pending upload(s)`);
        }
        return records.length;
    }

    /**
     * Stops starting uploads, gives running ones `graceMs` to finish, aborts
     * the rest, and journals every remaining entry. Bounded, so a large
     * backlog never holds up an unmount or a reboot. Resolves with the
     * number of entries left for the next mount.
     */
    async shutdown(graceMs: number): Promise<number> {
        this.stopping = true;
        for (const entry of this.byPath.values()) {
            this.clearTimer(entry);
            if (entry.state === 'settling' || entry.state === 'retrying') {
                entry.state = 'stopped';
            }
        }
        const running = () =>
            [...this.byPath.values()].flatMap((entry) =>
                entry.state === 'uploading' && entry.running ? [entry.running] : [],
            );
        await settleWithin(running(), graceMs);
        for (const entry of this.byPath.values()) {
            entry.abort?.abort();
        }
        await settleWithin(running(), ABORT_WAIT_MS);
        await Promise.all([...this.byPath.values()].map((entry) => this.save(entry)));
        for (const entry of this.byPath.values()) {
            this.notify(entry, 'stopped');
        }
        return this.byPath.size;
    }

    // ── internals ────────────────────────────────────────────────────────

    private register(
        fields: Pick<PendingUpload, 'kind' | 'path' | 'parentUid' | 'name' | 'refCount' | 'state'> &
            Partial<Pick<PendingUpload, 'id' | 'nodeUid' | 'baseRevisionUid' | 'attempts' | 'error'>>,
    ): PendingUpload {
        const id = fields.id ?? randomUUID();
        const entry: PendingUpload = {
            attempts: 0,
            ...fields,
            id,
            localPath: this.o.journal.blobPath(id),
            ready: Promise.resolve(),
            cancelled: false,
            changedDuringUpload: false,
            saved: Promise.resolve(),
            waiters: [],
        };
        this.byPath.set(entry.path, entry);
        return entry;
    }

    private settle(entry: PendingUpload): void {
        this.clearTimer(entry);
        entry.state = this.stopping ? 'stopped' : 'settling';
        void this.save(entry);
        if (!this.stopping) {
            entry.timer = setTimeout(() => this.start(entry), this.o.settleMs);
            entry.timer.unref();
        }
    }

    private start(entry: PendingUpload): void {
        this.clearTimer(entry);
        if (this.stopping || entry.cancelled || entry.refCount > 0 || entry.state === 'uploading') {
            return;
        }
        entry.state = 'uploading';
        entry.changedDuringUpload = false;
        entry.target = { kind: entry.kind, nodeUid: entry.nodeUid, parentUid: entry.parentUid, name: entry.name };
        const abort = new AbortController();
        entry.abort = abort;
        entry.running = this.attempt(entry, abort.signal).then((result) => this.finish(entry, abort, result));
    }

    private async attempt(entry: PendingUpload, signal: AbortSignal): Promise<Attempt> {
        try {
            await entry.ready;
        } catch (error) {
            return { error, permanent: true };
        }
        try {
            // The journal knows about the upload before it can land.
            await entry.saved;
            const options: UploadOptions = { modificationTime: (await stat(entry.localPath)).mtime, signal };
            const landed = entry.kind === 'revision' ? await this.uploadRevision(entry, options) : await this.uploadNew(entry, options);
            return { landed };
        } catch (error) {
            return { error, permanent: isPermanent(error) };
        }
    }

    private async uploadRevision(entry: PendingUpload, options: UploadOptions): Promise<Landed> {
        const nodeUid = entry.nodeUid as string;
        const current = await this.currentNode(nodeUid);
        if (!current) {
            this.o.logger.warn(`${entry.path} was deleted on Drive meanwhile; uploading it as a new file`);
            return this.uploadNew(entry, options);
        }
        const active = current.activeRevision?.uid;
        const ours = active !== undefined && active === this.ownRevisions.get(nodeUid);
        if (active !== entry.baseRevisionUid && !ours) {
            if (await this.sameContent(entry, current)) {
                // Already there: an earlier attempt landed before it was recorded.
                return { node: current, revisionUid: current.activeRevision?.uid };
            }
            this.o.logger.warn(`${entry.path} changed on Drive since it was changed here; keeping both`);
            return this.uploadConflictCopy(entry, options);
        }
        return { revisionUid: await this.o.content.uploadRevision(nodeUid, entry.name, entry.localPath, options) };
    }

    private async uploadNew(entry: PendingUpload, options: UploadOptions): Promise<Landed> {
        try {
            const node = await this.o.content.uploadNewFile(entry.parentUid, entry.name, entry.localPath, options);
            return { node, created: true };
        } catch (error) {
            if (!(error instanceof NodeWithSameNameExistsValidationError) || error.isUnfinishedUpload) {
                throw error;
            }
            const existing = error.existingNodeUid ? await this.currentNode(error.existingNodeUid) : undefined;
            if (existing && (await this.sameContent(entry, existing))) {
                return { node: existing };
            }
            this.o.logger.warn(`${entry.path} already exists on Drive; keeping both`);
            return this.uploadConflictCopy(entry, options);
        }
    }

    private async uploadConflictCopy(entry: PendingUpload, options: UploadOptions): Promise<Landed> {
        const when = this.o.now ? this.o.now() : new Date();
        for (let n = 1; n <= 5; n++) {
            const name = conflictName(entry.name, when, n);
            try {
                const node = await this.o.content.uploadNewFile(entry.parentUid, name, entry.localPath, options);
                return { node, created: true };
            } catch (error) {
                if (!(error instanceof NodeWithSameNameExistsValidationError)) {
                    throw error;
                }
            }
        }
        throw new ValidationError(`No free conflict-copy name for ${entry.name}`);
    }

    /** The node as Drive has it now, or undefined if it is gone (trashed or deleted). */
    private async currentNode(uid: string): Promise<NodeEntity | undefined> {
        try {
            const node = await this.o.sdk.getNode(uid);
            return node.trashTime ? undefined : node;
        } catch (error) {
            if (error instanceof ValidationError) {
                return undefined;
            }
            throw error;
        }
    }

    private async sameContent(entry: PendingUpload, node: NodeEntity): Promise<boolean> {
        const remote = node.activeRevision?.claimedDigests?.sha1;
        return !!remote && remote === (await sha1Of(entry.localPath));
    }

    private async finish(entry: PendingUpload, abort: AbortController, result: Attempt): Promise<void> {
        entry.abort = undefined;
        if ('landed' in result) {
            const { node, revisionUid, created } = result.landed;
            const target = entry.target as UploadTarget;
            const nodeUid = node?.uid ?? (target.nodeUid as string);
            const landedRevisionUid = revisionUid ?? node?.activeRevision?.uid;
            if (landedRevisionUid) {
                this.ownRevisions.set(nodeUid, landedRevisionUid);
            }
            if (node) {
                this.o.tree.rememberNode(node);
            }
            this.o.tree.invalidate(target.parentUid, entry.parentUid);
            if (entry.cancelled || entry.changedDuringUpload) {
                // The upload landed although it was aborted: the server had already committed it.
                const sameTarget =
                    entry.kind === target.kind &&
                    entry.nodeUid === target.nodeUid &&
                    entry.parentUid === target.parentUid &&
                    entry.name === target.name;
                const otherNode = node && node.uid !== target.nodeUid;
                if (otherNode && (entry.cancelled || !sameTarget)) {
                    // A node under a name or for a change that no longer exists (e.g. rsync's temp
                    // file, renamed meanwhile). Only one this attempt made: a found one isn't ours.
                    if (created) {
                        await this.trashLanded(node, target.parentUid);
                    }
                } else if (!entry.cancelled && (sameTarget || entry.nodeUid === nodeUid)) {
                    // The change becomes a revision of what landed.
                    entry.kind = 'revision';
                    entry.nodeUid = nodeUid;
                    entry.baseRevisionUid = landedRevisionUid;
                }
                if (!entry.cancelled) {
                    this.afterChange(entry);
                }
                return;
            }
            this.byPath.delete(entry.path);
            // Keep the uploaded content as the cached copy, as upload-on-close did.
            const cached = this.o.content.localPathFor(nodeUid);
            await mkdir(path.dirname(cached), { recursive: true, mode: 0o700 }).catch(() => {});
            await rename(entry.localPath, cached).catch(() => {});
            await this.save(entry, 'remove');
            this.notify(entry, 'uploaded');
            return;
        }

        if (entry.cancelled) {
            return;
        }
        if (entry.changedDuringUpload) {
            this.afterChange(entry);
            return;
        }
        if (abort.signal.aborted) {
            // Shutdown: the journal carries it to the next mount.
            entry.state = 'stopped';
            this.notify(entry, 'stopped');
            return;
        }
        entry.error = result.error instanceof Error ? result.error.message : String(result.error);
        if (result.permanent) {
            entry.state = 'failed';
            this.o.logger.error(`Upload of ${entry.path} failed; kept locally until it is changed, renamed or deleted`, result.error);
            void this.save(entry);
            this.notify(entry, 'failed');
            return;
        }
        entry.attempts++;
        const delay = Math.min((this.o.retryBaseMs ?? 1000) * 2 ** (entry.attempts - 1), this.o.retryMaxMs ?? 300_000);
        this.o.logger.warn(`Upload of ${entry.path} failed (attempt ${entry.attempts}); retrying in ${delay} ms: ${entry.error}`);
        entry.state = 'retrying';
        void this.save(entry);
        if (!this.stopping) {
            entry.timer = setTimeout(() => this.start(entry), delay);
            entry.timer.unref();
        }
        this.notify(entry, 'retrying');
        return;
    }

    private async trashLanded(node: NodeEntity, parentUid: string): Promise<void> {
        try {
            for await (const result of this.o.sdk.trashNodes([node.uid])) {
                if (!result.ok) {
                    throw result.error;
                }
            }
        } catch (error) {
            this.o.logger.error(`Could not trash ${node.uid}, uploaded under a name no longer in use`, error);
        }
        this.o.tree.forgetNode(node.uid);
        this.o.tree.invalidate(parentUid);
        await this.o.content.forget(node.uid).catch(() => {});
    }

    private afterChange(entry: PendingUpload): void {
        entry.changedDuringUpload = false;
        if (entry.refCount > 0) {
            entry.state = 'open';
        } else {
            this.settle(entry);
            if (entry.waiters.length > 0) {
                // A flush is waiting for an attempt: make it one of the changed content, now.
                this.start(entry);
            }
        }
    }

    private save(entry: PendingUpload, op: 'write' | 'remove' = 'write'): Promise<void> {
        entry.saved = entry.saved
            .then(async () => {
                if (op === 'remove') {
                    await this.o.journal.remove(entry.id);
                    return;
                }
                if (entry.cancelled || this.byPath.get(entry.path) !== entry) {
                    return; // cancelled or finished meanwhile: nothing left to record
                }
                await entry.ready;
                const { mtimeMs } = await stat(entry.localPath);
                await this.o.journal.write(this.recordOf(entry, Math.floor(mtimeMs)));
            })
            .catch((error) => this.o.logger.error(`Could not ${op} the journal record for ${entry.path}`, error));
        return entry.saved;
    }

    private recordOf(entry: PendingUpload, claimedMtime: number): JournalRecord {
        return {
            id: entry.id,
            kind: entry.kind,
            path: entry.path,
            parentUid: entry.parentUid,
            name: entry.name,
            nodeUid: entry.nodeUid,
            baseRevisionUid: entry.baseRevisionUid,
            claimedMtime,
            attempts: entry.attempts,
            state: entry.state === 'failed' ? 'failed' : 'pending',
            error: entry.error,
        };
    }

    private notify(entry: PendingUpload, outcome: AttemptOutcome): void {
        for (const resolve of entry.waiters.splice(0)) {
            resolve(outcome);
        }
    }

    private clearTimer(entry: PendingUpload): void {
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
        }
    }
}

/** Errors a retry cannot fix: invalid input, quota, integrity or decryption failures, other 4xx, missing content. */
function isPermanent(error: unknown): boolean {
    if (error instanceof NodeWithSameNameExistsValidationError) {
        return !error.isUnfinishedUpload; // another client's draft holds the name: wait it out
    }
    if (error instanceof ValidationError || error instanceof IntegrityError || error instanceof DecryptionError) {
        return true;
    }
    if (error instanceof ServerError && error.statusCode !== undefined) {
        return error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408 && error.statusCode !== 429;
    }
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function sha1Of(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha1');
        createReadStream(file)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/** Waits for every promise in `promises`, or `ms`, whichever comes first. */
async function settleWithin(promises: Array<Promise<unknown>>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms);
        }),
    ]);
    clearTimeout(timer);
}
