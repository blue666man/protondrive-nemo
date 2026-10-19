/**
 * Type-checking-only stand-in for `@protontech/crypto`.
 *
 * That package ships raw TypeScript source (no compiled .d.ts) with a few
 * internal type errors surfaced only when a whole-program `tsc` walks its
 * source directly (its own build/CI never does this — Proton's own tooling
 * transpiles it with swc/Bun, which doesn't type-check node_modules). Rather
 * than forking their source to fix that, tsconfig.typecheck.json's `paths`
 * (a typecheck-only overlay over tsconfig.json, so esbuild's own tsconfig
 * auto-detection never sees it) redirects every import of
 * `@protontech/crypto` (ours, the vendored account module's, and
 * @protontech/drive-sdk's own .d.ts) to this loose stub for TYPE CHECKING
 * ONLY. esbuild bundles the real package at build time regardless, so
 * runtime behavior is completely unaffected — this file only has to be
 * structurally plausible enough for `tsc -p tsconfig.typecheck.json` to pass.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CryptoApiInterface {
    [method: string]: any;
}

export type PrivateKeyReference = object;
export type PublicKeyReference = object;
export type PrivateKeyReferenceV4 = PrivateKeyReference;

export interface SessionKey {
    data: Uint8Array;
    algorithm: number;
    aeadAlgorithm?: number;
}

export enum VERIFICATION_STATUS {
    NOT_SIGNED = 0,
    SIGNED_AND_VALID = 1,
    SIGNED_AND_INVALID = 2,
}

export interface ExportPrivateKeyOptions {
    privateKey: PrivateKeyReference;
    passphrase: string | null;
}

export interface ImportPrivateKeyOptions {
    armoredKey: string;
    passphrase: string | null;
}

// `declare const` — this file is only ever consulted by tsc (via the
// `paths` redirect below); esbuild bundles the real implementation, so no
// runtime value needs to exist here.
export declare const CryptoProxy: {
    setEndpoint<T extends CryptoApiInterface>(endpoint: T, onRelease?: (endpoint: T) => Promise<void>): void;
    releaseEndpoint(): Promise<void>;
    exportPrivateKey(options: ExportPrivateKeyOptions): Promise<string>;
    importPrivateKey(options: ImportPrivateKeyOptions): Promise<PrivateKeyReference>;
};

export declare function updateServerTime(newServerTime: Date, serverTimeUpdatedAt?: Date): Date;
