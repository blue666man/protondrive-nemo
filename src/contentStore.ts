import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import type { Logger, NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';

const MEDIA_TYPES: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.zip': 'application/zip',
    '.csv': 'text/csv',
    '.html': 'text/html',
};

function guessMediaType(name: string): string {
    return MEDIA_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Materializes Drive file content to local disk on demand (download on
 * first open, upload on release-if-dirty), instead of implementing
 * byte-range paging against the remote. Simple and reliable for a v1; the
 * tradeoff is that opening a very large file downloads it in full before
 * any byte is readable — see README limitations.
 *
 * Content lives under two directories: `blobs/` (persistent, reused across
 * opens) and `tmp/` (throwaway, removed on close). The mount's cache policy
 * decides which one a given file uses; `wipe()` clears both.
 */
export class ContentStore {
    private readonly persistentDir: string;
    private readonly ephemeralDir: string;

    constructor(
        private readonly sdk: ProtonDriveClient,
        cacheRootDir: string,
        private readonly logger: Logger,
    ) {
        this.persistentDir = path.join(cacheRootDir, 'blobs');
        this.ephemeralDir = path.join(cacheRootDir, 'tmp');
    }

    private dirFor(ephemeral: boolean): string {
        return ephemeral ? this.ephemeralDir : this.persistentDir;
    }

    localPathFor(nodeUid: string, ephemeral = false): string {
        return path.join(this.dirFor(ephemeral), encodeURIComponent(nodeUid));
    }

    /** Whether a file's persistent content is already fully downloaded locally (same freshness check `ensureDownloaded` uses). */
    async isCached(node: NodeEntity): Promise<boolean> {
        return this.isComplete(node, this.persistentDir);
    }

    private async isComplete(node: NodeEntity, dir: string): Promise<boolean> {
        const localPath = path.join(dir, encodeURIComponent(node.uid));
        const expectedSize = node.activeRevision?.claimedSize;
        const existing = await stat(localPath).catch(() => undefined);
        return !!existing && (expectedSize === undefined || existing.size === expectedSize);
    }

    /** Downloads `node` if needed and returns the local path. `ephemeral` sends the copy to the throwaway directory. */
    async ensureDownloaded(node: NodeEntity, opts: { ephemeral?: boolean } = {}): Promise<string> {
        const dir = this.dirFor(!!opts.ephemeral);

        if (!opts.ephemeral && (await this.isCached(node))) {
            return path.join(dir, encodeURIComponent(node.uid));
        }
        if (opts.ephemeral && (await this.isComplete(node, dir))) {
            return path.join(dir, encodeURIComponent(node.uid));
        }

        const localPath = path.join(dir, encodeURIComponent(node.uid));
        await mkdir(dir, { recursive: true });
        this.logger.debug(`Downloading ${node.uid} to ${localPath}`);
        const downloader = await this.sdk.getFileDownloader(node.uid);
        const nodeWriteStream = createWriteStream(localPath);
        const controller = downloader.downloadToStream(Writable.toWeb(nodeWriteStream));
        await controller.completion();
        return localPath;
    }

    createEmptyLocal(nodeUid: string, opts: { ephemeral?: boolean } = {}): Promise<string> {
        const ephemeral = !!opts.ephemeral;
        const localPath = this.localPathFor(nodeUid, ephemeral);
        return mkdir(this.dirFor(ephemeral), { recursive: true })
            .then(() => new Promise<void>((resolve, reject) => {
                const ws = createWriteStream(localPath);
                ws.end(() => resolve());
                ws.on('error', reject);
            }))
            .then(() => localPath);
    }

    /** Removes a node's local copy from both the persistent and the throwaway cache. */
    async forget(nodeUid: string): Promise<void> {
        await Promise.all([
            rm(this.localPathFor(nodeUid, false), { force: true }),
            rm(this.localPathFor(nodeUid, true), { force: true }),
        ]);
    }

    /** Deletes every cached blob (persistent and throwaway). Used by the ephemeral-cache mode. */
    async wipe(): Promise<void> {
        this.logger.debug(`Wiping content cache under ${this.persistentDir} and ${this.ephemeralDir}`);
        await Promise.all([
            rm(this.persistentDir, { recursive: true, force: true }),
            rm(this.ephemeralDir, { recursive: true, force: true }),
        ]);
    }

    async uploadNewFile(parentUid: string, name: string, localPath: string): Promise<NodeEntity> {
        const size = (await stat(localPath)).size;
        const uploader = await this.sdk.getFileUploader(parentUid, name, {
            mediaType: guessMediaType(name),
            expectedSize: size,
            modificationTime: new Date(),
        });
        const stream = Readable.toWeb(createReadStream(localPath)) as ReadableStream;
        const controller = await uploader.uploadFromStream(stream, []);
        const { nodeUid } = await controller.completion();
        return this.sdk.getNode(nodeUid);
    }

    async uploadRevision(node: NodeEntity, localPath: string): Promise<void> {
        const size = (await stat(localPath)).size;
        const uploader = await this.sdk.getFileRevisionUploader(node.uid, {
            mediaType: guessMediaType(node.name.ok ? node.name.value : ''),
            expectedSize: size,
            modificationTime: new Date(),
        });
        const stream = Readable.toWeb(createReadStream(localPath)) as ReadableStream;
        const controller = await uploader.uploadFromStream(stream, []);
        await controller.completion();
        // Re-download disabled: the local file we just uploaded from is
        // already the authoritative content, no need to round-trip it.
    }
}
