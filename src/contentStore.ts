import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import type { Logger, NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';

import { ensurePrivateDir } from './privateDirs';

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

/**
 * Cached blobs are decrypted file content, so they are owner-only, inside an
 * owner-only (0700) directory. The mode applies only when a file is created:
 * a blob left by an older version keeps 0644, but once its directory is 0700
 * no other user can reach it.
 */
const BLOB_MODE = 0o600;

function guessMediaType(name: string): string {
    return MEDIA_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Materializes Drive file content to local disk on demand (download on
 * first open, upload on release-if-dirty), instead of implementing
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

        await ensurePrivateDir(this.cacheDir);
        this.logger.debug(`Downloading ${node.uid} to ${localPath}`);
        const downloader = await this.sdk.getFileDownloader(node.uid);
        const nodeWriteStream = createWriteStream(localPath, { mode: BLOB_MODE });
        const controller = downloader.downloadToStream(Writable.toWeb(nodeWriteStream));
        await controller.completion();
        return localPath;
    }

    createEmptyLocal(nodeUid: string): Promise<string> {
        const localPath = this.localPathFor(nodeUid);
        return ensurePrivateDir(this.cacheDir)
            .then(() => new Promise<void>((resolve, reject) => {
                const ws = createWriteStream(localPath, { mode: BLOB_MODE });
                ws.end(() => resolve());
                ws.on('error', reject);
            }))
            .then(() => localPath);
    }

    async forget(nodeUid: string): Promise<void> {
        await rm(this.localPathFor(nodeUid), { force: true });
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
