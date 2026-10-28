/**
 * In-memory stand-in for @cocalc/fuse-native, aliased in by test/run.js.
 * Records every `new Fuse(...)` so tests can read the mount options and call
 * the FUSE operation handlers directly. mount()/unmount() succeed at once.
 */
import { constants } from 'node:os';

type Callback = (err: Error | null) => void;

export default class Fuse {
    /** Every instance constructed since the last `Fuse.reset()`, oldest first. */
    static instances: Fuse[] = [];

    static reset(): void {
        Fuse.instances = [];
    }

    /** The most recently constructed instance. */
    static last(): Fuse {
        const fuse = Fuse.instances.at(-1);
        if (!fuse) {
            throw new Error('no Fuse instance was constructed');
        }
        return fuse;
    }

    static unmount(_mnt: string, cb: Callback): void {
        process.nextTick(cb, null);
    }

    mounted = false;

    constructor(
        readonly mnt: string,
        readonly ops: Record<string, (...args: any[]) => void>,
        readonly opts: Record<string, unknown> = {},
    ) {
        Fuse.instances.push(this);
    }

    mount(cb: Callback): void {
        this.mounted = true;
        process.nextTick(cb, null);
    }

    unmount(cb: Callback): void {
        this.mounted = false;
        process.nextTick(cb, null);
    }
}

// fuse-native exposes negated errno constants (Fuse.ENOENT === -2, ...).
for (const [name, value] of Object.entries(constants.errno)) {
    (Fuse as unknown as Record<string, number>)[name] = -value;
}

/** The value fuse-native gives `Fuse.<name>`, e.g. errno('ENOENT') === -2. */
export function errno(name: keyof typeof constants.errno): number {
    return -constants.errno[name];
}
