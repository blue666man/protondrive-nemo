import { utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ContentStore } from '../src/contentStore';
import { DriveTree } from '../src/driveTree';
import { PendingJournal } from '../src/pendingJournal';
import { type PendingUpload, PendingUploads, type PendingUploadsOptions } from '../src/pendingUploads';
import { FakeDrive } from './fakeDrive';
import { silentLogger, tempDir } from './helpers';

/** Fixed clock for conflict-copy names: 2026-11-02 14:05 local time. */
export const CONFLICT_CLOCK = new Date(2026, 10, 2, 14, 5);
export const CONFLICT_STAMP = '2026-11-02 1405';

export interface PendingSetup {
    fake: FakeDrive;
    tree: DriveTree;
    content: ContentStore;
    pending: PendingUploads;
    /** Temp dir holding blobs/ (content cache) and pending/ (journal). */
    dir: string;
    /** A new PendingUploads on the same dirs, resumed, as the next mount would create it. */
    restart(overrides?: Partial<PendingUploadsOptions>): Promise<PendingUploads>;
    cleanup(): void;
}

/** A PendingUploads over a FakeDrive; settle window 60 s (tests flush), retries after 10-40 ms. */
export async function setupPending(overrides: Partial<PendingUploadsOptions> = {}): Promise<PendingSetup> {
    const tmp = tempDir();
    const fake = new FakeDrive();
    const make = async (extra: Partial<PendingUploadsOptions>) => {
        const tree = new DriveTree(fake.client, silentLogger);
        const content = new ContentStore(fake.client, tmp.dir, silentLogger);
        const pending = new PendingUploads({
            sdk: fake.client,
            tree,
            content,
            journal: new PendingJournal(path.join(tmp.dir, 'pending')),
            logger: silentLogger,
            settleMs: 60_000,
            retryBaseMs: 10,
            retryMaxMs: 40,
            now: () => CONFLICT_CLOCK,
            ...overrides,
            ...extra,
        });
        await pending.resume();
        return { tree, content, pending };
    };
    const first = await make({});
    return {
        fake,
        ...first,
        dir: tmp.dir,
        restart: async (extra = {}) => (await make(extra)).pending,
        cleanup: tmp.cleanup,
    };
}

/** A new file at `filePath` with `text` (and mtime `mtime`), written and closed, as `cp --preserve=timestamps` leaves it. */
export async function closedNewFile(
    s: PendingSetup,
    filePath: string,
    text: string,
    mtime?: Date,
    parentUid = s.fake.rootUid,
): Promise<PendingUpload> {
    const entry = await s.pending.createNew(filePath, parentUid, path.posix.basename(filePath));
    await writeFile(entry.localPath, text);
    if (mtime) {
        await utimes(entry.localPath, mtime, mtime);
    }
    s.pending.closed(entry);
    return entry;
}
