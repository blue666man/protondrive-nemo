import type { Config } from './sdk-bootstrap/config';

/** Normalizes a Drive path to a leading slash and no trailing slash ("/" stays "/"). */
export function normalizeRemotePath(input: string): string {
    const segments = input
        .split('/')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
    return '/' + segments.join('/');
}

/** True when `child` is `parent` or lives under it. */
export function isUnder(parent: string, child: string): boolean {
    const p = normalizeRemotePath(parent);
    const c = normalizeRemotePath(child);
    if (p === '/') {
        return true;
    }
    return c === p || c.startsWith(p + '/');
}

/**
 * Decides, for a file's mount path, whether its decrypted content may be kept
 * in the persistent local cache. Off by default: with no allowlist every file
 * is cacheable, and ephemeral mode disables caching entirely.
 */
export interface CachePolicy {
    /** True when nothing is ever kept on disk (env `PROTONDRIVE_NEMO_EPHEMERAL_CACHE`). */
    readonly ephemeral: boolean;
    /** Normalized allowlist of Drive folder paths (empty = everything). */
    readonly allow: string[];
    /** `fusePath` is a mount-relative path such as `/Documents/report.pdf`. */
    isCacheable(fusePath: string): boolean;
}

export function createCachePolicy(config: Pick<Config, 'cachePaths' | 'ephemeralCache'>): CachePolicy {
    const allow = config.cachePaths.map(normalizeRemotePath).filter((p) => p !== '/');
    return {
        ephemeral: config.ephemeralCache,
        allow,
        isCacheable(fusePath: string): boolean {
            if (config.ephemeralCache) {
                return false;
            }
            if (allow.length === 0) {
                return true;
            }
            return allow.some((prefix) => isUnder(prefix, fusePath));
        },
    };
}
