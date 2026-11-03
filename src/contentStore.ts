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

export interface UploadOptions {
    /** Claimed modification time, stored (encrypted) with the revision. */
    modificationTime: Date;
    /** Cancels both the wait for a slot in the SDK's upload queue and the upload itself. */
    signal?: AbortSignal;
}

/**
 * Materializes Drive file content to local disk on demand (download on
 * first open; changes are uploaded through pendingUploads.ts), instead of implementing
 * byte-range paging against the remote. Simple and reliable for a v1; the
 * tradeoff is that opening a very large file downloads it in full before
 * any byte is readable — see README limitations.
 */
export class ContentStore {
    constructor(
        private readonly sdk: ProtonDriveClient,
        private readonly cacheDir: string,
        private readonly logger: Logger,
    ) {}

    localPathFor(nodeUid: string): string {
        return path.join(this.cacheDir, encodeURIComponent(nodeUid));
    }

    /** Whether a file's content is already fully downloaded locally (same freshness check `ensureDownloaded` uses). */
    async isCached(node: NodeEntity): Promise<boolean> {
        const localPath = this.localPathFor(node.uid);
        const expectedSize = node.activeRevision?.claimedSize;
        const existing = await stat(localPath).catch(() => undefined);
        return !!existing && (expectedSize === undefined || existing.size === expectedSize);
    }

    async ensureDownloaded(node: NodeEntity): Promise<string> {
        const localPath = this.localPathFor(node.uid);

        if (await this.isCached(node)) {
            return localPath;
        }

        await mkdir(this.cacheDir, { recursive: true });
        this.logger.debug(`Downloading ${node.uid} to ${localPath}`);
        const downloader = await this.sdk.getFileDownloader(node.uid);
        const nodeWriteStream = createWriteStream(localPath);
        const controller = downloader.downloadToStream(Writable.toWeb(nodeWriteStream));
        await controller.completion();
        return localPath;
    }

    createEmptyLocal(nodeUid: string): Promise<string> {
        const localPath = this.localPathFor(nodeUid);
        return mkdir(this.cacheDir, { recursive: true })
            .then(() => new Promise<void>((resolve, reject) => {
                const ws = createWriteStream(localPath);
                ws.end(() => resolve());
                ws.on('error', reject);
            }))
            .then(() => localPath);
    }

    async forget(nodeUid: string): Promise<void> {
        await rm(this.localPathFor(nodeUid), { force: true });
    }

    async uploadNewFile(parentUid: string, name: string, localPath: string, options: UploadOptions): Promise<NodeEntity> {
        const size = (await stat(localPath)).size;
        const uploader = await this.sdk.getFileUploader(
            parentUid,
            name,
            { mediaType: guessMediaType(name), expectedSize: size, modificationTime: options.modificationTime },
            options.signal,
        );
        // Opened only now: getFileUploader waits for a slot in the SDK's upload queue.
        const stream = Readable.toWeb(createReadStream(localPath)) as ReadableStream;
        const controller = await uploader.uploadFromStream(stream, []);
        const { nodeUid } = await controller.completion();
        return this.sdk.getNode(nodeUid);
    }

    /** Uploads a new revision of `nodeUid`; resolves with the new revision's uid. */
    async uploadRevision(nodeUid: string, name: string, localPath: string, options: UploadOptions): Promise<string> {
        const size = (await stat(localPath)).size;
        const uploader = await this.sdk.getFileRevisionUploader(
            nodeUid,
            { mediaType: guessMediaType(name), expectedSize: size, modificationTime: options.modificationTime },
            options.signal,
        );
        const stream = Readable.toWeb(createReadStream(localPath)) as ReadableStream;
        const controller = await uploader.uploadFromStream(stream, []);
        const { nodeRevisionUid } = await controller.completion();
        return nodeRevisionUid;
    }
}
