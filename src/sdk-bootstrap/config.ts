import { homedir } from 'node:os';
import path from 'node:path';

import { LogLevel } from '@protontech/drive-sdk/dist/telemetry';

const APP_DIR_NAME = 'protondrive-nemo';

export interface InitConfig {
    appVersion: string;
    sdkVersion?: string;
    clientUidPrefix: string;
    enablePersistedEvents?: boolean;
    /** Account profile, isolating keychain entry, cache/app dirs, and default mount point. Defaults to `'default'`. */
    profile?: string;
    /**
     * Remote folder paths whose files may be kept in the persistent local
     * cache. Overrides `PROTONDRIVE_NEMO_CACHE_PATHS` (comma-separated). Empty
     * means every file is cacheable, which is the default.
     */
    cachePaths?: string[];
    /**
     * When true, decrypted file content is never kept on disk: every open is
     * downloaded to a temporary location and removed again, and the whole
     * content cache is wiped on start and on exit. Overrides
     * `PROTONDRIVE_NEMO_EPHEMERAL_CACHE`. Defaults to false.
     */
    ephemeralCache?: boolean;
}

export interface Config {
    /** Resolved account profile (never undefined — `'default'` when none was given). */
    profile: string;
    /** Client UID is auto generated at the first run with a given prefix. */
    clientUidPrefix: string;
    /** Version of this application, sent as x-pm-appversion. */
    appVersion: string;
    /** Client ID used for the browser-based sign-in flow. */
    authClientId: string;
    /** Version of the SDK this app was built against. */
    sdkVersion?: string;
    /** Base URL for the Drive API. */
    baseUrl: string;
    /** Base URL for the account (login) web pages. */
    accountUrl: string;

    /** Cache folder for ephemeral files (cryptographic cache, entities cache). */
    cacheDir: string;
    /** App data folder for persistent files (events cursor, client UID). */
    appDir: string;

    /** Whether to enable persisted events, stored in the app data folder. */
    enablePersistedEvents: boolean;
    /** Level of logging to the console. */
    logLevel: LogLevel;

    /**
     * Remote folder paths (POSIX-style, under "My Files") whose files may be
     * kept in the persistent local cache. Empty = every file may be cached.
     * Files outside these folders are still readable, but their decrypted copy
     * is removed as soon as it is closed.
     */
    cachePaths: string[];
    /**
     * When true, no decrypted content is ever kept: every open uses a
     * throwaway copy and the content cache is wiped on start and exit.
     */
    ephemeralCache: boolean;
}

/**
 * Adapted from ProtonDriveApps/sdk `cli/src/config.ts`: same directory
 * conventions and account-URL derivation, trimmed to what this daemon needs
 * (no telemetry/pass-store/unsafe-cache options — see ../../VENDOR.md).
 */
export function getConfig(options: InitConfig): Config {
    const profile = options.profile ?? 'default';
    validateProfileName(profile);

    const logLevelOption = process.env.PROTONDRIVE_NEMO_LOG_LEVEL?.toUpperCase() ?? 'INFO';
    const logLevel = LogLevel[logLevelOption as keyof typeof LogLevel] ?? LogLevel.INFO;

    const { cacheDir, appDir } = defaultDataDirs(profile);

    const baseUrl = process.env.PROTONDRIVE_NEMO_BASE_URL || 'drive-api.proton.me';

    const cachePaths = options.cachePaths ?? parsePathList(process.env.PROTONDRIVE_NEMO_CACHE_PATHS);
    const ephemeralCache = options.ephemeralCache ?? isTruthy(process.env.PROTONDRIVE_NEMO_EPHEMERAL_CACHE);

    return {
        profile,
        clientUidPrefix: options.clientUidPrefix,
        appVersion: options.appVersion,
        authClientId: 'external-drive',
        sdkVersion: options.sdkVersion,
        baseUrl,
        accountUrl: accountUrlFromBaseUrl(baseUrl),
        cacheDir,
        appDir,
        enablePersistedEvents: options.enablePersistedEvents ?? true,
        logLevel,
        cachePaths,
        ephemeralCache,
    };
}

/** Parses `PROTONDRIVE_NEMO_CACHE_PATHS`: a comma- or colon-separated list of Drive folder paths. */
function parsePathList(raw: string | undefined): string[] {
    if (!raw) {
        return [];
    }
    return raw
        .split(/[,:]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function isTruthy(raw: string | undefined): boolean {
    return raw !== undefined && /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Derives the account URL from the API base URL by swapping the `drive-api`
 * host label for `account`, e.g. `drive-api.proton.me` -> `account.proton.me`.
 */
function accountUrlFromBaseUrl(baseUrl: string): string {
    if (baseUrl.startsWith('drive-api.')) {
        return baseUrl.replace(/^drive-api\./, 'account.');
    }
    return baseUrl.endsWith('.black') ? 'account.proton.black' : 'account.proton.me';
}

/**
 * `profile` gets interpolated straight into filesystem paths and a keychain
 * account name below, so this isn't cosmetic — an unvalidated value (e.g.
 * containing `..` or `/`) would be a path-traversal bug.
 */
function validateProfileName(profile: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(profile)) {
        throw new Error(`Invalid profile name "${profile}": use only letters, digits, "-", "_".`);
    }
}

function defaultDataDirs(profile: string): Pick<Config, 'cacheDir' | 'appDir'> {
    const home = homedir();
    const override = process.env.PROTONDRIVE_NEMO_DATA_DIR;
    if (override) {
        const dir = profile === 'default' ? override : path.join(override, profile);
        return { cacheDir: dir, appDir: dir };
    }

    const xdgCache = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
    const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const suffix = profile === 'default' ? '' : `-${profile}`;
    return {
        cacheDir: path.join(xdgCache, `${APP_DIR_NAME}${suffix}`),
        appDir: path.join(xdgData, `${APP_DIR_NAME}${suffix}`),
    };
}
