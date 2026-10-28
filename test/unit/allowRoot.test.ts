import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { mount } from '../../src/mount';
import Fuse from '../stubs/fuse-native';
import { fakeDrive, tempDir } from '../helpers';

const ENV = 'PROTONDRIVE_NEMO_FUSE_ALLOW_ROOT';

let tmp: ReturnType<typeof tempDir>;
let handle: Awaited<ReturnType<typeof mount>> | undefined;

beforeEach(() => {
    tmp = tempDir();
    Fuse.reset();
});

afterEach(async () => {
    delete process.env[ENV];
    await handle?.ipc.stop();
    handle = undefined;
    tmp.cleanup();
});

async function mountOptions(): Promise<Record<string, unknown>> {
    handle = await mount(fakeDrive(path.join(tmp.dir, 'cache')), path.join(tmp.dir, 'mnt'));
    return Fuse.last().opts;
}

test(`${ENV}=1 mounts with allowRoot`, async () => {
    process.env[ENV] = '1';
    assert.equal((await mountOptions()).allowRoot, true);
});

test(`allowRoot is off when ${ENV} is unset`, async () => {
    delete process.env[ENV];
    assert.ok(!(await mountOptions()).allowRoot);
});

test(`allowRoot is off for ${ENV} values other than 1`, async () => {
    process.env[ENV] = 'true';
    assert.ok(!(await mountOptions()).allowRoot);
});
