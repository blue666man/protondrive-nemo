import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

import { NodeType } from '@protontech/drive-sdk';
import type { Logger, NodeEntity } from '@protontech/drive-sdk';

import type { ContentStore } from './contentStore';
import { DriveTree, NodeNotFoundError } from './driveTree';
import type { FlushResult, PendingStatus, PendingUploads } from './pendingUploads';

interface EvictResponse {
    ok: boolean;
    error?: string;
}

export type CacheState = 'cached' | 'not-cached' | 'partial' | 'unknown';

interface CacheStatusResponse {
    ok: boolean;
    error?: string;
    entries?: Record<string, CacheState>;
}

export type IpcRequest =
    | { op: 'evict'; path: string }
    | { op: 'cacheStatus'; path: string }
    | { op: 'pendingStatus' }
    | { op: 'flush' }
    | { op: 'shutdown' };

interface PendingStatusResponse {
    ok: boolean;
    error?: string;
    status?: PendingStatus;
}

interface FlushResponse {
    ok: boolean;
    error?: string;
    result?: FlushResult;
}

interface ShutdownResponse {
    ok: boolean;
    error?: string;
    /** Uploads left in the journal for the next mount. */
    remaining?: number;
}

type Response = EvictResponse | CacheStatusResponse | PendingStatusResponse | FlushResponse | ShutdownResponse;

/**
 * Wall-clock budget for a single cacheStatus request, covering every
 * recursive folder-state walk it triggers. Descending into a subfolder can
 * mean a real network call (uncached listing), so bounding by node count
 * alone doesn't bound latency — a deep, never-before-listed tree can rack
 * up hundreds of serial API calls and multiple minutes of wall time (hit
 * this for real during development: 295 API calls, ~1 minute, before the
 * deadline was added). Once elapsed, remaining unresolved folders report
 * 'unknown' (no emblem) instead of descending further; already-cached
 * listings from prior requests stay fast since DriveTree caches them for
 * 10s, so repeat lookups of the same tree fill in over subsequent calls.
 */
const CACHE_STATUS_DEADLINE_MS = 1200;

/** Where the running mount daemon's IPC socket lives, given its cache dir. Shared by mount.ts (server) and cli.ts (client). */
export function socketPathFor(cacheDir: string): string {
    return path.join(cacheDir, 'daemon.sock');
}

/**
 * Sends one request to the mount daemon listening on `socketPath` and
 * resolves with its answer. Rejects with `mount-not-running` when nothing
 * listens there.
 */
export function sendRequest<T = unknown>(socketPath: string, request: IpcRequest): Promise<T> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buffer = '';
        socket.on('connect', () => {
            socket.write(`${JSON.stringify(request)}\n`);
        });
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex >= 0) {
                socket.end();
                try {
                    resolve(JSON.parse(buffer.slice(0, newlineIndex)) as T);
                } catch (err) {
                    reject(err);
                }
            }
        });
        socket.on('error', (err: NodeJS.ErrnoException) => {
            reject(new Error(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? 'mount-not-running' : err.message));
        });
        // The daemon went away without answering (no-op once resolved).
        socket.on('close', () => reject(new Error('no-answer')));
    });
}

/**
 * Small Unix-socket control channel so a one-shot CLI invocation (bound to a
 * Nemo right-click action) can ask the long-running mount daemon to evict a
 * single file's local cache entry — without duplicating the daemon's SDK
 * session, auth, and DriveTree/ContentStore state in a throwaway process.
 * Newline-delimited JSON, one request/response per connection.
 */
export class IpcServer {
    private server?: Server;
    /** Open client connections; stop() ends them, so a silent client can't hold it up. */
    private readonly sockets = new Set<Socket>();

    /**
     * Answers `{ op: 'shutdown' }`: shuts the daemon down and resolves with
     * the number of uploads left for the next mount. Set by the CLI.
     */
    onShutdown?: () => Promise<number>;

    constructor(
        private readonly socketPath: string,
        private readonly tree: DriveTree,
        private readonly content: ContentStore,
        private readonly hasUnsavedChanges: (path: string) => boolean,
        private readonly logger: Logger,
        private readonly pending: Pick<PendingUploads, 'status' | 'flush'>,
    ) {}

    async start(): Promise<void> {
        await unlink(this.socketPath).catch(() => {});
        const server = createServer((socket) => this.handleConnection(socket));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.socketPath, resolve);
        });
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (server) {
            const closed = new Promise<void>((resolve) => server.close(() => resolve()));
            for (const socket of this.sockets) {
                socket.destroy();
            }
            this.sockets.clear();
            await closed;
        }
        await unlink(this.socketPath).catch(() => {});
    }

    private handleConnection(socket: Socket): void {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                this.handleLine(socket, line);
            }
        });
        socket.on('error', (err) => this.logger.debug(`IPC connection error: ${err}`));
    }

    private handleLine(socket: Socket, line: string): void {
        if (!line.trim()) {
            return;
        }
        let req: IpcRequest | undefined;
        Promise.resolve()
            .then(() => {
                req = JSON.parse(line) as IpcRequest;
                if (req.op === 'shutdown') {
                    // The shutdown stops the server, perhaps before it
                    // answers: keep this client out of stop()'s reach, so
                    // its answer (ok or not) always arrives.
                    this.sockets.delete(socket);
                }
                return this.handleRequest(req);
            })
            .catch((err): Response => ({
                ok: false,
                error: err instanceof NodeNotFoundError ? 'not-found' : err instanceof Error ? err.message : String(err),
            }))
            .then((res) => {
                if (req?.op === 'shutdown') {
                    socket.end(`${JSON.stringify(res)}\n`);
                    return;
                }
                socket.write(`${JSON.stringify(res)}\n`);
            });
    }

    private async handleRequest(req: IpcRequest): Promise<Response> {
        if (req.op === 'evict') {
            return this.handleEvict(req.path);
        }
        if (req.op === 'cacheStatus') {
            return this.handleCacheStatus(req.path);
        }
        if (req.op === 'pendingStatus') {
            return { ok: true, status: this.pending.status() };
        }
        if (req.op === 'flush') {
            return { ok: true, result: await this.pending.flush() };
        }
        if (req.op === 'shutdown') {
            if (!this.onShutdown) {
                return { ok: false, error: 'shutdown-unsupported' };
            }
            return { ok: true, remaining: await this.onShutdown() };
        }
        throw new Error(`Unknown op: ${(req as { op: string }).op}`);
    }

    private async handleEvict(reqPath: string): Promise<EvictResponse> {
        if (this.hasUnsavedChanges(reqPath)) {
            return { ok: false, error: 'open-with-unsaved-changes' };
        }
        const node = await this.tree.resolve(reqPath);
        if (node.type !== NodeType.File) {
            return { ok: false, error: 'not-a-file' };
        }
        await this.content.forget(node.uid);
        return { ok: true };
    }

    private async handleCacheStatus(reqPath: string): Promise<CacheStatusResponse> {
        const folder = await this.tree.resolve(reqPath);
        const children = await this.tree.listChildren(folder.uid);
        const entries: Record<string, CacheState> = {};
        const deadline = Date.now() + CACHE_STATUS_DEADLINE_MS;
        for (const [name, node] of children) {
            entries[name] = await this.cacheStateOf(node, deadline);
        }
        return { ok: true, entries };
    }

    private async cacheStateOf(node: NodeEntity, deadline: number): Promise<CacheState> {
        if (node.type === NodeType.File) {
            return (await this.content.isCached(node)) ? 'cached' : 'not-cached';
        }
        if (Date.now() > deadline) {
            return 'unknown';
        }

        const children = [...(await this.tree.listChildren(node.uid)).values()];
        if (children.length === 0) {
            return 'cached';
        }
        let sawCached = false;
        let sawNotCached = false;
        for (const child of children) {
            const state = await this.cacheStateOf(child, deadline);
            if (state === 'unknown') {
                return 'unknown';
            }
            if (state === 'partial') {
                sawCached = true;
                sawNotCached = true;
                continue;
            }
            if (state === 'cached') {
                sawCached = true;
            } else {
                sawNotCached = true;
            }
        }
        if (sawCached && sawNotCached) {
            return 'partial';
        }
        return sawCached ? 'cached' : 'not-cached';
    }
}
