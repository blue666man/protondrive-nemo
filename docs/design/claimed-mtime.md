# Preserving file modification times (claimed mtime) — Design

Status: proposal

## Goal

Make the mount behave like a normal filesystem for `rsync -a` and `cp -p`, in both
directions:

- a file copied onto the mount keeps its own modification time, and Proton's apps show
  that time;
- a file copied off the mount keeps the time Drive has for it;
- a second `rsync` pass over unchanged files uploads nothing;
- uploads that are still pending survive unmount, a crash or shutdown, without making
  either of those hang.

Root access is a separate change.

References below are to this repository at `main` (`a022c0e`) and to the Drive SDK
repository ([ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk)) at tag
`js/v0.23.0` (`8a44654`), the release behind `@protontech/drive-sdk` 0.23.0. SDK paths are
relative to `client/js/src/`.

## Problem

**The reported mtime is the wrong time.** `statFor` reports `node.modificationTime` as
mtime, atime and ctime (`src/fuseOps.ts:46`, `:50-52`). That field is the server's link
ModifyTime (`internal/nodes/apiService.ts:859`), which the SDK documents as "Modified on
server (renamed, moved, etc.)" (`interface/nodes.ts:94-96`). Renaming or moving a file
changes its reported mtime; the file's real modification time is never shown.

**Uploads claim "now".** Both upload paths pass `modificationTime: new Date()`
(`src/contentStore.ts:92` for new files, `:105` for revisions), so the source file's
mtime is lost on the way up as well.

**No `utimens`, `chmod` or `chown`.** The operations table (`src/fuseOps.ts:159-526`)
implements getattr, readdir, open, create, read, write, ftruncate, truncate, release,
mkdir, unlink, rmdir and rename. Everything else returns `ENOSYS`, so every `utimensat`
and `chmod` that `rsync -a` issues fails and rsync exits with code 23 (partial transfer).

**Every rsync pass re-uploads every file.** rsync's quick check compares size and mtime.
The mtime on the mount never equals the source mtime, so each run transfers, and
uploads, every file again.

**`release` does not delay `close()`.** The kernel sends FUSE `release` after `close()`
has already returned (the code says so at `src/fuseOps.ts:396-397`). Holding the
`release` reply until the upload finishes (`src/fuseOps.ts:383-391`) does not hold back
the caller. rsync's sequence for each file is: write a temporary `.name.XXXXXX`, then
`close`, `utimensat` and `rename` onto the final name. The `utimensat` and `rename` can
arrive while the upload is still running. By then `finalizeNewFile` has already removed
the pending entry (`src/fuseOps.ts:144`), and the Drive node does not exist yet. The
error code a `release` returns (`src/fuseOps.ts:367`) never reaches the application
either.

**Replacing a file loses its history.** Renaming a pending new file onto an existing
Drive file trashes the existing node and uploads a fresh one (`src/fuseOps.ts:470-474`).
An rsync update of an existing file therefore fills the Trash, and the file's revision
history starts over.

## SDK facts this design rests on

**Two times per node** (`interface/nodes.ts`):

| Field | Meaning |
|---|---|
| `node.modificationTime` (`:96`) | server link ModifyTime; changes on rename, move, etc. |
| `node.activeRevision.claimedModificationTime` (`:102`, `:201`) | the file's own mtime, encrypted in the revision's extended attributes |
| `node.folder.claimedModificationTime` (`:103-106`) | the same for folders |
| `activeRevision.claimedDigests.sha1` (`:202-205`) | SHA-1 of the content, computed by the SDK during upload (`internal/upload/streamUploader.ts:305`) |

- `UploadMetadata.modificationTime` (`interface/upload.ts:40`) sets the claimed time of a
  new file or revision.
- `createFolder(parent, name, modificationTime?)` (`protonDriveClient.ts:748`) sets it for a
  folder, at creation only.
- There is **no metadata-only update**: `renameNode` (`protonDriveClient.ts:603`) changes
  only the name, and no other client method touches extended attributes. Changing a
  file's claimed time means uploading a new revision.

**The SDK already queues and throttles uploads:**

| Limit | Where |
|---|---|
| at most 5 concurrent file uploads | `internal/upload/queue.ts:11` |
| about 40 MiB in flight, weighted by expected size (10 × 4 MiB blocks) | `internal/upload/queue.ts:20`, `internal/upload/streamUploader.ts:24` |
| per file: 15 buffered and 5 uploading blocks | `internal/upload/streamUploader.ts:63`, `:69` |
| 429 handling with `Retry-After` (default 10 s) | `internal/apiService/apiService.ts:77`, `:359-361` |
| 60 s cool-down after 50 consecutive 429s | `internal/apiService/apiService.ts:35`, `:41` |

`getFileUploader` waits for queue admission before it returns
(`internal/upload/index.ts:62`, `:94` for revisions). It accepts an `AbortSignal`
(`protonDriveClient.ts:1119-1127`), which also cancels the wait.

## 1. Read side

`statFor` (`src/fuseOps.ts:43-59`) becomes:

| Field | Files | Folders |
|---|---|---|
| `mtime` | `activeRevision.claimedModificationTime ?? node.modificationTime` | `folder.claimedModificationTime ?? node.modificationTime` |
| `ctime` | `node.modificationTime` | `node.modificationTime` |
| `atime` | `mtime` | `mtime` |

Files uploaded by other clients without a claimed time keep today's behaviour. `ctime`
keeps its POSIX meaning: the last metadata change on the server.

## 2. Write side: settle window

A single `PendingUpload` state replaces `NewFileState` and `newFileStates`
(`src/fuseOps.ts:33-41`, `:120`). It covers both new files and new revisions of existing
files:

```
PendingUpload { path, kind: 'new' | 'revision', parentUid, name, nodeUid?, localPath, refCount, timer }
```

A dirty file is not uploaded on `release`. It waits for a short **settle window**
(default 2 s, `PROTONDRIVE_NEMO_SETTLE_MS`) in which `utimens` and `rename` can still change
what gets uploaded. This generalises the existing 500 ms grace window for empty new files
(`src/fuseOps.ts:127`).

| Event | Behaviour |
|---|---|
| `release` of a dirty file | ack now; pending; settle timer 2 s (`PROTONDRIVE_NEMO_SETTLE_MS`) |
| `utimens` while pending or open | `fs.utimes(localPath)`; restart the timer |
| `utimens` on a committed node | accept, ignore |
| `rename` of a pending new file | retarget in memory, no server call |
| ↳ dest is an existing Drive file | becomes a **pending revision of dest** (keeps history; no Trash copy) |
| `rename` of a file with a pending revision | server rename/move as today; the pending entry follows the node |
| `open` while pending | serve the local copy; pause via refCount |
| `getattr`/`readdir` while pending | answer from the local copy |
| `truncate`/`write` while pending | local; still pending |
| `unlink` while pending | new file: cancel. Revision: cancel, then trash as usual |
| timer fires | upload once, under the final name, with claimed mtime = `stat(localPath).mtime` |

Notes:

- `open` must check pending state before `ensureDownloaded`. Its freshness check compares
  the local size with the remote `claimedSize` (`src/contentStore.ts:49-54`), so a pending
  revision of a different size would otherwise be overwritten by a fresh download.
- `evict` must refuse a pending path, just as it refuses a path with unsaved changes
  today (`src/ipcServer.ts:120-123`).
- `chmod` and `chown` are accepted as no-ops. Drive has no POSIX modes or owners, and
  failing them makes `rsync -a` exit 23.
- For folders, the claimed time can only be set by `createFolder`, which happens at
  `mkdir` (`src/fuseOps.ts:413`), before rsync knows the time. A later `utimens` on a
  folder is accepted and ignored, like any committed node.

## 3. Durability, shutdown, errors

**Journal.**

- `pending.json` in the profile's cache dir, written atomically (write a temporary file,
  fsync, rename) and fsynced:

  ```
  { id, kind, parentUid, name, nodeUid?, baseRevisionUid?, blob, claimedMtime, attempts, state }
  ```

- Blobs live in a `pending/` dir beside `blobs/` (`src/mount.ts:24`). Neither the
  whole-cache clear action, which only empties `blobs/`
  (`scripts/clear-protondrive-cache.sh:15`), nor `evict` touches a blob while the
  journal references it.
- `baseRevisionUid` is the node's active revision when the revision became pending.

**Shutdown is bounded.** On unmount, SIGINT or SIGTERM (handled today at
`src/cli.ts:99-110`):

1. stop starting uploads;
2. give in-flight uploads a grace period (10 s, `PROTONDRIVE_NEMO_SHUTDOWN_GRACE_MS`), then
   abort them via `AbortSignal`;
3. fsync the journal;
4. unmount.

Nothing hangs on a large backlog, even at system shutdown. Aborted and not-yet-started
uploads stay in the journal.

**Resume, status and flush.**

- The next `mount` replays the journal in the background.
- `protondrive-nemo unmount` prints how many uploads are pending, and
  `protondrive-nemo status` shows pending and failed counts. Both ask the running daemon
  over the existing IPC socket (`src/ipcServer.ts`) through a new request type; today
  `status` (`src/cli.ts:74-86`) reports only login state and the mount point, and
  `unmount` (`src/cli.ts:113-123`) calls `Fuse.unmount` directly.
- A new `protondrive-nemo flush` command uploads everything pending and waits, for
  scripts that need the data on Drive before they continue.

**Conflicts on replay.**

- A revision whose node's current revision ≠ `baseRevisionUid`, or a new file whose name
  now exists: upload as `name (conflict YYYY-MM-DD HHMM).ext`.
- If the remote revision's `claimedDigests.sha1` equals the blob's SHA-1, the upload had
  already landed before the journal was updated: drop the entry instead.
- Never silently overwrite remote changes.

**Errors.**

- Concurrency and rate limits: the SDK's queue. The blob read stream is opened only after
  `getFileUploader` admits the upload; the same `AbortSignal` is passed through.
- Driver retry/backoff (1 s → 5 min) only for errors the SDK gives up on.
- Permanent 4xx/validation errors: mark `failed`, keep the blob, log it, show it in
  `status`; no retry loop.

## 4. Testing

All three tiers are part of the change. The repository has no tests today.

**Tier 1: unit tests** (`test/unit`, `npm test`):

- `node:test` plus the existing esbuild, with `@cocalc/fuse-native` aliased to a stub.
- `FakeDrive` is an in-memory SDK client with an upload record (name, parent, claimed
  time, content hash) and injectable delays, failures, 429s and remote conflicts.
- Covers every event order in section 2, plus journal replay, the shutdown bound,
  conflict copies and permanent failures.

**Tier 2: real kernel FUSE with FakeDrive** (`test/mount`, `npm run test:mount`):

- needs `/dev/fuse` and the native modules;
- runs real `rsync -a` twice (the second run uploads nothing), `cp -p`, `touch -d`, `mv`
  across folders and an editor-style save;
- asserts one upload per file, the right name and the right claimed time.

**Tier 3: live** (`test/live/lifecycle.sh`, run by a maintainer against a real account,
never in CI):

- works in a throwaway Drive folder created for the run and removed at the end;
- lifecycle (a): a local file with an old mtime → `rsync -a` onto the mount → the Drive
  web app shows the old time;
- lifecycle (b): a file created in the web app → `rsync -a` off the mount keeps its
  time;
- times persist across a remount;
- killing the daemon inside the settle window, then remounting, replays the upload.

**Development environment.** Node 22, libfuse 2 headers, a C toolchain;
`npm ci --ignore-scripts` then `npm rebuild @cocalc/fuse-native better-sqlite3`. Tier 2
needs `/dev/fuse`. No new runtime or dev dependencies. `keytar` is only used by the
session store (`src/sdk-bootstrap/credentials/secretCredentialsStore.ts:1`), which the
tests never load, so its native build is not needed to run them.

## Decisions

| Topic | Decision |
|---|---|
| mtime write strategy | Settle window, 2 s by default (`PROTONDRIVE_NEMO_SETTLE_MS`) |
| `utimens` on a committed node | Accept and ignore. An error would make `rsync -a` exit 23 for every directory, and the SDK cannot change a claimed time without a new revision |
| Upload concurrency | None in the driver; the SDK queue already limits files, bytes in flight and blocks, and handles 429s |
| Testing | All three tiers |

**Rejected: upload immediately, then re-upload on `utimens`.** Uploading on `release`
and sending a second revision when the claimed time changes needs no timer, but it
doubles every upload rsync makes and leaves an extra revision in each file's history.
