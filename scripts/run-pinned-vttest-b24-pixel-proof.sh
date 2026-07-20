#!/bin/bash
# Qualification-only driver for a rendered production-Workspace capture.
# Authenticated input and raw-byte evidence remain the LiveHostAttachTests path.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export HIVE_B24_VTTEST_SHIM="$ROOT/scripts/run-pinned-vttest-b24.sh"
exec /usr/bin/expect -c '
set timeout 10
spawn -noecho $env(HIVE_B24_VTTEST_SHIM) -l

expect "Enter choice number (0 - 12):"
send "11\r"
expect "Enter choice number (0 - 8):"
send "8\r"
expect "Enter choice number (0 - 9):"
send "7\r"
expect "Enter choice number (0 - 5):"
send "5\r"
expect "The next screen will be filled with E\047s"
send "\r"
expect -re "E{80}"

# Keep the alternate screen stable long enough for a named-window capture.
sleep 30
'
