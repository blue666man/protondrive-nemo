import './polyfills';

import { homedir } from 'node:os';
import path from 'node:path';

import { Command } from 'commander';

import { sendRequest, socketPathFor } from './ipcServer';
import type { FlushResult, PendingStatus } from './pendingUploads';
import { getConfig } from './sdk-bootstrap/config';
import { initDrive } from './sdk-bootstrap/init';
import { mount, unmount } from './mount';

const APP_VERSION = 'external-drive-protondrive_nemo@0.1.0-alpha';
const DISCLOSURE = 'protondrive-nemo is a third-party application, not officially supported by Proton.';

const ACCOUNT_OPTION = ['-a, --account <name>', 'account profile (isolates keychain entry, cache/app dirs, and default mount point)'] as const;

function defaultMountPointFor(account?: string): string {
    const resolved = account ?? 'default';
    return path.join(homedir(), resolved === 'default' ? 'ProtonDrive' : `ProtonDrive-${resolved}`);
}

async function drive(account?: string) {
    return initDrive({
        appVersion: APP_VERSION,
        clientUidPrefix: 'protondrive-nemo',
        profile: account,
    });
}

const program = new Command();
program.name('protondrive-nemo').description(`Unofficial FUSE mount of Proton Drive. ${DISCLOSURE}`);

program
    .command('login')
    .description('Sign in to Proton Drive via your browser')
    .option(...ACCOUNT_OPTION)
    .action(async (opts: { account?: string }) => {
        console.log(DISCLOSURE);
        const d = await drive(opts.account);
        if (d.auth.isLoggedIn()) {
            console.log('Already logged in.');
            await d.dispose();
            process.exit(0);
        }
        await d.auth.authViaWeb(async (signInUrl) => {
            console.log(`Opening browser to sign in:\n  ${signInUrl}`);
            await import('open')
                .then((mod) => mod.default(signInUrl))
                .catch(() => {
                    console.log('Could not open a browser automatically — open the URL above manually.');
                });
        });
        console.log('Logged in.');
        await d.dispose();
        // The account API's HTTP keep-alive connection otherwise holds the
        // process open — this command is done, so exit explicitly.
        process.exit(0);
    });

program
    .command('logout')
    .description('Sign out and remove the locally stored session')
    .option(...ACCOUNT_OPTION)
    .action(async (opts: { account?: string }) => {
        const d = await drive(opts.account);
        await d.auth.logout();
        console.log('Logged out.');
        await d.dispose();
        process.exit(0);
    });

program
    .command('status')
    .description('Show login and mount status')
    .option(...ACCOUNT_OPTION)
    .option('-m, --mount-point <path>', 'mount point')
    .action(async (opts: { account?: string; mountPoint?: string }) => {
        const d = await drive(opts.account);
        console.log(`Account: ${d.config.profile}`);
        console.log(`Logged in: ${d.auth.isLoggedIn()}`);
        console.log(`Mount point: ${opts.mountPoint ?? defaultMountPointFor(opts.account)}`);
        const pending = await pendingStatus(opts.account);
        if (!pending) {
            console.log('Mount: not running');
        } else {
            console.log(
                `Pending uploads: ${pendingCount(pending)} (uploading ${pending.uploading}, still open ${pending.open}, failed ${pending.failed})`,
            );
            for (const failure of pending.failures) {
                console.log(`  failed: ${failure.path}: ${failure.error}`);
            }
        }
        await d.dispose();
        process.exit(0);
    });

program
    .command('mount')
    .description('Mount Proton Drive as a folder (runs in the foreground until interrupted)')
    .option(...ACCOUNT_OPTION)
    .option('-m, --mount-point <path>', 'mount point')
    .action(async (opts: { account?: string; mountPoint?: string }) => {
        const mountPoint = opts.mountPoint ?? defaultMountPointFor(opts.account);
        const d = await drive(opts.account);
        const { fuse, ipc, pending, shutdownGraceMs, releaseLock } = await mount(d, mountPoint);
        console.log(`Mounted Proton Drive at ${mountPoint}`);

        const shutdown = async () => {
            console.log('\nUnmounting...');
            // Bounded: running uploads get the grace period, the rest wait in
            // the journal for the next mount.
            const remaining = await pending.shutdown(shutdownGraceMs);
            if (remaining > 0) {
                console.log(`${remaining} upload(s) still pending; they resume on the next mount.`);
            }
            await ipc.stop();
            await new Promise<void>((resolve) => fuse.unmount((err) => {
                if (err) console.error('Unmount failed:', err);
                resolve();
            }));
            await releaseLock();
            await d.dispose();
            process.exit(0);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    });

program
    .command('unmount')
    .description('Unmount Proton Drive')
    .option(...ACCOUNT_OPTION)
    .option('-m, --mount-point <path>', 'mount point')
    .action(async (opts: { account?: string; mountPoint?: string }) => {
        const mountPoint = opts.mountPoint ?? defaultMountPointFor(opts.account);
        const pending = await pendingStatus(opts.account);
        await unmount(mountPoint);
        console.log(`Unmounted ${mountPoint}`);
        if (pending && pendingCount(pending) > 0) {
            console.log(`${pendingCount(pending)} upload(s) still pending; they resume on the next mount.`);
        }
        process.exit(0);
    });

program
    .command('flush')
    .description('Upload every pending change now and wait for it; exits non-zero if anything is still not on Drive')
    .option(...ACCOUNT_OPTION)
    .action(async (opts: { account?: string }) => {
        let res: { ok: boolean; error?: string; result?: FlushResult };
        try {
            res = await sendRequest(socketFor(opts.account), { op: 'flush' });
        } catch (err) {
            res = { ok: false, error: errorCode(err) };
        }
        if (!res.ok || !res.result) {
            console.error(`flush: ${describeEvictError(res.error)}`);
            process.exit(1);
        }
        const r = res.result;
        console.log(`Uploaded ${r.uploaded}; failed ${r.failed}; will retry ${r.retrying}; still open ${r.open}`);
        process.exit(r.failed + r.retrying + r.open > 0 ? 1 : 0);
    });

program
    .command('evict <paths...>')
    .description("Remove the locally cached decrypted copy of one or more files (the mount re-downloads them on next open); doesn't touch anything on Drive")
    .option(...ACCOUNT_OPTION)
    .option('-m, --mount-point <path>', 'mount point')
    .action(async (paths: string[], opts: { account?: string; mountPoint?: string }) => {
        const mountPoint = opts.mountPoint ?? defaultMountPointFor(opts.account);
        const config = getConfig({ appVersion: APP_VERSION, clientUidPrefix: 'protondrive-nemo', profile: opts.account });
        const socketPath = socketPathFor(config.cacheDir);

        let hadError = false;
        for (const target of paths) {
            try {
                const fusePath = toFusePath(target, mountPoint);
                const res = await sendRequest<{ ok: boolean; error?: string }>(socketPath, { op: 'evict', path: fusePath });
                if (res.ok) {
                    console.log(`Cleared cache: ${target}`);
                } else {
                    hadError = true;
                    console.error(`${target}: ${describeEvictError(res.error)}`);
                }
            } catch (err) {
                hadError = true;
                console.error(`${target}: ${describeEvictError(errorCode(err))}`);
            }
        }
        process.exit(hadError ? 1 : 0);
    });

/** Converts an absolute filesystem path under the mount into the FUSE-relative path the daemon's DriveTree understands. */
function toFusePath(absPath: string, mountPoint: string): string {
    const real = path.resolve(absPath);
    const mount = path.resolve(mountPoint);
    if (real !== mount && !real.startsWith(mount + path.sep)) {
        throw new Error(`not-under-mount:${mountPoint}`);
    }
    const rel = real === mount ? '' : real.slice(mount.length);
    return rel === '' ? '/' : rel.split(path.sep).join('/');
}

function errorCode(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

function describeEvictError(code?: string): string {
    if (!code) {
        return 'unknown error';
    }
    if (code === 'not-found') {
        return 'not found on Proton Drive';
    }
    if (code === 'not-a-file') {
        return "is a folder — use the mount's root right-click action to clear the whole cache instead";
    }
    if (code === 'open-with-unsaved-changes') {
        return 'has changes not on Drive yet — run `protondrive-nemo flush` (or close it) first';
    }
    if (code === 'mount-not-running') {
        return 'Proton Drive mount is not running';
    }
    if (code.startsWith('not-under-mount:')) {
        return `is not under the mount point ${code.slice('not-under-mount:'.length)}`;
    }
    return code;
}

function socketFor(account?: string): string {
    return socketPathFor(getConfig({ appVersion: APP_VERSION, clientUidPrefix: 'protondrive-nemo', profile: account }).cacheDir);
}

/** The running daemon's pending-upload counts, or undefined if no mount is running. */
async function pendingStatus(account?: string): Promise<PendingStatus | undefined> {
    try {
        return (await sendRequest<{ ok: boolean; status?: PendingStatus }>(socketFor(account), { op: 'pendingStatus' })).status;
    } catch {
        return undefined;
    }
}

function pendingCount(status: PendingStatus): number {
    return status.open + status.pending + status.uploading + status.failed;
}

program.parseAsync(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
