#!/bin/bash
# henrietta: does EVERY broker-failure route reach cleanup + exit 1?
#
# The orphan probe only exercises the child-EXIT route (BrokerAlreadyRunning).
# This drives the HELLO-failure / ready-timeout route, where the child is still
# ALIVE at failure time — so sessiondBroker.stop() must kill a live child and
# daemon.stop() must not hang before process.exit(1).
set -u
ROOT=/Users/scottkellar/Projects/hive/.hive/worktrees/henrietta
SCRATCH=/private/tmp/claude-501/-Users-scottkellar-Projects-hive--hive-worktrees-henrietta/6ae289c6-0e88-4307-80e9-ef095d1de6dd/scratchpad
HH="/tmp/hfr-$$"
HIVE="$ROOT/.dev/root/current/hive"

rm -rf "$HH"; mkdir -p "$HH"
echo "HIVE_HOME: $HH"
echo "route:     HELLO-failure / ready-timeout (child ALIVE at failure)"

BEFORE=$(pgrep -f "fake-sessiond.ts" 2>/dev/null | wc -l | tr -d ' ')

START=$SECONDS
HIVE_HOME="$HH" HIVE_PORT=43123 \
  HIVE_SESSIOND_BIN="$SCRATCH/fake-sessiond.ts" \
  HIVE_INSTALL_ROOT="$ROOT/.dev/root" HIVE_PROJECT_ROOT="$ROOT" \
  "$HIVE" daemon > "$HH/daemon.log" 2>&1 &
DPID=$!

DEADLINE=$((SECONDS + 60))
EXITCODE="still-running"
while [ $SECONDS -lt $DEADLINE ]; do
  if ! kill -0 "$DPID" 2>/dev/null; then wait "$DPID"; EXITCODE=$?; break; fi
  sleep 0.2
done
ELAPSED=$((SECONDS - START))

# POSITIVE CONTROL: the fake must actually have been spawned. Without this, a
# rejected HIVE_SESSIOND_BIN silently falls back to the real staged sessiond and
# the daemon just starts up healthy — which reads like a hole but is a probe bug.
if grep -q "fake-sessiond: bound" "$HH/daemon.log" 2>/dev/null; then
  echo "control:      fake sessiond WAS used ($(grep -o 'as pid [0-9]*' "$HH/daemon.log" | head -1))"
else
  echo "control:      *** FAKE NEVER RAN — probe invalid, result unattributable ***"
fi

echo "daemon exit:  $EXITCODE  (after ${ELAPSED}s; ready timeout is 10s)"
for f in daemon.port daemon.pid daemon.lock; do
  if [ -e "$HH/$f" ]; then echo "$f: PRESENT -> $(tr -d '\n' < "$HH/$f")"; else echo "$f: absent"; fi
done
echo "daemon alive: $(kill -0 "$DPID" 2>/dev/null && echo yes || echo no)"

sleep 1
AFTER=$(pgrep -f "fake-sessiond.ts" 2>/dev/null | wc -l | tr -d ' ')
echo "leaked fake broker children: $((AFTER - BEFORE))  (before=$BEFORE after=$AFTER)"

echo "--- daemon stderr (tail) ---"
tail -5 "$HH/daemon.log"

kill -0 "$DPID" 2>/dev/null && kill -9 "$DPID" 2>/dev/null
pkill -f "fake-sessiond.ts" 2>/dev/null
rm -rf "$HH"
echo "=== end ==="
