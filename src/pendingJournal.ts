import { chmod, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export type PendingKind = 'new' | 'revision';

/** One upload that has not reached Drive yet, as stored on disk. */
export interface JournalRecord {
    id: string;
    kind: PendingKind;
    /** Path under the mount when recorded; uploads go by parentUid + name. */
    path: string;
    parentUid: string;
    name: string;
    /** Revisions: the Drive file this content replaces. */
    nodeUid?: string;
    /** Revisions: that file's active revision when the change began, to detect remote edits. */
    baseRevisionUid?: string;
    /** Claimed modification time, ms since the epoch (the content's mtime when recorded). */
    claimedMtime: number;
    attempts: number;
    state: 'pending' | 'failed';
    /** Last error, shown by `status`. */
    error?: string;
}

/**
 * Durable record of uploads that have not reached Drive yet: one
 * `<id>.json` per upload, beside its content `<id>.blob`, in a private
 * directory. One small file per upload, rather than one shared file, keeps
 * each update cheap while thousands of files are pending. A record is
 * written to a temp file, fsynced, renamed into place and the directory
 * fsynced, so a crash leaves the old record or the new one, never a torn one.
 */
export class PendingJournal {
    constructor(readonly dir: string) {}

    async init(): Promise<void> {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        // Decrypted content lives here; the directory is ours alone.
        await chmod(this.dir, 0o700);
    }

    blobPath(id: string): string {
        return path.join(this.dir, `${id}.blob`);
    }

    async write(record: JournalRecord): Promise<void> {
        const target = this.recordPath(record.id);
        const tmp = `${target}.tmp`;
        const handle = await open(tmp, 'w', 0o600);
        try {
            await handle.writeFile(JSON.stringify(record));
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(tmp, target);
        await this.syncDir();
    }

    /** Deletes the record and its content. */
    async remove(id: string): Promise<void> {
        await rm(this.recordPath(id), { force: true });
        await rm(this.blobPath(id), { force: true });
        await this.syncDir();
    }

    /**
     * Reads every record, and tidies up what a crash can leave behind:
     * content without a record (never closed, or already uploaded) and
     * temp files are deleted; a record without content is dropped; an
     * unreadable record is moved aside as `.corrupt`, with its content kept.
     */
    async loadAll(): Promise<{ records: JournalRecord[]; problems: string[] }> {
        const names = await readdir(this.dir);
        const present = new Set(names);
        const records: JournalRecord[] = [];
        const problems: string[] = [];
        for (const name of names) {
            const full = path.join(this.dir, name);
            if (name.endsWith('.tmp')) {
                await rm(full, { force: true });
                continue;
            }
            if (name.endsWith('.blob')) {
                const id = name.slice(0, -'.blob'.length);
                if (!present.has(`${id}.json`) && !present.has(`${id}.json.corrupt`)) {
                    await rm(full, { force: true });
                }
                continue;
            }
            if (!name.endsWith('.json')) {
                continue;
            }
            const id = name.slice(0, -'.json'.length);
            let record: JournalRecord;
            try {
                record = JSON.parse(await readFile(full, 'utf8')) as JournalRecord;
            } catch {
                await rename(full, `${full}.corrupt`);
                problems.push(`Unreadable pending-upload record ${name}; moved aside as ${name}.corrupt`);
                continue;
            }
            if (!present.has(`${id}.blob`)) {
                await rm(full, { force: true });
                problems.push(`Pending upload of ${record.path} has no content (already uploaded, or lost); record dropped`);
                continue;
            }
            records.push(record);
        }
        return { records, problems };
    }

    private recordPath(id: string): string {
        return path.join(this.dir, `${id}.json`);
    }

    private async syncDir(): Promise<void> {
        const handle = await open(this.dir, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
}
