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

Changes from upstream, all mechanical (no logic changes):

- `cache/sqliteCache.ts`: `bun:sqlite``Database` → `better-sqlite3`.
- `clientUid.ts`: `Bun.file`/`Bun.write` → `node:fs/promises`.
- `credentials/secretCredentialsStore.ts`: `Bun.secrets` → `keytar`, and the
  keychain service name was changed from `ch.proton.drive/drive-sdk-cli`
  (the official CLI's) to `ch.proton.drive/protondrive-nemo` so this tool's
  session doesn't collide with the official CLI's if both are installed.
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
provenance and the two changes above stay easy to audit against upstream.
