export interface ShutdownRun {
    /** Resolves with the number of uploads left for the next mount once they are journalled. */
    drained: Promise<number>;
    /** Resolves with the exit code once every step has run: 0 only if all of them succeeded. */
    done: Promise<number>;
}

export interface ShutdownOptions {
    /** Winds down the uploads (`pending.shutdown(grace)`); resolves with how many are left. */
    drain: () => Promise<number>;
    /** Run in order after the drain, each even if an earlier one failed: [label, step]. */
    steps: Array<[string, () => Promise<void>]>;
    log?: (message: string) => void;
    error?: (message: string, err: unknown) => void;
}

/**
 * The mount daemon's shutdown, shared by SIGINT, SIGTERM and the IPC
 * `shutdown` request: it runs once, however often it is asked for. A later
 * request logs `Already shutting down…` and gets the same run.
 *
 * The steps start only after the turn in which `drained` resolved, so an
 * IPC reply sent on `drained` goes out before the steps stop the server.
 */
export function guardedShutdown(o: ShutdownOptions): (reason: string) => ShutdownRun {
    const log = o.log ?? console.log;
    const error = o.error ?? console.error;
    let run: ShutdownRun | undefined;
    return (reason) => {
        if (run) {
            log('Already shutting down…');
            return run;
        }
        log(`\nUnmounting (${reason})...`);
        const drained = (async () => {
            const remaining = await o.drain();
            if (remaining > 0) {
                log(`${remaining} upload(s) still pending; they resume on the next mount.`);
            }
            return remaining;
        })();
        // Callers may only want `done`; a failed drain is reported through it.
        drained.catch(() => {});
        const done = (async () => {
            let ok = true;
            try {
                await drained;
            } catch (err) {
                ok = false;
                error('Stopping uploads failed:', err);
            }
            await new Promise((resolve) => setImmediate(resolve));
            for (const [label, step] of o.steps) {
                try {
                    await step();
                } catch (err) {
                    ok = false;
                    error(`Shutdown step "${label}" failed:`, err);
                }
            }
            return ok ? 0 : 1;
        })();
        run = { drained, done };
        return run;
    };
}
