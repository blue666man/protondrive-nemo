// @protontech/crypto ships raw TypeScript source (no compiled JS) for its
// runtime crypto endpoint, so a plain `tsc` build can't produce a runnable
// dist/cli.js: `require()` can't load a .ts file. esbuild transpiles
// anything it bundles regardless of whether it lives in node_modules, so it
// bundles our own src/ together with that raw-TS dependency into one plain
// CommonJS file. Native addons (fuse binding, sqlite) are kept
// external and loaded via require() at runtime instead of being bundled.
const esbuild = require('esbuild');
const fs = require('node:fs');

// `open` is ESM-only and reads `import.meta.url` at module load time to
// locate a helper script it ships — bundling it into our CJS output turns
// that into `undefined` and it throws immediately. Left external and
// dynamically `import()`-ed at its one call site instead (see src/cli.ts).
const EXTERNAL = ['@cocalc/fuse-native', 'better-sqlite3', 'open'];

async function main() {
    await esbuild.build({
        entryPoints: ['src/cli.ts'],
        outfile: 'dist/cli.js',
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        sourcemap: true,
        logLevel: 'info',
        external: EXTERNAL,
        banner: { js: '#!/usr/bin/env node' },
        // @protontech/crypto's openpgp dependency only ships its
        // (WebCrypto-based, Node 20+ has globalThis.crypto.subtle) entry
        // point under the "browser" export condition — the official CLI
        // gets this for free because Bun's resolver applies it by default;
        // esbuild needs it requested explicitly.
        conditions: ['browser'],
    });
    fs.chmodSync('dist/cli.js', 0o755);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
