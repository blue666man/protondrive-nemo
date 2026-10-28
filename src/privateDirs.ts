import { chmod, mkdir } from 'node:fs/promises';

/**
 * Creates `dir`, and any missing parents, as 0700 (owner only). An existing
 * directory keeps its mode: the data dirs can be chosen by an administrator
 * (PROTONDRIVE_NEMO_DATA_DIR), who may have given them a deliberate mode.
 */
export async function mkdirPrivate(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Like mkdirPrivate, but an existing `dir` is also tightened to 0700. Only
 * for directories this program owns outright, such as the decrypted blob
 * cache, which older versions created 0755.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
    await mkdirPrivate(dir);
    await chmod(dir, 0o700);
}
