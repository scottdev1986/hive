#!/usr/bin/env bash
# qa/u5-app-driver.sh — the external half of the U5 app rendezvous.
#
#   qa/u5-app-driver.sh self-check    prove the scope and the refusals
#
# The live harness (u5-terminal-workbench-live.ts) writes a ready marker and
# then blocks waiting for a release marker. This is the side that waits for
# ready, launches the Workspace, drives it, kills ONLY what it launched, and
# writes release. It did not exist before this file; the harness had one half of
# a rendezvous and nothing on the other end.
#
# WHAT IS IMPLEMENTED HERE is the part that does not depend on the rendezvous
# schema: process identity, scoped termination, and the readiness deadline.
# Those are the dangerous parts and they are provable on their own. The ready
# and release schemas are lindsay's contract and three points of it are still
# open (a refusal path that does not force her harness to time out, the
# waitStatus encoding, and reading the published instance id) — the launch and
# capture stages land when those are settled, rather than being guessed at now
# and corrected later.
set -uo pipefail

QA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$QA_DIR/repo-root.sh"

die() { echo "u5-driver: $*" >&2; exit 1; }
log() { echo "u5-driver: $*" >&2; }

# --- process identity -------------------------------------------------------
#
# A PID is never authority on its own. macOS reuses PIDs, so a recorded PID can
# name a different process by the time a signal is sent — and this driver sends
# SIGKILL, where being wrong is unrecoverable. Every identity here is the pair
# (pid, start token), and the token is read from PROC_PIDTBSDINFO's birth
# seconds and microseconds, which cannot collide within a second the way ps
# lstart can. This is the same discipline rig.sh teardown already uses; it is
# reused rather than reinvented so there is one notion of process identity in
# this tree.

process_start() {
  python3 - "$1" <<'PY'
import ctypes, struct, sys
pid = int(sys.argv[1])
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
buffer = ctypes.create_string_buffer(136)
if lib.proc_pidinfo(pid, 3, 0, buffer, len(buffer)) != len(buffer):
    raise SystemExit(1)
seconds, microseconds = struct.unpack_from("<QQ", buffer.raw, 120)
print(f"{seconds}:{microseconds}")
PY
}

process_alive() {
  local state
  case "${1:-}" in ""|*[!0-9]*) return 1;; esac
  [ "$1" -gt 1 ] 2>/dev/null || return 1
  state="$(ps -p "$1" -o stat= 2>/dev/null | tr -d ' ')"
  case "$state" in ""|Z*) return 1;; esac
  return 0
}

capture_identity() {
  local token
  process_alive "$1" || return 1
  token="$(process_start "$1")" || return 1
  printf '%s:%s\n' "$1" "$token"
}

identity_matches() {
  local pid="${1%%:*}" token="${1#*:}"
  [ "$token" != "$1" ] || return 1
  process_alive "$pid" || return 1
  [ "$(process_start "$pid")" = "$token" ]
}

# --- scoped termination -----------------------------------------------------
#
# Kills exactly the identity it was given, and refuses if the process at that
# PID is no longer the process that was captured. There is deliberately no name
# match and no pattern anywhere in this file: `pkill -f HiveWorkspace` on a
# developer's machine would kill the Workspace they are using, and a QA rig has
# no business being able to do that.
#
# The reaped status is MEASURED, never computed. `128 + 9` prints the number the
# contract expects on every platform, including one that reaped something else
# entirely, so it would report a SIGKILL that never happened. reap_sigkill
# records what wait actually returned and refuses anything that does not denote
# a SIGKILL death: above 128, because that is how the shell encodes death by
# signal, and KILL by the platform's own signal table, because a process that
# merely exited 9 is not a process that was killed.
#
# The reap has to happen in the shell that owns the child — a subshell cannot
# wait for its parent's job — so the status is left in KILL_WAIT_STATUS instead
# of printed into a command substitution.
KILL_WAIT_STATUS=""

reap_sigkill() {
  local pid="$1" status
  wait "$pid" 2>/dev/null
  status=$?
  if [ "$status" -le 128 ] || [ "$(kill -l "$status" 2>/dev/null)" != "KILL" ]; then
    echo "u5-driver: $pid reaped status $status, which does not denote SIGKILL" >&2
    return 1
  fi
  KILL_WAIT_STATUS="$status"
}

kill_scoped() {
  local identity="${1:-}"
  # Declared on its own line: bash 3.2, which is the bash on this rig, does not
  # expand a variable declared earlier on the SAME `local` line, so folding
  # these two together leaves pid empty and the kill silently signals nothing.
  local pid="${identity%%:*}"
  KILL_WAIT_STATUS=""
  if ! identity_matches "$identity"; then
    echo "u5-driver: refusing to signal '${pid:-none}': not the captured process" >&2
    return 1
  fi
  kill -KILL "$pid" 2>/dev/null || true
  reap_sigkill "$pid" || return 1
  if process_alive "$pid"; then
    echo "u5-driver: $pid survived SIGKILL" >&2
    return 1
  fi
}

# --- readiness --------------------------------------------------------------
#
# Readiness is a conjunction the caller supplies, evaluated until a deadline.
# The deadline is the point: an app that never becomes ready must fail AS
# NOT-READY. Blocking until something else times out reports the wrong thing —
# the harness would call it a ten-minute stall rather than a launch that never
# came up, and the real reason would be lost.
wait_until_ready() {
  local deadline_seconds="$1" predicate="$2" waited=0
  while [ "$waited" -lt "$deadline_seconds" ]; do
    if "$predicate"; then
      printf 'ready\n'
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "u5-driver: not ready after ${deadline_seconds}s: $predicate never held" >&2
  return 1
}

# --- controls ---------------------------------------------------------------
#
# Every claim in this file is dangerous enough that it is worth nothing until it
# has been seen to refuse. These run without a rig, a GUI or an app.
self_check() {
  local failures=0
  ok() { echo "  OK: $*"; }
  bad() { echo "  FAIL: $*" >&2; failures=$((failures + 1)); }

  # A process the driver launched, and a LOOK-ALIKE it did not: same command,
  # same argv, started independently. The look-alike is the whole proof — a
  # name or pattern match cannot tell these two apart, and would kill both.
  /bin/sh -c 'exec -a HiveWorkspace sleep 60' &
  local target_pid=$!
  /bin/sh -c 'exec -a HiveWorkspace sleep 60' &
  local lookalike_pid=$!
  sleep 0.3

  local target lookalike
  target="$(capture_identity "$target_pid")" || bad "could not capture the target identity"
  lookalike="$(capture_identity "$lookalike_pid")" || bad "could not capture the look-alike identity"

  local status
  kill_scoped "$target"
  status="$KILL_WAIT_STATUS"
  if [ "$status" = "137" ]; then
    ok "the captured process was killed and the shell reaped status 137"
  else
    bad "expected a reaped status of 137, got '${status:-none}'"
  fi
  if process_alive "$lookalike_pid"; then
    ok "the identically-named look-alike SURVIVED"
  else
    bad "the look-alike was killed: the scope is not what this driver claims"
  fi

  # A stale identity: the PID is gone, so the recorded pair no longer names
  # anything. Signalling it would be signalling whatever inherited the number.
  if kill_scoped "$target" >/dev/null 2>&1; then
    bad "a dead identity was signalled instead of refused"
  else
    ok "a dead identity was refused rather than signalled"
  fi

  # A forged identity: right PID, wrong start token. This is PID reuse in its
  # dangerous form, and the token is the only thing that catches it.
  local forged="$lookalike_pid:1:1"
  if kill_scoped "$forged" >/dev/null 2>&1; then
    bad "an identity with a mismatched start token was signalled"
  else
    ok "a mismatched start token was refused"
  fi
  if process_alive "$lookalike_pid"; then
    ok "the process behind the forged identity is still alive"
  else
    bad "the forged identity killed a live process"
  fi

  kill -KILL "$lookalike_pid" 2>/dev/null || true
  wait "$lookalike_pid" 2>/dev/null

  # The reaped status is a measurement, so it must be able to come back wrong.
  # A SIGTERM death and a plain exit with code 9 are the two ways the old
  # computed 137 would have lied: one died by the wrong signal, and the other
  # never died by a signal at all, yet `kill -l 9` still reads KILL.
  /bin/sh -c 'sleep 60' &
  local termed_pid=$!
  sleep 0.2
  kill -TERM "$termed_pid" 2>/dev/null || true
  if reap_sigkill "$termed_pid"; then
    bad "a SIGTERM death was recorded as SIGKILL: '$KILL_WAIT_STATUS'"
  else
    ok "a SIGTERM death was refused rather than recorded as a SIGKILL"
  fi
  /bin/sh -c 'exit 9' &
  local exited_pid=$!
  if reap_sigkill "$exited_pid"; then
    bad "an exit with code 9 was recorded as SIGKILL: '$KILL_WAIT_STATUS'"
  else
    ok "an exit with code 9 was refused rather than read as a SIGKILL"
  fi

  # Readiness fails as not-ready, in bounded time, rather than hanging.
  never_ready() { return 1; }
  immediately_ready() { return 0; }
  local started ended
  started="$(date +%s)"
  if wait_until_ready 2 never_ready >/dev/null 2>&1; then
    bad "an app that never becomes ready was reported ready"
  else
    ended="$(date +%s)"
    if [ "$((ended - started))" -le 5 ]; then
      ok "a never-ready app failed as not-ready within its deadline"
    else
      bad "the not-ready path took $((ended - started))s: it hung rather than failed"
    fi
  fi
  if [ "$(wait_until_ready 5 immediately_ready)" = "ready" ]; then
    ok "a ready app is reported ready"
  else
    bad "a ready app was not reported ready: the detector never says yes"
  fi

  [ "$failures" -eq 0 ] || die "$failures scope or readiness control(s) failed"
  echo "PASS: termination is scoped to captured identities and readiness is bounded"
}

case "${1:-}" in
  self-check) self_check ;;
  *) echo "usage: qa/u5-app-driver.sh self-check" >&2; exit 2 ;;
esac
