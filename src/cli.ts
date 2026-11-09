import './polyfills';

import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

import { Command } from 'commander';

import { socketPathFor } from './ipcServer';
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
        const { fuse, ipc, cleanup } = await mount(d, mountPoint);
        console.log(`Mounted Proton Drive at ${mountPoint}`);

        const shutdown = async () => {
            console.log('\nUnmounting...');
            await ipc.stop();
            await new Promise<void>((resolve) => fuse.unmount((err) => {
                if (err) console.error('Unmount failed:', err);
                resolve();
            }));
            await cleanup();
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
        await unmount(mountPoint);
        console.log(`Unmounted ${mountPoint}`);
        process.exit(0);
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
                const res = await sendEvict(socketPath, fusePath);
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

function sendEvict(socketPath: string, fusePath: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buffer = '';
        socket.on('connect', () => {
            socket.write(`${JSON.stringify({ op: 'evict', path: fusePath })}\n`);
        });
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex >= 0) {
                socket.end();
                try {
                    resolve(JSON.parse(buffer.slice(0, newlineIndex)));
                } catch (err) {
                    reject(err);
                }
            }
        });
        socket.on('error', (err: NodeJS.ErrnoException) => {
            reject(new Error(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? 'mount-not-running' : err.message));
        });
    });
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
        return 'is currently open with unsaved changes — save or close it first';
    }
    if (code === 'mount-not-running') {
        return 'Proton Drive mount is not running';
    }
    if (code.startsWith('not-under-mount:')) {
        return `is not under the mount point ${code.slice('not-under-mount:'.length)}`;
    }
    return code;
}

program.parseAsync(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
