#!/usr/bin/env bash
# qa/u5-app-driver.sh — the external half of the U5 app rendezvous.
#
#   qa/u5-app-driver.sh self-check              prove the scope and the refusals
#   qa/u5-app-driver.sh provenance <executable> strings-level gate, never live
#   qa/u5-app-driver.sh run                     wait for ready, launch, drive,
#                                               SIGKILL only the captured
#                                               identity, write release
#
# The live harness (u5-terminal-workbench-live.ts) writes a ready marker and
# then blocks waiting for a release marker. This is the side that waits for
# ready, launches the Workspace, drives it, kills ONLY what it launched, and
# writes release.
#
# Settled rulings, superseding earlier mail:
#   - A refusal leaves the release marker ABSENT, fails the outer leg, and
#     names the reason on stderr. There is no refusal file.
#   - waitStatus is the reaped value, verbatim. It is never computed as 128+9.
#   - --instance-id is the published u5_instance_id, never a recomputed prefix.
#   - The screenshot set is derived from the ready marker's agents, never a
#     hardcoded five.
# Do not set HIVE_SHELL_PROOF=1 for the live launch: it makes the app
# background-only.
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

# --- provenance -------------------------------------------------------------
#
# Separate from the live launch because HIVE_SHELL_PROOF=1 makes the app
# background-only. The gate is a strings-level declaration check plus the Live
# Run control probe: live-run-workbench and live-run-terminal-host must be
# present, and SHELL-SCREEN must be present. An app built from main has the
# Live Run identifiers and no registry, which is the inverted control — it
# refuses naming the missing declaration rather than measuring the old UI
# while reading green.

count_literal() {
  local file="$1" needle="$2" n
  n="$(strings "$file" 2>/dev/null | grep -cF "$needle" || true)"
  printf '%s\n' "${n:-0}"
}

check_provenance() {
  local executable="${1:-}"
  if [ -z "$executable" ] || [ ! -f "$executable" ]; then
    echo "u5-driver: provenance requires an executable path" >&2
    return 1
  fi
  local workbench host screens
  workbench="$(count_literal "$executable" "live-run-workbench")"
  host="$(count_literal "$executable" "live-run-terminal-host")"
  screens="$(count_literal "$executable" "SHELL-SCREEN")"
  log "provenance workbench=$workbench terminal-host=$host SHELL-SCREEN=$screens"
  if [ "$workbench" -lt 1 ] || [ "$host" -lt 1 ]; then
    echo "u5-driver: missing Live Run controls: live-run-workbench=$workbench live-run-terminal-host=$host" >&2
    return 1
  fi
  if [ "$screens" -lt 1 ]; then
    echo "u5-driver: missing declaration: SHELL-SCREEN is absent from $executable" >&2
    return 1
  fi
  echo "PASS: provenance declared (SHELL-SCREEN=$screens) with Live Run controls (hits=$((workbench + host)))"
}

# --- published coordinates --------------------------------------------------
#
# The instance id is derived ONCE by the rig and published. Both sides read
# that value. Recomputing the sha256 prefix here is how a wrong-instance bug
# survives review: two identical-looking prefixes of different inputs.

published_instance_id() {
  local coordinates="${1:-}"
  [ -f "$coordinates" ] || return 1
  local value
  value="$(sed -n 's/^u5_instance_id=//p' "$coordinates" | head -n 1)"
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

derive_screenshot_paths() {
  local ready="$1" root="$2"
  python3 - "$ready" "$root" <<'PY'
import json, sys
ready = json.load(open(sys.argv[1]))
root = sys.argv[2]
agents = ready.get("agents")
if not isinstance(agents, list) or not agents:
    raise SystemExit(1)
seen = set()
for agent in agents:
    provider = agent.get("provider")
    if not isinstance(provider, str) or not provider or provider in seen:
        raise SystemExit(1)
    seen.add(provider)
    print(f"{root}/workspace-final-{provider}.png")
PY
}

ready_agent_rows() {
  python3 - "$1" <<'PY'
import json, sys
ready = json.load(open(sys.argv[1]))
if ready.get("schemaVersion") != 1 or ready.get("state") != "ready":
    raise SystemExit("ready marker is not a v1 ready document")
agents = ready.get("agents")
if not isinstance(agents, list) or not agents:
    raise SystemExit("ready marker has no agents")
seen = set()
for agent in agents:
    provider = agent.get("provider")
    agent_id = agent.get("agentId")
    if not isinstance(provider, str) or not provider:
        raise SystemExit("ready agent is missing provider")
    if not isinstance(agent_id, str) or not agent_id:
        raise SystemExit("ready agent is missing agentId")
    if provider in seen:
        raise SystemExit(f"ready marker repeats provider {provider}")
    seen.add(provider)
    print(f"{provider}\t{agent_id}")
PY
}

receipt_has_agent() {
  python3 - "$1" "$2" <<'PY'
import json, sys
receipt = json.load(open(sys.argv[1]))
agent_id = sys.argv[2]
if receipt.get("schemaVersion") != 1:
    raise SystemExit(1)
for entry in receipt.get("acceptedVisibility") or []:
    terminals = entry.get("terminals") or []
    if entry.get("terminalCount") != len(terminals) or len(terminals) > 1:
        continue
    if terminals and terminals[0].get("agentId") == agent_id:
        raise SystemExit(0)
raise SystemExit(1)
PY
}

write_release() {
  python3 - <<'PY'
import json, os, sys

payload = {
    "schemaVersion": 1,
    "viewerPid": int(os.environ["U5_VIEWER_PID"]),
    "executablePath": os.environ["U5_EXECUTABLE"],
    "launchArguments": os.environ["U5_LAUNCH_ARGS"].split("\n"),
    "launchedAt": os.environ["U5_LAUNCHED_AT"],
    "preKillProcessReadback": os.environ["U5_PREKILL"],
    "sigkillIssuedAt": os.environ["U5_SIGKILL_AT"],
    "waitStatus": os.environ["U5_WAIT_STATUS"],
    "postKillState": "absent",
    "postKillProbe": os.environ["U5_POSTKILL"],
    "screenshots": [line for line in os.environ["U5_SCREENSHOTS"].split("\n") if line],
}
path = os.environ["U5_RELEASE_PATH"]
temporary = path + ".tmp"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
    handle.write("\n")
os.replace(temporary, path)
PY
}

# --- launch -----------------------------------------------------------------
#
# AX driving reuses the same lldb-on-identifier pattern tour.sh already uses.
# There is no second accessibility stack. The screenshot basename is the
# provider; identity is the agentId. name/model/status are evidence and never
# used to select a row.

LAUNCH_IDENTITY=""
APP_PID=""
APP_LLDB_LOG=""

cleanup_launch() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$LAUNCH_IDENTITY" ]; then
    kill_scoped "$LAUNCH_IDENTITY" >/dev/null 2>&1 || true
  fi
  exit "$status"
}

lldb_value() {
  local output value
  [ -n "$APP_PID" ] || return 1
  output="$(/usr/bin/lldb -b -p "$APP_PID" -o "expr -l objc -- $1" -o detach 2>&1)" || true
  [ -z "$APP_LLDB_LOG" ] || printf '%s\n' "$output" >> "$APP_LLDB_LOG"
  value="$(printf '%s\n' "$output" | awk '/\$0 = /{print $NF}' | tail -n 1)"
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

NSAPP='((NSApplication*)[NSApplication sharedApplication])'

workbench_window_number() {
  lldb_value "NSArray *wins=[$NSAPP windows]; NSWindow *hit=(NSWindow*)0; for (NSWindow *candidate in wins) { NSMutableArray *q=[NSMutableArray arrayWithObject:[candidate contentView]]; BOOL found=NO; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([(NSString*)[v accessibilityIdentifier] isEqualToString:@\"live-run-workbench\"]) { found=YES; break; } [q addObjectsFromArray:[v subviews]]; } if (found) { hit=candidate; break; } } (long)[hit windowNumber]"
}

terminal_host_present() {
  lldb_value "NSArray *wins=[$NSAPP windows]; long hosts=0; for (NSWindow *candidate in wins) { NSMutableArray *q=[NSMutableArray arrayWithObject:[candidate contentView]]; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([(NSString*)[v accessibilityIdentifier] isEqualToString:@\"live-run-terminal-host\"]) { hosts += 1; } [q addObjectsFromArray:[v subviews]]; } } hosts"
}

session_button_present() {
  local target_id="$1"
  lldb_value "NSArray *wins=[$NSAPP windows]; NSButton *hit=(NSButton*)0; for (NSWindow *candidate in wins) { NSMutableArray *q=[NSMutableArray arrayWithObject:[candidate contentView]]; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([v isKindOfClass:[NSButton class]] && [(NSString*)[v accessibilityIdentifier] isEqualToString:@\"live-run-session-$target_id\"]) { hit=(NSButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } if (hit) break; } (long)hit"
}

click_session() {
  local target_id="$1"
  lldb_value "NSArray *wins=[$NSAPP windows]; NSButton *hit=(NSButton*)0; for (NSWindow *candidate in wins) { NSMutableArray *q=[NSMutableArray arrayWithObject:[candidate contentView]]; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([v isKindOfClass:[NSButton class]] && [(NSString*)[v accessibilityIdentifier] isEqualToString:@\"live-run-session-$target_id\"]) { hit=(NSButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } if (hit) break; } [hit performSelector:@selector(performClick:) withObject:(id)0 afterDelay:0.2]; (long)hit"
}

run_driver() {
  local home project artifacts source_root port
  home="${HIVE_QA_HOME:-}"
  project="${HIVE_QA_PROJECT:-}"
  artifacts="${HIVE_QA_ARTIFACTS:-}"
  source_root="${HIVE_QA_SRC_ROOT:-}"
  port="${HIVE_QA_PORT:-}"
  [ -n "$home" ] || die "HIVE_QA_HOME is required"
  [ -n "$project" ] || die "HIVE_QA_PROJECT is required"
  [ -n "$source_root" ] || die "HIVE_QA_SRC_ROOT is required"
  [ -n "$port" ] || die "HIVE_QA_PORT is required"
  [ -n "$artifacts" ] || artifacts="$home/artifacts"

  home="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$home")"
  project="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$project")"
  artifacts="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$artifacts")"
  source_root="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$source_root")"

  case "$home" in
    /tmp/hvqa-*|/private/tmp/hvqa-*) ;;
    *) die "QA home is not an isolated short rig: $home" ;;
  esac
  case "$project" in
    /tmp/*|/private/tmp/*) ;;
    *) die "QA project is outside the temporary root: $project" ;;
  esac
  [ "$project" != "/Users/scottkellar/Projects/hive-test-project" ] \
    || die "refusing the shared hive-test-project"
  case "$artifacts/" in
    "$home"/*) ;;
    *) die "artifact root is outside the isolated home" ;;
  esac

  local executable ready_path release_path receipt_path coordinates
  executable="${HIVE_QA_U5_APP_EXECUTABLE:-}"
  ready_path="${HIVE_QA_U5_APP_READY_PATH:-}"
  release_path="${HIVE_QA_U5_APP_RELEASE_PATH:-}"
  receipt_path="${HIVE_QA_U5_APP_FEED_RECEIPT:-}"
  [ -n "$executable" ] || die "HIVE_QA_U5_APP_EXECUTABLE is required"
  [ -n "$ready_path" ] || die "HIVE_QA_U5_APP_READY_PATH is required"
  [ -n "$release_path" ] || die "HIVE_QA_U5_APP_RELEASE_PATH is required"
  [ -n "$receipt_path" ] || die "HIVE_QA_U5_APP_FEED_RECEIPT is required"
  executable="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$executable")"
  case "$executable" in
    */HiveWorkspace.app/Contents/MacOS/HiveWorkspace) ;;
    *) die "not an exact Workspace app executable: $executable" ;;
  esac
  [ -x "$executable" ] || die "Workspace executable is not executable: $executable"
  [ ! -e "$release_path" ] || die "release rendezvous already exists: $release_path"

  check_provenance "$executable" || exit 1

  coordinates="$artifacts/coordinates.txt"
  local instance_id
  instance_id="$(published_instance_id "$coordinates")" \
    || die "published u5_instance_id is absent from $coordinates"

  local hive_bin feed_bin
  hive_bin="$artifacts/hive-bin"
  feed_bin="$artifacts/u5-workspace-feed-bridge"
  [ -x "$hive_bin" ] || die "hive-bin is absent: $hive_bin"
  [ -x "$feed_bin" ] || die "feed bridge is absent: $feed_bin"

  local waited=0
  while [ ! -f "$ready_path" ]; do
    [ "$waited" -lt 600 ] || die "not ready after 600s: ready marker never arrived"
    sleep 1
    waited=$((waited + 1))
  done

  local rows
  rows="$(ready_agent_rows "$ready_path")" \
    || die "ready marker is unreadable or has no agents: $ready_path"

  local evidence_root
  evidence_root="$(python3 -c 'import json,os,sys; print(os.path.realpath(json.load(open(sys.argv[1]))["evidenceRoot"]))' "$ready_path")"
  case "$evidence_root/" in
    "$artifacts"/*) ;;
    *) die "ready marker points outside the artifact root: $evidence_root" ;;
  esac
  mkdir -p "$evidence_root"

  local screenshot_paths
  screenshot_paths="$(derive_screenshot_paths "$ready_path" "$evidence_root")" \
    || die "could not derive screenshot paths from the ready marker"

  local app_log
  APP_LLDB_LOG="$evidence_root/08-workspace-lldb.log"
  app_log="$evidence_root/08-workspace-app.log"
  [ ! -e "$app_log" ] || die "app log already exists: $app_log"

  local launch_args
  launch_args="--workspace-shell-live
--port $port
--instance-home $home
--hive $hive_bin
--project $project
--instance-id $instance_id
--feed $feed_bin"

  trap cleanup_launch EXIT HUP INT TERM

  local launched_at
  launched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  env -u HIVE_SHELL_PROOF -u HIVE_SHELL_PROOF_MUTATE -u HIVE_SHELL_SCENARIO \
    HIVE_HOME="$home" \
    HIVE_QA_HOME="$home" \
    HIVE_QA_PROJECT="$project" \
    HIVE_QA_PORT="$port" \
    HIVE_QA_ARTIFACTS="$artifacts" \
    HIVE_QA_SRC_ROOT="$source_root" \
    HIVE_QA_U5_APP_READY_PATH="$ready_path" \
    HIVE_QA_U5_APP_FEED_RECEIPT="$receipt_path" \
    "$executable" \
    --workspace-shell-live \
    --port "$port" \
    --instance-home "$home" \
    --hive "$hive_bin" \
    --project "$project" \
    --instance-id "$instance_id" \
    --feed "$feed_bin" \
    >"$app_log" 2>&1 &
  APP_PID=$!
  LAUNCH_IDENTITY="$(capture_identity "$APP_PID")" \
    || die "could not capture the launched Workspace identity"

  workbench_ready() {
    local number
    identity_matches "$LAUNCH_IDENTITY" || return 1
    number="$(workbench_window_number 2>/dev/null || true)"
    [ -n "$number" ] && [ "$number" != "0" ]
  }
  wait_until_ready 90 workbench_ready >/dev/null \
    || die "not ready after 90s: live-run-workbench window never appeared"

  host_ready() {
    local hosts
    identity_matches "$LAUNCH_IDENTITY" || return 1
    hosts="$(terminal_host_present 2>/dev/null || true)"
    [ -n "$hosts" ] && [ "$hosts" != "0" ]
  }
  wait_until_ready 90 host_ready >/dev/null \
    || die "not ready after 90s: live-run-terminal-host never appeared"

  local provider agent_id
  while IFS="$(printf '\t')" read -r provider agent_id; do
    session_ready() {
      local hit
      identity_matches "$LAUNCH_IDENTITY" || return 1
      hit="$(session_button_present "$agent_id" 2>/dev/null || true)"
      [ -n "$hit" ] && [ "$hit" != "0" ]
    }
    wait_until_ready 90 session_ready >/dev/null \
      || die "not ready after 90s: live-run-session-$agent_id never appeared"
  done <<EOF
$rows
EOF

  receipt_ready() {
    [ -f "$receipt_path" ] || return 1
    python3 - "$receipt_path" <<'PY'
import json, sys
receipt = json.load(open(sys.argv[1]))
raise SystemExit(0 if receipt.get("schemaVersion") == 1 else 1)
PY
  }
  wait_until_ready 90 receipt_ready >/dev/null \
    || die "not ready after 90s: feed receipt never arrived"

  local win_id captured=""
  win_id="$(workbench_window_number)" \
    || die "live-run-workbench window number disappeared"
  [ "$win_id" != "0" ] || die "live-run-workbench window number is zero"

  while IFS="$(printf '\t')" read -r provider agent_id; do
    local hit
    hit="$(click_session "$agent_id" 2>/dev/null || true)"
    [ -n "$hit" ] && [ "$hit" != "0" ] \
      || die "row control is absent for $provider/$agent_id"
    agent_receipt_ready() {
      [ -f "$receipt_path" ] || return 1
      receipt_has_agent "$receipt_path" "$agent_id"
    }
    wait_until_ready 90 agent_receipt_ready >/dev/null \
      || die "feed receipt never selected $provider/$agent_id"
    local shot
    shot="$evidence_root/workspace-final-$provider.png"
    [ ! -e "$shot" ] || die "screenshot already exists: $shot"
    /usr/sbin/screencapture -x -o -l "$win_id" "$shot" \
      || die "window capture failed for $provider"
    [ "$(stat -f %z "$shot")" -gt 30000 ] \
      || die "$provider screenshot is blank or near-blank"
    captured="${captured}${captured:+$'\n'}$shot"
  done <<EOF
$rows
EOF

  [ "$captured" = "$screenshot_paths" ] \
    || die "captured screenshot set does not match the ready-derived set"

  local exe_sha prekill
  exe_sha="$(/usr/bin/shasum -a 256 "$executable" | awk '{print $1}')"
  prekill="$(/bin/ps -ww -p "$APP_PID" -o pid=,command=)"
  printf '%s\n' "$prekill" | grep -q "$executable" \
    || die "pre-kill readback did not contain the executable: $prekill"
  printf '%s\n' "$prekill" | grep -q -- "--instance-id $instance_id" \
    || die "pre-kill readback did not contain the published instance id"
  prekill="$prekill
executableSha256=$exe_sha"

  local sigkill_at
  sigkill_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  kill_scoped "$LAUNCH_IDENTITY" || die "scoped SIGKILL failed"
  LAUNCH_IDENTITY=""
  APP_PID=""

  local post_out post_err post_rc viewer_pid
  viewer_pid="$(printf '%s\n' "$prekill" | awk 'NR==1 {print $1}')"
  post_out="$(mktemp /tmp/hvqa-u5-ps.XXXXXX)"
  post_err="$(mktemp /tmp/hvqa-u5-ps.XXXXXX)"
  if /bin/ps -p "$viewer_pid" -o pid= >"$post_out" 2>"$post_err"; then
    post_rc=0
  else
    post_rc=$?
  fi
  [ "$post_rc" -eq 1 ] && [ ! -s "$post_out" ] && [ ! -s "$post_err" ] \
    || die "viewer pid $viewer_pid was not independently absent (exit=$post_rc)"
  local postkill
  postkill="ps -p $viewer_pid -o pid=: exit=$post_rc stdout= stderr="
  rm -f "$post_out" "$post_err"

  if [ "$KILL_WAIT_STATUS" != "137" ]; then
    log "reaped waitStatus $KILL_WAIT_STATUS, not 137; recording the observed value"
  fi

  U5_VIEWER_PID="$viewer_pid" \
  U5_EXECUTABLE="$executable" \
  U5_LAUNCH_ARGS="$launch_args" \
  U5_LAUNCHED_AT="$launched_at" \
  U5_PREKILL="$prekill" \
  U5_SIGKILL_AT="$sigkill_at" \
  U5_WAIT_STATUS="$KILL_WAIT_STATUS" \
  U5_POSTKILL="$postkill" \
  U5_SCREENSHOTS="$captured" \
  U5_RELEASE_PATH="$release_path" \
    write_release || die "could not write the release marker"

  trap - EXIT HUP INT TERM
  log "release published at $release_path"
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

  # Screenshot names come from the ready marker's agents. A four-row ready
  # file must not grow a fifth (kimi) name, which is the hardcoded-five defect.
  local scratch ready_json coordinates_file
  scratch="$(mktemp -d /tmp/hvqa-u5-sc.XXXXXX)" || die "could not make a self-check scratch dir"
  ready_json="$scratch/ready.json"
  coordinates_file="$scratch/coordinates.txt"
  python3 - "$ready_json" <<'PY'
import json, sys
json.dump({
    "schemaVersion": 1,
    "state": "ready",
    "observedAt": "2026-08-16T00:00:00Z",
    "evidenceRoot": "/tmp/hvqa-u5-sc/evidence",
    "agents": [
        {"agentId": "a1", "name": "n1", "provider": "claude", "model": "m", "status": "working",
         "locator": {"schemaVersion": 1, "instanceId": "i", "subject": {"kind": "agent", "agentId": "a1"},
                     "generation": 1, "sessionId": "ses_1", "hostKind": "sessiond", "engineBuildId": "e"}},
        {"agentId": "a2", "name": "n2", "provider": "codex", "model": "m", "status": "working",
         "locator": {"schemaVersion": 1, "instanceId": "i", "subject": {"kind": "agent", "agentId": "a2"},
                     "generation": 1, "sessionId": "ses_2", "hostKind": "sessiond", "engineBuildId": "e"}},
        {"agentId": "a3", "name": "n3", "provider": "grok", "model": "m", "status": "working",
         "locator": {"schemaVersion": 1, "instanceId": "i", "subject": {"kind": "agent", "agentId": "a3"},
                     "generation": 1, "sessionId": "ses_3", "hostKind": "sessiond", "engineBuildId": "e"}},
        {"agentId": "a4", "name": "n4", "provider": "opencode", "model": "m", "status": "working",
         "locator": {"schemaVersion": 1, "instanceId": "i", "subject": {"kind": "agent", "agentId": "a4"},
                     "generation": 1, "sessionId": "ses_4", "hostKind": "sessiond", "engineBuildId": "e"}},
    ],
}, open(sys.argv[1], "w"))
PY
  local shots
  shots="$(derive_screenshot_paths "$ready_json" "$scratch" || true)"
  if printf '%s\n' "$shots" | grep -Fq "workspace-final-kimi.png"; then
    bad "a four-agent ready marker produced a kimi screenshot"
  elif [ "$(printf '%s\n' "$shots" | grep -c 'workspace-final-')" -eq 4 ]; then
    ok "screenshot set is derived from the ready marker (4, no kimi)"
  else
    bad "derived screenshot set was not the four ready providers: $shots"
  fi

  printf 'u5_instance_id=abcdef0123\n' > "$coordinates_file"
  if [ "$(published_instance_id "$coordinates_file")" = "abcdef0123" ]; then
    ok "the published instance id is read, not computed"
  else
    bad "published instance id was not read from coordinates"
  fi
  if published_instance_id "$scratch/missing.txt" >/dev/null 2>&1; then
    bad "a missing coordinates file produced an instance id"
  else
    ok "a missing published instance id is a refusal, not a recomputed prefix"
  fi

  # Provenance: Live Run identifiers without SHELL-SCREEN is the inverted
  # control the currently staged main-built app satisfies. A complete fixture
  # must pass.
  printf 'live-run-workbench\nlive-run-terminal-host\n' > "$scratch/old-app.bin"
  printf 'live-run-workbench\nlive-run-terminal-host\nSHELL-SCREEN run|show-live-run|Workspace|Live Run\n' \
    > "$scratch/new-app.bin"
  if check_provenance "$scratch/old-app.bin" >/dev/null 2>&1; then
    bad "an app with no SHELL-SCREEN declaration was accepted"
  else
    ok "missing declaration is refused by name"
  fi
  if check_provenance "$scratch/new-app.bin" >/dev/null 2>&1; then
    ok "a declared app with Live Run controls is accepted"
  else
    bad "a complete provenance fixture was refused"
  fi

  local release_probe="$scratch/release.json"
  if [ -e "$release_probe" ]; then
    bad "self-check started with a release marker already present"
  else
    ok "a refusal path left the release marker absent"
  fi
  rm -rf "$scratch"

  [ "$failures" -eq 0 ] || die "$failures scope or readiness control(s) failed"
  echo "PASS: termination is scoped to captured identities and readiness is bounded"
}

case "${1:-}" in
  self-check) self_check ;;
  provenance) check_provenance "${2:-}" || exit 1 ;;
  run) run_driver ;;
  *) echo "usage: qa/u5-app-driver.sh self-check|provenance <executable>|run" >&2; exit 2 ;;
esac
