// Builds the TypeScript tests in test/<suite>/ with esbuild, then runs them
// with Node's built-in test runner. Usage: node test/run.js [suite]
// (default suite: unit). Output goes to .test-build/ (gitignored).
//
// Like esbuild.config.js, each test file is bundled together with the code
// it imports into one CommonJS file: @protontech/* ship raw TypeScript and
// extensionless ESM that Node cannot load directly. @cocalc/fuse-native is
// replaced by an in-memory stub, so no /dev/fuse and no native build are
// needed. The other native modules must not be reachable from tested code.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const esbuild = require('esbuild');

const suite = process.argv[2] ?? 'unit';
const srcDir = path.join('test', suite);
const outDir = path.join('.test-build', suite);

const forbidNativeModules = {
    name: 'forbid-native-modules',
    setup(build) {
        build.onResolve({ filter: /^(keytar|better-sqlite3)$/ }, (args) => ({
            errors: [{ text: `${args.path} must not be loaded by tests (imported from ${args.importer})` }],
        }));
    },
};

async function main() {
    const entryPoints = fs
        .readdirSync(srcDir)
        .filter((name) => name.endsWith('.test.ts'))
        .map((name) => path.join(srcDir, name));
    fs.rmSync(outDir, { recursive: true, force: true });
    await esbuild.build({
        entryPoints,
        outdir: outDir,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        sourcemap: 'inline',
        logLevel: 'warning',
        // Same reasons as in esbuild.config.js.
        external: ['open'],
        conditions: ['browser'],
        alias: { '@cocalc/fuse-native': './test/stubs/fuse-native.ts' },
        plugins: [forbidNativeModules],
    });
    const outFiles = entryPoints.map((entry) => path.join(outDir, `${path.basename(entry, '.ts')}.js`));
    const result = spawnSync(
        process.execPath,
        ['--enable-source-maps', '--test', '--test-reporter=spec', ...outFiles],
        { stdio: 'inherit' },
    );
    process.exit(result.status ?? 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
