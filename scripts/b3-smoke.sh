#!/bin/bash
# B3 replacement smoke — the driver half.
#
# Replaces the coverage of the tmux/SwiftTerm-era workspace/scripts/smoke.sh on
# the sessiond + HiveTerminalKit spine. Stands the stack up headless, runs the
# in-process assertions (B3SmokeTests), then makes the POST-MORTEM assertions
# from OUTSIDE the app — which is where the legacy harness put its two most
# valuable invariants:
#
#   detach never kills   (legacy SMOKE-61/62): closing a viewer must leave the
#                        session alive. A smoke that only checks the viewer
#                        cannot see this, because the viewer is gone.
#   no leaked clients    (legacy SMOKE-64): after the viewer exits, nothing may
#                        still be attached.
#
# Headless by design: no Workspace app, no window, no GUI session required.
# The GUI-bound checks live in SmokeRunner's opt-in sessiond proof and are
# mapped separately — see workspace/docs/b3-smoke-coverage-mapping.md.
#
# Usage: scripts/b3-smoke.sh
# Exit:  0 all stages passed; 1 any stage failed. Never pipes a run, so the
#        exit code reported is the real one.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Short home: long paths blow the UNIX socket path limit.
HOME_DIR="${HIVE_B3_HOME:-/tmp/hb3s}"
# Own port, away from the b22 qualification harness (43117) and the live
# matrix work (43217).
PORT="${HIVE_B3_PORT:-43126}"
ARTIFACTS="$HOME_DIR/artifacts"

failures=()
fail() { failures+=("$1"); echo "  FAIL: $1"; }
pass() { echo "  PASS: $1"; }

cleanup() {
    if [ -n "${HARNESS_PID:-}" ]; then kill "$HARNESS_PID" 2>/dev/null; fi
}
trap cleanup EXIT

echo "B3 smoke — headless sessiond + HiveTerminalKit substrate"
echo "home=$HOME_DIR port=$PORT"

# The legacy harness destroyed its temp dirs even on failure, making
# post-mortem debugging impossible. Keep artifacts instead.
mkdir -p "$ARTIFACTS"

# Wait for a previously-leaked port rather than failing on EADDRINUSE.
for _ in $(seq 1 30); do
    lsof -nP -iTCP:"$PORT" >/dev/null 2>&1 || break
    sleep 1
done
rm -rf "$HOME_DIR/runtime" "$HOME_DIR/b22-proof.json"

echo "[1/5] standing up sessiond stack (headless)"
HIVE_B22_NO_APP=1 HIVE_B22_REAL_SHELL=1 \
HIVE_B22_HOME="$HOME_DIR" HIVE_B22_PORT="$PORT" \
    bun "$ROOT/scripts/b22-live-attach-proof.ts" < /dev/null \
    > "$ARTIFACTS/stack.txt" 2>&1 &
HARNESS_PID=$!

for _ in $(seq 1 40); do
    [ -f "$HOME_DIR/b22-proof.json" ] && break
    sleep 1
done
if [ ! -f "$HOME_DIR/b22-proof.json" ]; then
    fail "stack did not come up (see $ARTIFACTS/stack.txt)"
    echo "SMOKE FAIL"; exit 1
fi
pass "stack up"

SESSION_ID="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["locator"]["sessionId"])' "$HOME_DIR/b22-proof.json")"
echo "session=$SESSION_ID"

echo "[2/5] in-process substrate assertions"
HIVE_B3_SMOKE_HOME="$HOME_DIR" \
    swift test --package-path "$ROOT/workspace" --filter B3SmokeTests \
    > "$ARTIFACTS/in-process.txt" 2>&1
inproc=$?
grep -E "^STAGE [0-9]" "$ARTIFACTS/in-process.txt" | sed 's/^/  /'
if [ "$inproc" -ne 0 ]; then
    fail "in-process stages failed (exit $inproc; see $ARTIFACTS/in-process.txt)"
else
    pass "in-process stages"
fi

# ── POST-MORTEM: the viewer is gone; assert from OUTSIDE the app ──────────
HOST_DIR="$HOME_DIR/runtime/sessiond/hosts/$SESSION_ID"
RECORD="$HOST_DIR/record.json"
cp "$RECORD" "$ARTIFACTS/record-after-detach.json" 2>/dev/null

echo "[3/5] detach never kills (legacy SMOKE-61/62)"
if [ ! -f "$HOST_DIR/final.json" ]; then
    pass "no final.json — session was not terminated by the viewer detaching"
else
    fail "session terminated when the viewer detached; detach must never kill"
    cp "$HOST_DIR/final.json" "$ARTIFACTS/final-unexpected.json" 2>/dev/null
fi

if [ -f "$RECORD" ]; then
    # NOT checked: record.json's "state" field. It is written at creation and
    # is NOT rewritten when the session dies (death is recorded by writing
    # final.json instead), so "state == live" reads back true even for a
    # SIGKILLed session. Verified by mutation: killing the child left that
    # field saying live while every other check went red. A clause that cannot
    # fail is worse than an absent one, because it pads the pass list.
    #
    # The two checks below DO bite, both confirmed by that same mutation.
    # Liveness is read from the process itself, not from a status file.
    hpid=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["processRoot"]["pid"])' "$RECORD" 2>/dev/null)
    if kill -0 "$hpid" 2>/dev/null; then
        pass "session child pid $hpid still alive after detach"
    else
        fail "session child pid $hpid is gone after detach — detach killed it"
    fi
else
    fail "no record.json at $RECORD"
fi

echo "[4/5] no leaked attach clients (legacy SMOKE-64)"
# The per-host socket path is declared by the record itself rather than
# guessed, so this cannot silently skip because a name changed.
SOCKREL=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("socketRelativePath",""))' "$RECORD" 2>/dev/null)
SOCK="$HOST_DIR/$SOCKREL"
if [ -n "$SOCKREL" ] && [ -S "$SOCK" ]; then
    holders=$(lsof -t "$SOCK" 2>/dev/null | grep -v "^$HARNESS_PID\$" | wc -l | tr -d ' ')
    if [ "$holders" = "0" ]; then
        pass "no leaked attach clients on $SOCKREL"
    else
        fail "$holders process(es) still attached to $SOCKREL after the viewer exited"
        lsof "$SOCK" > "$ARTIFACTS/leaked-clients.txt" 2>&1
    fi
else
    fail "no host socket at $SOCK (record declared '$SOCKREL') — client-leak check could not run"
fi

echo "[5/5] clean teardown"
kill "$HARNESS_PID" 2>/dev/null
HARNESS_PID=""
for _ in $(seq 1 20); do
    [ -f "$HOST_DIR/final.json" ] && break
    sleep 1
done
if [ -f "$HOST_DIR/final.json" ]; then
    cp "$HOST_DIR/final.json" "$ARTIFACTS/final.json"
    survivors=$(/usr/bin/python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["survivors"]))' "$HOST_DIR/final.json" 2>/dev/null)
    observed=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["waitObserved"])' "$HOST_DIR/final.json" 2>/dev/null)
    [ "$survivors" = "0" ] && pass "teardown left no survivors" \
                           || fail "teardown left $survivors survivor process(es)"
    [ "$observed" = "True" ] && pass "child exit was actually observed (waitObserved)" \
                             || fail "waitObserved=$observed — exit was inferred, not observed"
else
    fail "no final.json after teardown — session end was never recorded"
fi

echo ""
if [ ${#failures[@]} -eq 0 ]; then
    echo "SMOKE OK — sessiond substrate: create, attach, input applied, grid-ready, detach-not-kill"
    echo "artifacts: $ARTIFACTS"
    exit 0
fi
echo "SMOKE FAIL:"
for f in "${failures[@]}"; do echo "  $f"; done
echo "artifacts: $ARTIFACTS"
exit 1
