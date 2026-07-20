#!/bin/bash
# Qualification-only login-shell shim used by b22-live-attach-proof.ts.
# The harness supplies "-l" because it normally launches a login shell; the
# shim deliberately ignores that argument and starts the B2.4-pinned vttest.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VTTEST="$ROOT/.cache/vttest/install/bin/vttest"
EXPECTED_VERSION='VT100 test program, version 2.7 (20251205)'

if [[ ! -x "$VTTEST" ]]; then
  echo "pinned vttest is missing: $VTTEST" >&2
  echo "build vttest-20251205.tgz after verifying sha256 cd6886f9aefe6a3f6c566fa61271a55710901a71849c630bf5376aa984bf77cc" >&2
  exit 1
fi
if [[ "$($VTTEST -V)" != "$EXPECTED_VERSION" ]]; then
  echo "vttest version does not match the B2.4 pin" >&2
  exit 1
fi

export TERM=xterm-ghostty
export COLORTERM=truecolor
exec "$VTTEST" -u 24x80.80
