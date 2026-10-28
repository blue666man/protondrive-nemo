# protondrive-nemo

An unofficial FUSE mount of [Proton Drive](https://proton.me/drive) for
Linux Mint's Nemo file manager (and any other file manager, since it's a
real mountpoint — Nautilus, Thunar, Dolphin, etc. all work too).

> **This is a third-party application, not officially supported by Proton.**
> It is not affiliated with, endorsed by, or connected to Proton AG. It is
> built on Proton's official, MIT-licensed [Drive SDK](https://github.com/ProtonDriveApps/sdk),
> under that SDK's guidelines for personal, non-commercial use.

## What it does

Mounts your Proton Drive "My Files" at `~/ProtonDrive` as a normal folder:
browse, open, edit and save, create folders, rename, move, and delete —
Nemo (or any file manager, or any application) sees it like any other
directory. There's no separate sync engine or Nemo extension involved: it's
a real FUSE filesystem, so file-manager integration comes for free.

## How it works

- **Auth & Drive API access**: via Proton's official SDK
  (`@protontech/drive-sdk` + a vendored copy of its `incubating/account`
  module — see [VENDOR.md](VENDOR.md) for why that's vendored rather than
  installed from npm). Sign-in is the same browser-based flow Proton's own
  apps use — no password is ever typed into this tool.
- **Filesystem**: [`@cocalc/fuse-native`](https://github.com/sagemathinc/fuse-native)
  (an actively maintained N-API FUSE binding). See
  [Architecture](#architecture) below for how FUSE calls map to Drive API
  calls.
- **Session storage**: your login session is stored in the OS keychain via
  `keytar` (libsecret/GNOME Keyring on Linux), under its own service name
  — separate from Proton's official `proton-drive` CLI, so both can be
  installed without conflicting. The keychain *account* name is scoped by
  `--account` (`auth-session` for the default account, `auth-session-<name>`
  for others) — see [Multiple accounts](#multiple-accounts).

## Requirements

- Linux with `libfuse` (either `libfuse2`/`fuse` or `libfuse3`/`fuse3` — most
  distros, including Linux Mint, have one of these by default) and
  `libfuse-dev` to build the native binding.
- Node.js 20+.
- A Secret Service provider for session storage (GNOME Keyring, which Linux
  Mint ships by default, or KWallet with the appropriate libsecret backend).

## Build

```bash
npm install
npm run build
```

This produces `dist/cli.js`. `npm install` needs `libfuse-dev` present to
compile the native FUSE binding:

```bash
sudo apt install libfuse-dev   # Debian/Ubuntu/Linux Mint
```

## Tests

```bash
npm test
```

Runs the unit tests in `test/unit/` with Node's built-in test runner, after
bundling them with esbuild (`test/run.js`). The FUSE binding is replaced by
an in-memory stand-in (`test/stubs/fuse-native.ts`), so the tests need
neither `/dev/fuse` nor any native module to be built.

## Usage

```bash
node dist/cli.js login     # opens your browser to sign in to Proton
node dist/cli.js mount     # mounts ~/ProtonDrive, runs in the foreground
```

In another terminal (or Ctrl+C the `mount` process to unmount):

```bash
node dist/cli.js unmount
```

Other commands: `node dist/cli.js status`, `node dist/cli.js logout`.

Add `-m /custom/path` to `mount`/`unmount`/`status`/`evict` to use a
different mount point than the default `~/ProtonDrive`.

### Let root use the mount

A FUSE mount is private to the user who mounted it: even root gets
"Permission denied". To let root use it as well (for example a backup job
running as root), set `PROTONDRIVE_NEMO_FUSE_ALLOW_ROOT=1` for the `mount`
command. libfuse accepts this only when `/etc/fuse.conf` contains the line
`user_allow_other`; without it the mount fails to start.

```bash
PROTONDRIVE_NEMO_FUSE_ALLOW_ROOT=1 node dist/cli.js mount
```

### Run automatically on login

```bash
mkdir -p ~/.config/systemd/user
ln -s "$(pwd)/systemd/protondrive-nemo.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now protondrive-nemo
```

### Add a Nemo sidebar shortcut

```bash
./scripts/install-nemo-bookmark.sh        # bookmarks ~/ProtonDrive
nemo -q                                    # restart Nemo to pick it up
```

### Multiple accounts

Every command takes `-a, --account <name>` to operate on an isolated
account profile: its own keychain session, its own cache/app dir
(`$XDG_CACHE_HOME/protondrive-nemo-<name>`,
`$XDG_DATA_HOME/protondrive-nemo-<name>`), and its own default mount point
(`~/ProtonDrive-<name>`). Omitting `--account` (or passing `--account
default`) is exactly today's single-account behavior — nothing changes for
an existing install.

```bash
node dist/cli.js login --account work
node dist/cli.js mount --account work     # mounts ~/ProtonDrive-work
```

To run a second account as an always-on background service alongside the
default one, use the templated unit — it doesn't touch the existing
`protondrive-nemo.service`:

```bash
ln -s "$(pwd)/systemd/protondrive-nemo@.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now protondrive-nemo@work
```

Add its own sidebar bookmark the same way, just pointed at its mount point:

```bash
./scripts/install-nemo-bookmark.sh ~/ProtonDrive-work
```

**Not yet multi-account aware**: the two "Clear cache" right-click actions
and the cache-status emblem/column extension below all resolve a single
global `PROTONDRIVE_NEMO_MOUNT_POINT`/`PROTONDRIVE_NEMO_DATA_DIR` pair once,
at Nemo's own process startup — Nemo is one long-running process, so there's
no per-file-path dispatch to the right account's daemon yet. They'll keep
working for whichever one account they're pointed at; the mounts themselves
(browsing, reading, writing) work fully and correctly for every
simultaneously-running account regardless.

### Add a "Clear cache" right-click action

Adds a right-click entry (on folders) that deletes the locally cached
decrypted copies of your files without deleting anything from Drive — the
next time you open a file it just re-downloads and re-decrypts. The action
only acts when used on the `~/ProtonDrive` folder itself; on any other
folder it's a no-op.

```bash
./scripts/install-nemo-clear-cache-action.sh
nemo -q                                    # restart Nemo to pick it up
```

Don't run it while a file under the mount is open with unsaved changes —
see the caution comment in `scripts/clear-protondrive-cache.sh`. Unlike the
per-file action below, this one has no guard against that: it blindly clears
the whole cache dir regardless of what's open.

There's also a per-file version — a "Clear cached copy" entry on individual
files (multi-selection supported) that evicts just that file's cache entry
via the running mount daemon's IPC socket (`protondrive-nemo evict <path>`,
see `src/ipcServer.ts`). Unlike the whole-cache action, this one refuses to
run (with a clear error) if the file currently has unsaved changes open, so
it can't corrupt an in-progress edit.

```bash
./scripts/install-nemo-clear-file-cache-action.sh
nemo -q                                    # restart Nemo to pick it up
```

Note: evicting an image and then immediately redisplaying its folder in
Nemo can make it look like nothing happened — Nemo re-reads the file to
regenerate its thumbnail whenever it redisplays a folder, which silently
re-downloads it seconds later. The eviction itself did work (confirmed via
the daemon's own logs); this is just an inherent side effect of any
thumbnailing file manager reading image bytes to draw a preview, the same
way a browser re-fetches an image on revisiting a page even after clearing
cache. Evicting a file you're not actively browsing in Nemo stays evicted.

### Show cache status in Nemo (emblem + column)

A `nemo-python` extension (`nemo-extension/protondrive_cache_status.py`)
marks whether each file/folder under the mount is already downloaded and
decrypted locally, or would need a fresh fetch from Drive on open. It
queries the running mount daemon's IPC socket directly (op `cacheStatus`
in `src/ipcServer.ts`) — no `node`/nvm dependency, unlike the shell-script
actions above. A folder's status reflects everything inside it,
recursively, up to a 1.2s-per-lookup time budget (see
`CACHE_STATUS_DEADLINE_MS` in `ipcServer.ts`); anything not resolved in
time reports as unknown (no status shown) rather than blocking Nemo —
expect most folders in a large/deep Drive to show nothing at first, filling
in on repeat views as the daemon's listing cache warms up.

This shows up two ways, since neither is complete on its own:

- **An emblem overlay** on the icon itself (small checkmark/cloud/dash
  badge), visible in both Icon and List View. Nemo has a confirmed,
  unfixed upstream bug ([linuxmint/nemo#2875](https://github.com/linuxmint/nemo/issues/2875))
  where this silently fails to draw on any file whose real thumbnail
  renders smaller than the emblem — in practice this means photos, PDFs,
  and other files with a real content thumbnail often don't show the
  badge, while folders and thumbnail-less files reliably do.
- **A "Proton Drive Cache" list-view column** ("Cached" / "Not cached" /
  "Partially cached" text), unaffected by that bug since it's a plain
  table cell, not composited onto the thumbnail. Opt-in: enable it via
  List View's *Visible Columns* (right-click a column header, or the View
  menu). This is the reliable option for photo-heavy folders.

```bash
./scripts/install-nemo-cache-emblems.sh
nemo -q                                    # restart Nemo to pick it up
```

## Architecture

```
src/cli.ts              commander CLI: login, logout, status, mount, unmount
src/mount.ts             wires DriveTree + ContentStore + FUSE ops into a Fuse instance
src/fuseOps.ts            FUSE syscall handlers (getattr, readdir, read, write, ...)
src/driveTree.ts          FUSE path <-> Drive node UID resolution + short-lived directory-listing cache
src/contentStore.ts        local blob cache: download-on-open, upload-on-release
src/ipcServer.ts            Unix-socket control channel for the `evict` CLI command
                            and the cache-status Nemo extension to talk to the
                            running mount daemon
nemo-extension/             nemo-python extension: cache-status emblem + list-view
                            column (see install-nemo-cache-emblems.sh)
src/sdk-bootstrap/         bootstraps @protontech/drive-sdk's ProtonDriveClient:
                            auth (via vendored proton-drive-sdk-account), HTTP client,
                            encrypted SQLite entities/crypto cache, event-cursor persistence
                            — ported from ProtonDriveApps/sdk's own CLI, see VENDOR.md
vendor/proton-drive-sdk-account/  vendored (unpublished) Proton auth/session module
src/types/stubs/           tsc-only type stand-ins for @protontech/crypto — see the
                            comment at the top of protontech-crypto.ts for why
```

Content model: opening a file downloads it in full to a local cache
(`$XDG_CACHE_HOME/protondrive-nemo/blobs/`, decrypted) before any byte is
readable, and a dirty file is re-uploaded as a new revision on close. This
is simple and reliable but means very large files are slower to open than a
true byte-range/streaming implementation would be — a reasonable v1
tradeoff given Proton's own SDK doesn't yet ship a sync module to build a
smarter cache on top of (see [VENDOR.md](VENDOR.md)).

Directory listings are cached in memory per folder for 10 seconds to avoid
re-iterating a folder's children on every single FUSE `getattr`/`readdir`
call (Nemo issues a lot of these per visible file); mutations you make
locally (create/rename/move/delete) invalidate the affected folder's cache
immediately, so your own changes always show up right away.

## Limitations (v1)

- Only "My Files" is exposed — no Trash, Devices, Shared-with-me, or Photos.
- No true streaming: large file opens download the whole file first.
- No conflict handling beyond what the SDK itself does — this isn't a
  background sync engine, just a live view.
- No Nemo-specific extras yet (sync-status emblems, "copy share link" in the
  right-click menu). Since this is a real mount, basic file operations don't
  need them; they're a natural follow-up built on the SDK's sharing API.

## License

MIT — see [LICENSE](LICENSE). Vendors and adapts MIT-licensed code from
[ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk); see
[VENDOR.md](VENDOR.md) for provenance and what was changed.
