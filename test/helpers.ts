import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Logger, NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';

import type { mount } from '../src/mount';
import { type Config, getConfig } from '../src/sdk-bootstrap/config';

export const silentLogger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

/** A fresh temp dir and a function that removes it. */
export function tempDir(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), 'pdn-test-'));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The slice of `initDrive()`'s result that mount() reads. The config is the
 * real getConfig() default (so options added later show up here too), with
 * its data dirs moved to `cacheDir`, which is created as initDrive() would.
 * `sdk` is empty: nothing reaches the SDK until a FUSE handler is called.
 */
export function fakeDrive(cacheDir: string, overrides: Partial<Config> = {}): Parameters<typeof mount>[0] {
    mkdirSync(cacheDir, { recursive: true });
    const config: Config = {
        ...getConfig({ appVersion: 'test', clientUidPrefix: 'test' }),
        cacheDir,
        appDir: cacheDir,
        ...overrides,
    };
    return {
        auth: { isLoggedIn: () => true },
        sdk: {},
        logger: silentLogger,
        config,
    } as unknown as Parameters<typeof mount>[0];
}

/** A file node with just the fields the content cache reads. */
export function fileNode(uid: string, size: number): NodeEntity {
    return { uid, name: { ok: true, value: uid }, activeRevision: { claimedSize: size } } as unknown as NodeEntity;
}

/** An SDK whose file downloads write `content` to the stream they are given. */
export function downloadingSdk(content: string): ProtonDriveClient {
    return {
        getFileDownloader: async () => ({
            downloadToStream: (stream: WritableStream<Uint8Array>) => ({
                completion: async () => {
                    const writer = stream.getWriter();
                    await writer.write(new TextEncoder().encode(content));
                    await writer.close();
                },
            }),
        }),
    } as unknown as ProtonDriveClient;
}

/** Calls a callback-style FUSE handler and resolves with the arguments it passes to its callback. */
export function callOp(op: ((...args: any[]) => void) | undefined, ...args: unknown[]): Promise<unknown[]> {
    if (!op) {
        throw new Error('handler not implemented');
    }
    return new Promise((resolve) => op(...args, (...result: unknown[]) => resolve(result)));
}
