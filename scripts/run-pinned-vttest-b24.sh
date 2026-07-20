#!/bin/bash
# Qualification-only login-shell shim used by b22-live-attach-proof.ts.
# The harness supplies "-l" because it normally launches a login shell; the
# shim deliberately ignores that argument and starts the B2.4-pinned vttest.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VTTEST="$ROOT/.cache/vttest/install/bin/vttest"
ARCHIVE="$ROOT/.cache/vttest/vttest-20251205.tgz"
EXPECTED_VERSION='VT100 test program, version 2.7 (20251205)'
EXPECTED_ARCHIVE_SHA256='cd6886f9aefe6a3f6c566fa61271a55710901a71849c630bf5376aa984bf77cc'
EXPECTED_BINARY_SHA256='adac6a5d2c3cc23d977b657a3caee887261df6bcd7a746b7d9b06b8f5e4337cc'

if [[ ! -f "$ARCHIVE" || ! -x "$VTTEST" ]]; then
  echo "pinned vttest archive or binary is missing" >&2
  exit 1
fi
if [[ "$(/usr/bin/shasum -a 256 "$ARCHIVE" | /usr/bin/cut -d' ' -f1)" != "$EXPECTED_ARCHIVE_SHA256" ]]; then
  echo "vttest source archive does not match the B2.4 pin" >&2
  exit 1
fi
if [[ "$(/usr/bin/shasum -a 256 "$VTTEST" | /usr/bin/cut -d' ' -f1)" != "$EXPECTED_BINARY_SHA256" ]]; then
  echo "vttest executable does not match the recorded B2.4 build" >&2
  exit 1
fi
if [[ "$($VTTEST -V)" != "$EXPECTED_VERSION" ]]; then
  echo "vttest version does not match the B2.4 pin" >&2
  exit 1
fi

export TERM=xterm-ghostty
export COLORTERM=truecolor
# vttest is normally started by an interactive shell and expects its menu
# input to inherit canonical CR-to-NL handling. The session-host provider
# profile is deliberately raw, so establish the normal shell handoff here.
stty sane
exec "$VTTEST" -u 24x80.80
