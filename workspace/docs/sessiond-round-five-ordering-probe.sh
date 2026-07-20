#!/bin/bash
# henrietta round-five: horace's EXACT staged orphan probe, re-run against the
# pin, now that production writes daemon.port BEFORE sessiondBroker.start().
#
# Requirement under review (horace's B2): with a real orphan holding the
# broker socket, the daemon must exit NON-ZERO and leave NO daemon.port
# advertised. A transient write is acceptable ONLY if cleanup actually runs.
#
# Usage: ordering-probe.sh <case>
#   orphan  — real orphan broker owns broker.sock before the daemon starts
#   normal  — no orphan; ordinary successful startup (control)
set -u

ROOT=/Users/scottkellar/Projects/hive/.hive/worktrees/henrietta
CASE="${1:-orphan}"
HH="/tmp/hh-$CASE-$$"
PORT=43122
HIVE="$ROOT/.dev/root/current/hive"
SESSIOND="$ROOT/.dev/root/current/hive-sessiond"

rm -rf "$HH"; mkdir -p "$HH"
echo "case:        $CASE"
echo "HIVE_HOME:   $HH"

ORPHAN_PID=""
if [ "$CASE" = "orphan" ]; then
  HIVE_HOME="$HH" "$SESSIOND" serve > "$HH/orphan.log" 2>&1 &
  ORPHAN_PID=$!
  # Wait for the orphan's REAL broker socket before starting the daemon.
  for _ in $(seq 1 100); do
    [ -S "$HH/runtime/sessiond/broker.sock" ] && break
    sleep 0.1
  done
  if [ ! -S "$HH/runtime/sessiond/broker.sock" ]; then
    echo "SETUP FAILED: orphan never bound broker.sock"; kill "$ORPHAN_PID" 2>/dev/null; exit 90
  fi
  echo "orphan pid:  $ORPHAN_PID (owns broker.sock)"
fi

# Run the daemon in the foreground and capture its REAL exit code.
HIVE_HOME="$HH" HIVE_PORT="$PORT" "$HIVE" daemon > "$HH/daemon.log" 2>&1 &
DAEMON_PID=$!

# Give startup a bounded window to either advertise-and-fail or come up.
DEADLINE=$((SECONDS + 30))
DAEMON_EXIT="still-running"
while [ $SECONDS -lt $DEADLINE ]; do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    wait "$DAEMON_PID"; DAEMON_EXIT=$?
    break
  fi
  sleep 0.2
done

echo "daemon exit: $DAEMON_EXIT"

# THE MEASUREMENT: is a daemon.port left advertised after the failure?
if [ -f "$HH/daemon.port" ]; then
  echo "daemon.port: PRESENT -> $(cat "$HH/daemon.port" | tr -d '\n')"
  PORT_LEFT=yes
else
  echo "daemon.port: absent"
  PORT_LEFT=no
fi
if [ -f "$HH/daemon.pid" ]; then
  echo "daemon.pid:  PRESENT -> $(cat "$HH/daemon.pid" | tr -d '\n')"
else
  echo "daemon.pid:  absent"
fi

# Is the advertised port actually answering? (a stale advertisement points nowhere)
if [ "$PORT_LEFT" = yes ]; then
  ADV=$(cat "$HH/daemon.port" | tr -d '\n')
  if curl -s -m 2 "http://127.0.0.1:$ADV/handshake" > /dev/null 2>&1; then
    echo "advertised port answers: YES (live)"
  else
    echo "advertised port answers: NO  (stale advertisement to a dead daemon)"
  fi
fi

echo "daemon alive after startup: $(kill -0 "$DAEMON_PID" 2>/dev/null && echo yes || echo no)"
echo "--- daemon stderr (tail) ---"
tail -6 "$HH/daemon.log" 2>/dev/null

# Cleanup
kill -0 "$DAEMON_PID" 2>/dev/null && kill -TERM "$DAEMON_PID" 2>/dev/null
[ -n "$ORPHAN_PID" ] && kill -TERM "$ORPHAN_PID" 2>/dev/null
sleep 1
pkill -f "HIVE_HOME=$HH" 2>/dev/null
echo "=== end $CASE ==="
