#!/bin/bash
# #45 item 1 — LIVE b22 dead-broker Ctrl-C re-run.
#
# The exact user-reported scenario from the start of the campaign, deferred at
# #41's closure by harold's ruling and now supposed to be impossible:
#   fresh `make terminal` -> SIGKILL the sessiond broker out from under it
#   mid-run -> Ctrl-C the harness.
# REQUIRED: clean orderly exit, no refusal wedge, no reconciliation spam,
#           no leaked processes.
#
# Identity discipline: the broker is re-identified AT KILL TIME from kernel
# evidence (LOCAL_PEERPID of the live broker.sock), never from a remembered pid,
# and the identity is positive-controlled against `ps comm` before any signal.
set -u
ROOT=/Users/scottkellar/Projects/hive/.hive/worktrees/henrietta
SCRATCH=/private/tmp/claude-501/-Users-scottkellar-Projects-hive--hive-worktrees-henrietta/6ae289c6-0e88-4307-80e9-ef095d1de6dd/scratchpad
OUT=${1:-/tmp/hen-b22-run.log}
PORT=43122

banner() { echo; echo "===== $* ====="; }

# Leak detection must be scoped to THIS run's home. Other agents have their own
# brokers and Workspace apps running; a global count would charge their
# processes to my leak check (or hide mine among theirs).
RUN_HOME="${RUN_HOME:-}"
ps_snapshot() {
  if [ -n "$RUN_HOME" ]; then
    ps -eo pid,ppid,pgid,args 2>/dev/null | grep -F "$RUN_HOME" | grep -v grep
  else
    echo "<no run home yet — scoped snapshot deferred>"
  fi
}

banner "BEFORE ps (global context — other agents' brokers are expected here)"
ps -eo pid,ppid,pgid,args 2>/dev/null \
  | grep -E "hive-sessiond|b22-live-attach|HiveWorkspace" | grep -v grep \
  | sed 's/\(.\{150\}\).*/\1…/' || echo "<none>"
echo "(the leak assertion below is scoped to THIS run's home, not this list)"

banner "launching make terminal (own process group, port $PORT)"
rm -f "$OUT"
# `set -m` gives the child its own process group so a real Ctrl-C — which
# signals the whole foreground group — can be reproduced faithfully.
set -m
( cd "$ROOT" && make terminal DEMO_PORT=$PORT ) > "$OUT" 2>&1 &
HARNESS=$!
set +m
PGID=$(ps -o pgid= -p $HARNESS 2>/dev/null | tr -d ' ')
echo "harness pid=$HARNESS pgid=$PGID"

# Wait for the run to be genuinely live: the harness logs the broker and then
# the attach. Require the socket to exist AND the harness to still be running.
HOME_DIR=""
for i in $(seq 1 120); do
  if ! kill -0 $HARNESS 2>/dev/null; then echo "harness died during startup"; break; fi
  H=$(grep -o 'live proof home: [^ ]*' "$OUT" 2>/dev/null | head -1 | awk '{print $NF}')
  if [ -n "$H" ] && [ -S "$H/runtime/sessiond/broker.sock" ]; then HOME_DIR="$H"; break; fi
  sleep 0.5
done

if [ -z "$HOME_DIR" ]; then
  echo "SETUP FAILED: never reached a live broker socket"
  tail -25 "$OUT"
  kill -INT -"$PGID" 2>/dev/null
  exit 90
fi
echo "HIVE_HOME=$HOME_DIR"
RUN_HOME="$HOME_DIR"
SOCK="$HOME_DIR/runtime/sessiond/broker.sock"

banner "live-run snapshot (scoped to $RUN_HOME) — what must be gone at the end"
ps_snapshot | sed 's/\(.\{150\}\).*/\1…/'

# Let the run settle into steady state so the kill lands mid-run, not at startup.
sleep 5

banner "identify the broker AT KILL TIME by kernel evidence"
BPID=$(bun "$SCRATCH/identify-broker.ts" "$SOCK" 2>/tmp/hen-ident.err)
if [ -z "$BPID" ]; then
  echo "IDENTIFY FAILED: $(cat /tmp/hen-ident.err)"; kill -INT -"$PGID" 2>/dev/null; exit 91
fi
COMM=$(ps -p "$BPID" -o comm= 2>/dev/null)
echo "LOCAL_PEERPID of $SOCK -> pid $BPID"
echo "ps comm of $BPID       -> ${COMM:-<gone>}"

# POSITIVE CONTROL on identity: refuse to signal anything that is not the broker.
case "$COMM" in
  *hive-sessiond*) echo "identity control: OK (target really is hive-sessiond)" ;;
  *) echo "*** identity control FAILED — refusing to kill pid $BPID (comm=${COMM:-gone}) ***"
     kill -INT -"$PGID" 2>/dev/null; exit 92 ;;
esac

banner "SIGKILL the broker out from under the live run"
kill -9 "$BPID" 2>/dev/null
sleep 1
if kill -0 "$BPID" 2>/dev/null; then echo "broker $BPID STILL ALIVE after SIGKILL"; else echo "broker $BPID confirmed dead"; fi

# Give the harness a moment to notice the dead broker (this is where a
# reconciliation storm or a refusal wedge would show up).
sleep 3
SPAM_WINDOW=$(wc -l < "$OUT" | tr -d ' ')
echo "harness log lines after broker death: $SPAM_WINDOW"

banner "Ctrl-C the harness (SIGINT to the whole foreground process group)"
T0=$SECONDS
kill -INT -"$PGID" 2>/dev/null

EXITED="timeout"
for i in $(seq 1 60); do
  if ! kill -0 $HARNESS 2>/dev/null; then wait $HARNESS; EXITED=$?; break; fi
  sleep 0.5
done
ELAPSED=$((SECONDS - T0))
echo "harness exit: $EXITED after ${ELAPSED}s (first Ctrl-C only; none sent twice)"

banner "AFTER ps (leak check, scoped to this run's home)"
sleep 2
AFTER=$(ps_snapshot)
if [ -z "$AFTER" ]; then
  echo "<none> — zero surviving processes referencing $RUN_HOME"
  echo "LEAK CHECK: PASS"
else
  echo "$AFTER" | sed 's/\(.\{150\}\).*/\1…/'
  echo "LEAK CHECK: *** FAIL — $(printf '%s' "$AFTER" | grep -c .) survivor(s) ***"
fi

banner "wedge / spam analysis"
echo "-- refusal / wedge markers --"
grep -n -i -E "refus|wedge|EBUSY|still running|failed to stop|timed out" "$OUT" | tail -10 || echo "(none)"
echo "-- reconciliation lines --"
RECON=$(grep -c -i "reconcil" "$OUT" 2>/dev/null || echo 0)
echo "reconciliation line count: $RECON"
grep -n -i "reconcil" "$OUT" 2>/dev/null | tail -5
echo "-- shutdown tail --"
tail -20 "$OUT"
echo
echo "===== END (transcript: $OUT) ====="
