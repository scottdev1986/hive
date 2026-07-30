#!/bin/bash
# Exits 0 iff <artifact-dir>/artifact-manifest.json exists and records exactly
# the toolchain lock's ghostty source identity. Any missing file, missing key,
# empty value, or mismatch exits 1 — fail closed: callers treat the artifact
# as stale and rebuild.
#
# The shared-cache key (ghostty-<commit>-zig-<version>) deliberately omits the
# other locked inputs, so "same directory" does NOT imply "same inputs": a
# patch-series change without a commit bump reuses the key. Do not accept a
# same-key mismatched incumbent — a stale engine fails every Workspace pane
# attach at the engine-build-id fence ("renderer disconnected").
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <artifact-dir> <toolchain-lock.json>" >&2
  exit 2
fi
ARTIFACT=$1
LOCK=$2
MANIFEST="$ARTIFACT/artifact-manifest.json"
[[ -f "$MANIFEST" && -f "$LOCK" ]] || exit 1

for key in commit patchedTree patchSeriesSha256 upstreamPublicHeaderSha256 bridgeHeaderSha256 symbolListSha256; do
  locked=$(/usr/bin/plutil -extract "ghostty.$key" raw -o - "$LOCK" 2>/dev/null) || exit 1
  recorded=$(/usr/bin/plutil -extract "source.$key" raw -o - "$MANIFEST" 2>/dev/null) || exit 1
  [[ -n "$locked" && "$locked" == "$recorded" ]] || exit 1
done

# The engine build id incorporates Zig's optimize mode. A same-source Debug
# archive is therefore incompatible with the ReleaseFast checkpoint/session
# fence even though its source tuple matches the lock.
optimize_mode=$(/usr/bin/plutil -extract buildEnvironment.optimizeMode raw -o - "$MANIFEST" 2>/dev/null) || exit 1
[[ "$optimize_mode" == "ReleaseFast" ]] || exit 1
