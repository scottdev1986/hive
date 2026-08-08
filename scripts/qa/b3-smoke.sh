#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOME_DIR="${HIVE_B3_HOME:-/tmp/hb3s}"
# sessiond binds its sockets under this root rather than the home, which holds the durable
# per-session files instead. Pinned here so teardown clears the same tree the harness bound in.
SESSIOND_ROOT="${HIVE_SESSIOND_ROOT:-$HOME_DIR/sd}"
export HIVE_SESSIOND_ROOT="$SESSIOND_ROOT"
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

mkdir -p "$ARTIFACTS"

# Wait out a leftover holder of this port rather than failing on EADDRINUSE.
for _ in $(seq 1 30); do
    lsof -nP -iTCP:"$PORT" >/dev/null 2>&1 || break
    sleep 1
done
rm -rf "$SESSIOND_ROOT" "$HOME_DIR/runtime" "$HOME_DIR/b22-proof.json"

echo "[1/5] standing up sessiond stack (headless)"
HIVE_B22_NO_APP=1 HIVE_B22_REAL_SHELL=1 \
HIVE_B22_HOME="$HOME_DIR" HIVE_B22_PORT="$PORT" \
    bun "$ROOT/scripts/qa/b22-live-attach-proof.ts" < /dev/null \
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
: > "$ARTIFACTS/in-process.txt"
make -C "$ROOT" "$ROOT/workspace/Vendor/GhosttyKit.xcframework/Info.plist" \
    >> "$ARTIFACTS/in-process.txt" 2>&1
inproc=$?
if [ "$inproc" -eq 0 ]; then
    HIVE_B3_SMOKE_HOME="$HOME_DIR" \
        swift test --package-path "$ROOT/workspace" --filter B3SmokeTests \
        >> "$ARTIFACTS/in-process.txt" 2>&1
    inproc=$?
fi
grep -E "^STAGE [0-9]" "$ARTIFACTS/in-process.txt" | sed 's/^/  /'
if [ "$inproc" -ne 0 ]; then
    fail "in-process stages failed (exit $inproc; see $ARTIFACTS/in-process.txt)"
else
    pass "in-process stages"
fi

# The harness publishes both paths it resolved, because they no longer share a root: the socket is
# bound in the short socket root and everything durable lives under the home. Read them rather than
# rebuilding either, so this stage cannot assert against a layout the code stopped using.
HOST_DIR="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["hostDirectory"])' "$HOME_DIR/b22-proof.json")"
SOCK="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["hostSocket"])' "$HOME_DIR/b22-proof.json")"
RECORD="$HOST_DIR/record.json"
cp "$RECORD" "$ARTIFACTS/record-after-detach.json" 2>/dev/null
# Snapshot the journal while the session is live. It is a small rolling window that rotates out within seconds. Kept for outside-the-app readback; not asserted on — a partial window cannot support a completeness claim.
cp "$HOST_DIR/journal.bin" "$ARTIFACTS/journal-snapshot.bin" 2>/dev/null

echo "[3/5] detach never kills"
if [ ! -f "$HOST_DIR/final.json" ]; then
    pass "no final.json — session was not terminated by the viewer detaching"
else
    fail "session terminated when the viewer detached; detach must never kill"
    cp "$HOST_DIR/final.json" "$ARTIFACTS/final-unexpected.json" 2>/dev/null
fi

if [ -f "$RECORD" ]; then
    # Do not trust record.json "state": it is written at creation and never rewritten when the session dies (death writes final.json). "state == live" stays true even after SIGKILL. Read liveness from the process itself.
    hpid=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["processRoot"]["pid"])' "$RECORD" 2>/dev/null)
    HOSTPID=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["hostPid"])' "$RECORD" 2>/dev/null)
    # Capture while live: after teardown the record may be gone.
    RECORDED_PIDS="$hpid $HOSTPID"
    if kill -0 "$hpid" 2>/dev/null; then
        pass "session child pid $hpid still alive after detach"
    else
        fail "session child pid $hpid is gone after detach — detach killed it"
    fi
else
    fail "no record.json at $RECORD"
fi

echo "[4/5] no leaked attach clients"
if [ -S "$SOCK" ]; then
    holders=$(lsof -t "$SOCK" 2>/dev/null | grep -v "^$HARNESS_PID\$" | wc -l | tr -d ' ')
    if [ "$holders" = "0" ]; then
        pass "no leaked attach clients on $SOCK"
    else
        fail "$holders process(es) still attached to $SOCK after the viewer exited"
        lsof "$SOCK" > "$ARTIFACTS/leaked-clients.txt" 2>&1
    fi
else
    fail "no host socket at $SOCK — client-leak check could not run"
fi

echo "[5/5] clean teardown"
kill "$HARNESS_PID" 2>/dev/null
HARNESS_PID=""
for _ in $(seq 1 20); do
    [ -f "$HOST_DIR/final.json" ] && break
    sleep 1
done
# Primary: recorded PIDs gone according to the OS, not sessiond's self-report. final.json survivors/waitObserved are an attestation from the process under test — weaker than a process-table measurement.
leaked=""
for p in $RECORDED_PIDS; do
    [ -n "$p" ] || continue
    if kill -0 "$p" 2>/dev/null; then leaked="$leaked $p"; fi
done
if [ -z "$leaked" ]; then
    pass "recorded pids ($RECORDED_PIDS) are gone — verified directly against the OS"
else
    fail "process(es)$leaked survived teardown (checked directly, not self-reported)"
    ps -o pid,stat,command -p ${leaked// /,} > "$ARTIFACTS/survivors.txt" 2>&1
fi

# Corroboration: sessiond's own record must agree with the measurement.
if [ -f "$HOST_DIR/final.json" ]; then
    cp "$HOST_DIR/final.json" "$ARTIFACTS/final.json"
    survivors=$(/usr/bin/python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["survivors"]))' "$HOST_DIR/final.json" 2>/dev/null)
    observed=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["waitObserved"])' "$HOST_DIR/final.json" 2>/dev/null)
    [ "$survivors" = "0" ] && pass "sessiond agrees: survivors 0 (corroborates the direct check)" \
                           || fail "sessiond reports $survivors survivor(s)"
    [ "$observed" = "True" ] && pass "child exit was actually observed (waitObserved)" \
                             || fail "waitObserved=$observed — exit was inferred, not observed"
else
    fail "no final.json after teardown — session end was never recorded"
fi

echo ""
if [ ${#failures[@]} -eq 0 ]; then
    echo "SMOKE OK — sessiond substrate: create, attach, shell-interpreted input, grid-ready, detach-not-kill"
    echo "artifacts: $ARTIFACTS"
    exit 0
fi
echo "SMOKE FAIL:"
for f in "${failures[@]}"; do echo "  $f"; done
echo "artifacts: $ARTIFACTS"
exit 1
