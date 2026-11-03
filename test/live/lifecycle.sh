#!/usr/bin/env bash
# Live check of timestamps and pending uploads against a real Proton Drive
# account. Run by hand, never in CI. Needs a running `protondrive-nemo mount`.
#
#   test/live/lifecycle.sh run     [MOUNT]  (a) local → Drive, rsync idempotence, (b) Drive → local
#   test/live/lifecycle.sh kill    [MOUNT]  write a file, then kill -9 the daemon inside the settle window
#   test/live/lifecycle.sh verify  [MOUNT]  after a remount: times persisted, the killed upload replayed
#   test/live/lifecycle.sh cleanup [MOUNT]  remove what this script created
#
# Everything happens under MOUNT/protondrive-nemo-live/ (MOUNT defaults to
# ~/ProtonDrive). PROTONDRIVE_NEMO_CLI overrides the CLI command, and
# PROTONDRIVE_NEMO_PID the daemon's PID for `kill`.
set -euo pipefail

cmd=${1:-}
MOUNT=${2:-$HOME/ProtonDrive}
DIR=$MOUNT/protondrive-nemo-live
LOCAL=${XDG_STATE_HOME:-$HOME/.local/state}/protondrive-nemo-live
CLI=${PROTONDRIVE_NEMO_CLI:-protondrive-nemo}
OLD=200102030405.06 # touch -t: 2001-02-03 04:05:06, local time

fail() {
    echo "FAIL: $*" >&2
    exit 1
}
ok() { echo "ok: $*"; }
mtime() { stat -c %Y "$1"; }
mounted() { mountpoint -q "$MOUNT" || fail "$MOUNT is not mounted"; }

case $cmd in
run)
    mounted
    mkdir -p "$LOCAL/src/sub" "$LOCAL/back" "$DIR/a"
    printf 'old file\n' >"$LOCAL/src/old.txt"
    printf 'nested\n' >"$LOCAL/src/sub/nested.txt"
    touch -t "$OLD" "$LOCAL/src/old.txt" "$LOCAL/src/sub/nested.txt"

    # (a) local → Drive keeps the source time.
    rsync -rlt "$LOCAL/src/" "$DIR/a/"
    "$CLI" flush
    [[ $(mtime "$DIR/a/old.txt") == "$(mtime "$LOCAL/src/old.txt")" ]] || fail "(a) mtime on the mount differs from the source"
    ok "(a) mtime kept: $(date -d "@$(mtime "$DIR/a/old.txt")")"

    # A second run transfers nothing.
    changes=$(rsync -rlt --itemize-changes "$LOCAL/src/" "$DIR/a/" | grep -c '^>f' || true)
    [[ $changes == 0 ]] || fail "the second rsync transferred $changes file(s)"
    ok "the second rsync transferred nothing"

    # (b) Drive → local.
    echo
    echo "In the Proton Drive web app, create protondrive-nemo-live/b/, upload any file into it,"
    echo "note the modification time the web app shows, then press Enter."
    read -r
    rsync -rlt "$DIR/b/" "$LOCAL/back/"
    ls -l --time-style=full-iso "$LOCAL/back/"
    echo "(b) Compare these times with the web app."
    echo "Also check in the web app that protondrive-nemo-live/a/old.txt shows 2001-02-03 04:05."
    ;;
kill)
    mounted
    pid=${PROTONDRIVE_NEMO_PID:-$(pgrep -f 'cli.js mount' | head -1)} || fail "no mount daemon found"
    [[ -n $pid ]] || fail "no mount daemon found"
    mkdir -p "$LOCAL"
    printf 'written just before a crash\n' >"$DIR/killed.txt"
    touch -t "$OLD" "$DIR/killed.txt"
    sleep 0.5 # inside the 2 s settle window, after the journal write
    kill -9 "$pid"
    ok "killed $pid inside the settle window"
    echo "Run: fusermount -uz '$MOUNT'; start the mount again; then: $0 verify $MOUNT"
    ;;
verify)
    mounted
    "$CLI" flush
    [[ $(mtime "$DIR/a/old.txt") == "$(mtime "$LOCAL/src/old.txt")" ]] || fail "a/old.txt lost its time across the remount"
    ok "times persisted across the remount"
    [[ -f $DIR/killed.txt ]] || fail "killed.txt was not replayed"
    [[ $(mtime "$DIR/killed.txt") == "$(mtime "$LOCAL/src/old.txt")" ]] || fail "the replayed killed.txt has the wrong time"
    ok "the upload interrupted by the kill was replayed, with its time"
    ;;
cleanup)
    rm -rf "$DIR" "$LOCAL"
    ok "removed $DIR (now in Drive's Trash) and $LOCAL"
    ;;
*)
    sed -n '2,12p' "$0"
    exit 64
    ;;
esac
