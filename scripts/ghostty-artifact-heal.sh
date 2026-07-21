#!/bin/bash
# Drops a lock stamp that certifies a cached GhosttyKit artifact whose manifest
# does NOT record the lock's source identity, so make rebuilds and republishes
# instead of trusting it. Prints one line when it drops a stamp, silent
# otherwise. Never touches the artifact itself.
#
# This MUST run while make is PARSING, not as a prerequisite of the stamp rule.
# GNU Make 3.81 (what macOS ships) stats a target once and decides then whether
# to remake it, so a recipe that deletes the stamp afterwards — even an
# order-only prerequisite's, which is where this check first landed — changes
# nothing: the rebuild recipe never runs, the staging rule never runs, make
# exits 0, and the stamp is silently gone. That shipped a Workspace app whose
# embedded engine build id no longer matched sessiond's, so every pane viewer
# attach failed the M3 engine fence and the pane read "renderer disconnected".
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
