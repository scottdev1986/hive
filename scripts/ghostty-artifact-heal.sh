#!/bin/bash
# Drops a lock stamp that certifies a cached GhosttyKit artifact whose manifest
# does NOT record the lock's source identity, so make rebuilds and republishes
# instead of trusting it. Prints one line when it drops a stamp, silent
# otherwise. Never touches the artifact itself.
#
# This MUST run while make is PARSING, not as a prerequisite of the stamp rule.
# GNU Make 3.81 (what macOS ships) stats a target once and decides then whether
# to remake it, so a recipe that deletes the stamp later — even from an
# order-only prerequisite — changes nothing: the rebuild never runs, make
# exits 0, and the stamp is silently gone. Without a parse-time heal, a stale
# cached artifact stages a Workspace app whose embedded engine build id
# disagrees with sessiond, every pane attach fails the engine fence, and the
# pane reads "renderer disconnected".
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <artifact-dir> <toolchain-lock.json> <stamp-path>" >&2
  exit 2
fi
ARTIFACT=$1
LOCK=$2
STAMP=$3

# Nothing to heal: no stamp to distrust, or no artifact to distrust it about.
# A missing manifest is a cache that was never published, not a poisoned one —
# the stamp cannot outlive its own artifact, and make rebuilds either way.
[[ -f "$STAMP" && -f "$ARTIFACT/artifact-manifest.json" ]] || exit 0

if "$ROOT/scripts/ghostty-artifact-lock-check.sh" "$ARTIFACT" "$LOCK"; then
  exit 0
fi

/bin/rm -f "$STAMP"
echo "cached GhosttyKit artifact does not match the toolchain lock; forcing rebuild"
