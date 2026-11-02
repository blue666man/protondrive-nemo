/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `condition` every 10 ms until it holds; rejects after `timeoutMs`. */
export async function waitFor(condition: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await sleep(10);
    }
}
