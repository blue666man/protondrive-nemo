# Vendored code

This project depends on parts of Proton's official Drive SDK
(https://github.com/ProtonDriveApps/sdk, MIT licensed) that are not published
to npm because they live under that repo's `incubating/` directory. Rather
than reimplementing Proton's authentication/session and SDK-bootstrap logic
(SRP, session forking, encrypted local caching, event-cursor persistence),
this project vendors and, where necessary, ports that code from Bun to Node.

## `vendor/proton-drive-sdk-account/`

Copied verbatim (implementation files only, tests dropped) from
`incubating/account/js/src` at commit `df3a717bb8123791abf115a1dd171cb66813e9f4`
of `ProtonDriveApps/sdk`. No source changes — it has no Bun-specific APIs.

To re-sync with upstream:

```bash
git clone --depth 1 https://github.com/ProtonDriveApps/sdk.git /tmp/protondrive-sdk
cp /tmp/protondrive-sdk/incubating/account/js/src/*.ts vendor/proton-drive-sdk-account/src/
rm vendor/proton-drive-sdk-account/src/*.test.ts
```

Then re-check `src/sdk-bootstrap/` (below) still matches the interfaces this
module exports (`SessionCredentials`, `Auth`, `ApiClient`, `Addresses`,
`Srp`, `initAccount`).

## `src/sdk-bootstrap/`

Ported (not vendored verbatim — adapted from Bun to Node) from the official
`proton-drive` CLI (`cli/src/{api,cache,events,credentials}`,
`cli/src/clientUid.ts`, `cli/src/config.ts`) at the same commit above. This is
the plumbing `@protontech/drive-sdk`'s `ProtonDriveClient` requires the host
application to provide: an HTTP client wired to the account session, an
encrypted-at-rest SQLite entities/crypto cache, and an event-cursor
persistence layer so the SDK can use event-based sync instead of polling.

Changes from upstream (mechanical, except the credentials store below):

- `cache/sqliteCache.ts`: `bun:sqlite``Database` → `better-sqlite3`.
- `clientUid.ts`: `Bun.file`/`Bun.write` → `node:fs/promises`.
- `credentials/secretCredentialsStore.ts` (`Bun.secrets` in upstream, then
  `keytar` here) was replaced by the GnuPG store
  `credentials/gpgCredentialsStore.ts` from
  [NioZow/protondrive-fuse](https://github.com/NioZow/protondrive-fuse)
  (commit `ccc0c22`). Env vars are renamed `PROTONDRIVE_GPG_*` →
  `PROTONDRIVE_NEMO_GPG_*` in comments and in the error string of
  `credentials/index.ts`. Deliberate deviations from the audited code in
  `gpgCredentialsStore.ts`:
  - encryption passes `--auto-key-locate clear,local --no-auto-key-retrieve`,
    so the session is only ever encrypted to a key already in the local
    keyring. gpg's default lookup includes WKD: with a mistyped or
    not-yet-imported recipient it would fetch a key over the network and,
    under `--trust-model always`, encrypt the account-wide session to it.
    `clear` is needed because mechanisms set in `gpg.conf` otherwise still
    apply. Decryption passes `--no-auto-key-retrieve` too, so no key is
    fetched there either.
  - the file is written atomically (0600 temp file, fsync, rename, directory
    fsync) instead of `writeFile` in place: the session is re-saved on every
    token refresh, and a torn file would force a re-login.
  The session is encrypted to `PROTONDRIVE_NEMO_GPG_RECIPIENT` and kept in
  `PROTONDRIVE_NEMO_CREDENTIALS_FILE` (default `<appDir>/auth-session.gpg`);
  decryption goes through `gpg-agent`. There is no keychain fallback, and
  `keytar` (with `credentials/constants.ts`, which only it used) is gone.
  `credentials/index.ts` and the `gpgRecipient`/`credentialsFile` parts of
  `config.ts` follow NioZow's versions.
- Dropped `credentials/passCredentialsStore.ts` (pass(1) support) and the
  CLI's own command/REPL/telemetry layers — out of scope for a FUSE daemon.
- `api/serverTimeHook.ts`: added straight from upstream commit
  `8a44654aece1609f0f7218be51c205103945abd8` (`cli/src/api/serverTimeHook.ts`,
  landed after the commit pinned above). No source changes — it has no
  Bun-specific APIs. Keeps `@protontech/crypto`'s notion of server time in
  sync with the API's `x-pm-date`/`date` response headers, so a device clock
  running ahead of Proton's servers doesn't produce future-dated keys and
  signatures that the API rejects. Wired into `api/index.ts`'s
  `afterResponseHooks`, ahead of `createDriveRequirementAfterResponseHook`,
  same as upstream.

This module is not a general-purpose library; it's this project's own
adapted copy of Proton's reference wiring, kept in its own directory so the
provenance and the changes listed above stay easy to audit against upstream.
