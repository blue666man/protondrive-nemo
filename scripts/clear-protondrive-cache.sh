#!/usr/bin/env bash
# Deletes the locally cached decrypted file contents for the Proton Drive
# mount, without touching anything in the cloud. The mount downloads and
# decrypts a file again on its next open (see contentStore.ts). Bound to a
# Nemo right-click action by install-nemo-clear-cache-action.sh.
#
# Safe while files are open or have unsaved changes: changes waiting to
# upload live in pending/, which this never touches, and open handles keep
# their own file descriptor. Only blobs/ (the read cache) is emptied.
set -euo pipefail

MOUNT_POINT="${PROTONDRIVE_NEMO_MOUNT_POINT:-$HOME/ProtonDrive}"
CACHE_DIR="${PROTONDRIVE_NEMO_DATA_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/protondrive-nemo}/blobs"

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
    echo "Usage: $0 <path>" >&2
    exit 1
fi

REAL_TARGET="$(realpath -m "$TARGET")"
REAL_MOUNT="$(realpath -m "$MOUNT_POINT")"

notify() {
    notify-send "Proton Drive" "$1" 2>/dev/null || echo "$1"
}

if [[ "$REAL_TARGET" != "$REAL_MOUNT" ]]; then
    notify "Right-click the ProtonDrive folder itself to clear its cache."
    exit 0
fi

if [[ -d "$CACHE_DIR" ]]; then
    find "$CACHE_DIR" -mindepth 1 -delete
fi

notify "Cleared local Proton Drive cache. Files remain in the cloud and will re-download when opened."
