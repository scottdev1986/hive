#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <artifact-dir> <toolchain-lock.json> <stamp-path>" >&2
  exit 2
fi
ARTIFACT=$1
LOCK=$2
STAMP=$3

# Nothing to heal: no stamp to distrust, or no artifact to distrust it about. A missing manifest is a cache that was never published, not a poisoned one — the stamp cannot outlive its own artifact, and make rebuilds either way.
[[ -f "$STAMP" && -f "$ARTIFACT/artifact-manifest.json" ]] || exit 0

if "$ROOT/scripts/native/ghostty-artifact-lock-check.sh" "$ARTIFACT" "$LOCK"; then
  exit 0
fi

/bin/rm -f "$STAMP"
echo "cached GhosttyKit artifact does not match the toolchain lock; forcing rebuild"
