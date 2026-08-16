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
#   - Termination is one of two NAMED outcomes, each carrying its own proof of
#     death. reaped-as-child carries the reaped value verbatim, never computed
#     as 128+9, plus the post-kill readback. confirmed-dead-by-observation
#     carries the identity probe and no wait status at all, because launchd owns
#     the app and this shell has no status to collect for it. Neither is ever
#     synthesised to stand in for the other.
#   - --instance-id is the published u5_instance_id, never a recomputed prefix.
#   - The screenshot set is derived from the ready marker's agents, never a
#     hardcoded five.
# Do not set HIVE_SHELL_PROOF=1 for the live launch: it makes the app
# background-only.
set -uo pipefail
QA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$QA_DIR/qa-home.sh"
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

# How the process ended, as one of two NAMED outcomes, never collapsed into one
# field. A reader tells them apart by the name, not by inspecting prose:
#   reaped-as-child               we waited for our own child; KILL_WAIT_STATUS
#                                 holds the real status, verbatim
#   confirmed-dead-by-observation the process belonged to launchd, so this shell
#                                 could not wait for it; KILL_OBSERVATION holds
#                                 the probe that proved it gone and there is no
#                                 wait status to report
KILL_OUTCOME=""
KILL_OBSERVATION=""

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

# Whether this shell is able to reap the process itself.
#
# `wait` answers 127 for a process that is not a child of this shell — but a
# child that genuinely exits 127 answers 127 as well, so the NUMBER cannot tell
# "there was no status to collect" from "the status was 127". That is the
# did-not-run versus ran-and-failed confusion, and reading it off the return
# value would bake it in. Parentage is therefore read from the process itself,
# before the kill, while there is still a process to read.
process_is_own_child() {
  local parent
  parent="$(ps -p "$1" -o ppid= 2>/dev/null | tr -d ' ')"
  [ -n "$parent" ] && [ "$parent" = "$$" ]
}

# The captured process is gone when its IDENTITY no longer resolves, which is
# strictly stronger than the pid being absent: a recycled pid fails the start
# token, so the original is still correctly reported as gone rather than a
# stranger being reported as the survivor. The probe that establishes it is
# recorded, because "confirmed dead" with nothing behind it is an assumption.
confirm_identity_gone() {
  local identity="$1"
  local pid="${identity%%:*}"
  local waited=0 probe rc
  while [ "$waited" -lt 50 ]; do
    if ! identity_matches "$identity"; then
      probe="$(/bin/ps -ww -p "$pid" -o pid=,command= 2>&1)" && rc=0 || rc=$?
      KILL_OBSERVATION="identity $identity no longer resolves; ps -p $pid -o pid=,command=: exit=$rc output=${probe:-empty}"
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  echo "u5-driver: $pid still carries the captured identity after SIGKILL" >&2
  return 1
}

kill_scoped() {
  local identity="${1:-}"
  # Declared on its own line: bash 3.2, which is the bash on this rig, does not
  # expand a variable declared earlier on the SAME `local` line, so folding
  # these two together leaves pid empty and the kill silently signals nothing.
  local pid="${identity%%:*}"
  local own_child=""
  KILL_WAIT_STATUS=""
  KILL_OUTCOME=""
  KILL_OBSERVATION=""
  if ! identity_matches "$identity"; then
    echo "u5-driver: refusing to signal '${pid:-none}': not the captured process" >&2
    return 1
  fi
  process_is_own_child "$pid" && own_child="yes"
  kill -KILL "$pid" 2>/dev/null || true
  if [ -n "$own_child" ]; then
    reap_sigkill "$pid" || return 1
    KILL_OUTCOME="reaped-as-child"
    if process_alive "$pid"; then
      echo "u5-driver: $pid survived SIGKILL" >&2
      return 1
    fi
    return 0
  fi
  # /usr/bin/open hands the Workspace to launchd, so the app this driver kills
  # is nobody's child here and there is no status to collect for it.
  confirm_identity_gone "$identity" || return 1
  KILL_OUTCOME="confirmed-dead-by-observation"
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

# Same identity production launchWorkspace passes: the registry uuid and
# the project basename. Inventing either would complete LaunchConfig
# against a project the daemon does not know.
published_project_id() {
  python3 - "$1" "$2" <<'PY'
import json, os, sys
home, project = sys.argv[1], sys.argv[2]
path = os.path.join(home, "project-registry.json")
try:
    registry = json.load(open(path))
except FileNotFoundError:
    raise SystemExit("project-registry.json is absent")
for record in registry.get("records") or []:
    if not isinstance(record, dict):
        continue
    if record.get("confirmedCanonicalPath") == project or record.get(
        "identityKey"
    ) == project:
        uuid = record.get("hiveUuid")
        if isinstance(uuid, str) and uuid:
            print(uuid)
            raise SystemExit(0)
raise SystemExit("no registry identity for this project")
PY
}

# One token list is both the recorded argv and the exec argv. 851cce8b
# wrote --project-id/--project-name into the release record only; the
# process never received them. A valued flag is two lines so a missing
# identity flag is a missing line.
workspace_launch_tokens() {
  printf '%s\n' \
    --workspace-shell-live \
    --port "$1" \
    --instance-home "$2" \
    --hive "$3" \
    --project "$4" \
    --project-id "$5" \
    --project-name "$6" \
    --instance-id "$7" \
    --feed "$8"
}

# Production's argv for `open`. Not a second listing of those flags.
production_open_arguments() {
  local app="$1"
  shift
  local root
  root="$(qa_repo_root "$QA_DIR")" || return 1
  (cd "$root" && bun -e '
import { workspaceOpenArguments } from "./src/cli/workspace.ts";
const app = process.argv[1];
const args = process.argv.slice(2);
if (!app) throw new Error("app path required");
for (const token of workspaceOpenArguments(
  app,
  args,
  process.env.PATH,
  process.env.TMPDIR,
)) {
  process.stdout.write(`${token}\n`);
}
' "$app" "$@")
}

# QA feed coordinates are not a launch flag. They go in as --env
# immediately before --args so the builder's -n/-a/--stderr/--args stay
# the production spine.
insert_env_before_args() {
  python3 -c '
import sys
tokens = [line for line in sys.stdin.read().splitlines() if line != ""]
envs = sys.argv[1:]
out = []
inserted = False
for token in tokens:
    if token == "--args" and not inserted:
        for item in envs:
            out.append("--env")
            out.append(item)
        inserted = True
    out.append(token)
if not inserted:
    raise SystemExit("open argv has no --args")
print("\n".join(out))
' "$@"
}

# Every process whose argv carries THIS launch's published --instance-id, one
# per line as "pid<TAB>ppid<TAB>command".
#
# The needle travels in the environment rather than in awk's argv. Written as
# `awk -v needle="--instance-id $id"`, the needle is part of awk's OWN command
# line, so `ps` reports the searcher as a candidate and the search matches
# itself.
instance_candidates() {
  local instance_id="$1"
  ps -axww -o pid=,ppid=,command= \
    | u5_bind_needle="--instance-id ${instance_id}" awk '
        index($0, ENVIRON["u5_bind_needle"]) {
          pid = $1
          ppid = $2
          $1 = ""
          $2 = ""
          sub(/^[[:space:]]+/, "")
          print pid "\t" ppid "\t" $0
        }
      '
}

# `open` returns without a pid. Bind the process that carries THIS
# launch's published --instance-id, then confirm it is the executable
# we launched. Not a name match. A second HiveWorkspace on the host
# (production) is ignored unless it has this instance id.
#
# EVERY candidate is examined on every poll. More than one process carries this
# id by construction — the app spawns a feed bridge that repeats --instance-id
# in its own argv — and `ps` output is not ordered by pid, so the first matching
# line is not reliably the app. Reading only the first line and treating a
# mismatch as failure ends the search on the first poll, roughly a tenth of a
# second in, rather than waiting for the app to appear.
#
# A deadline of 0 means one census and no waiting, which is what the pre-launch
# "nothing already holds this id" assertion needs: a process that does not exist
# yet cannot be a process that already exists.
bind_open_app_pid() {
  local instance_id="$1" executable="$2" deadline_seconds="$3"
  local polls=$((deadline_seconds * 2)) waited=0
  local pid ppid command seen="" started ended
  started="$(date +%s)"
  while :; do
    while IFS="$(printf '\t')" read -r pid ppid command; do
      [ -n "$pid" ] || continue
      case "$seen" in
        *" $pid="*) ;;
        *) seen="$seen $pid=$command;" ;;
      esac
      process_alive "$pid" || continue
      printf '%s\n' "$command" | grep -qF "$executable" || continue
      printf '%s\n' "$pid"
      return 0
    done <<EOF
$(instance_candidates "$instance_id")
EOF
    [ "$waited" -lt "$polls" ] || break
    sleep 0.5
    waited=$((waited + 1))
  done
  ended="$(date +%s)"
  if [ "$polls" -gt 0 ]; then
    echo "u5-driver: nothing carrying --instance-id $instance_id ran $executable;" \
      "waited $((ended - started))s; candidates seen:${seen:- none}" >&2
  fi
  return 1
}

# A failed bind still launched an app. The EXIT trap can only reap a captured
# identity, and a failed bind never produces one, so the app and the feed bridge
# it spawned both survive the driver — and `rig.sh down` then fails on those
# live identities.
#
# The reap is keyed on the published instance id, which belongs to this rig
# alone, and every kill is an exact pid whose argv is re-read immediately before
# the signal. Nothing is matched by name, so a production Workspace on a
# different instance id is never a candidate.
reap_launched_instance() {
  local instance_id="$1" executable="$2"
  local pid ppid command app_pids="" doomed="" identity survivors=""

  while IFS="$(printf '\t')" read -r pid ppid command; do
    [ -n "$pid" ] || continue
    printf '%s\n' "$command" | grep -qF "$executable" || continue
    app_pids="$app_pids $pid"
  done <<EOF
$(instance_candidates "$instance_id")
EOF
  [ -n "$app_pids" ] || return 0

  # Children are collected before anything is killed: once the app dies its
  # children are reparented to launchd and their descent from this launch can no
  # longer be established.
  while IFS="$(printf '\t')" read -r pid ppid command; do
    [ -n "$pid" ] || continue
    case " $app_pids " in
      *" $ppid "*) doomed="$doomed $pid" ;;
    esac
  done <<EOF
$(instance_candidates "$instance_id")
EOF
  doomed="$doomed$app_pids"

  for pid in $doomed; do
    identity="$(capture_identity "$pid")" || continue
    /bin/ps -ww -p "$pid" -o command= | grep -qF -- "--instance-id $instance_id" \
      || continue
    kill_scoped "$identity" >/dev/null 2>&1 || true
  done

  sleep 1
  for pid in $doomed; do
    if process_alive "$pid"; then
      survivors="$survivors $pid"
    fi
  done
  if [ -n "$survivors" ]; then
    log "reap left processes alive:$survivors"
    return 1
  fi
  log "reaped the launched instance:$doomed"
}

format_timeout_diagnosis() {
  local reason="$1"
  local shown="$2"
  local applog="$3"
  shown="$(printf '%s' "$shown" | tr '\n\r' '  ' | sed 's/  */ /g;s/^ //;s/ $//')"
  [ -n "$shown" ] || shown="unreadable"
  [ -n "$applog" ] || applog="unreported"
  printf '%s (on-screen: %s; app-log: %s)\n' "$reason" "$shown" "$applog"
}

# 0-byte and missing logs are named states, never a silent "app said nothing".
app_log_capture_status() {
  local path="${DRIVER_APP_LOG:-}"
  local bytes
  if [ -z "$path" ] && [ -n "${DRIVER_EVIDENCE_ROOT:-}" ]; then
    path="$DRIVER_EVIDENCE_ROOT/08-workspace-app.log"
  fi
  if [ -z "$path" ] || [ ! -e "$path" ]; then
    printf '%s' "absent"
    return
  fi
  bytes="$(wc -c < "$path" | tr -d ' ')"
  if [ "${bytes:-0}" -eq 0 ]; then
    printf '%s' "empty"
    return
  fi
  printf 'captured %s bytes' "$bytes"
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


# One of two named outcomes, discriminated by "outcome" so a reader never has to
# parse prose to learn which happened. Each outcome carries its OWN proof of
# death, rather than leaving that to a field sitting beside them where a reader
# would have to work out which proof belongs to which case.
#
# The child case proves it with the reaped status and the post-kill readback.
# The orphan case proves it with the identity probe, which is the stronger
# evidence there and the reason the readback is not repeated alongside it: the
# readback says the pid is absent, while the identity probe says THIS process is
# gone, and only the latter still holds if the pid has been recycled.
#
# waitStatus appears only when there was a real status to collect. Neither field
# is ever synthesised to fill the other's place.
def termination():
    outcome = os.environ["U5_KILL_OUTCOME"]
    if outcome == "reaped-as-child":
        return {
            "outcome": outcome,
            "waitStatus": os.environ["U5_WAIT_STATUS"],
            "postKillReadback": os.environ["U5_POSTKILL"],
        }
    if outcome == "confirmed-dead-by-observation":
        return {"outcome": outcome, "identityProbe": os.environ["U5_KILL_OBSERVATION"]}
    raise SystemExit(f"unnamed termination outcome: {outcome!r}")


payload = {
    "schemaVersion": 1,
    "viewerPid": int(os.environ["U5_VIEWER_PID"]),
    "executablePath": os.environ["U5_EXECUTABLE"],
    "launchArguments": os.environ["U5_LAUNCH_ARGS"].split("\n"),
    "launchedAt": os.environ["U5_LAUNCHED_AT"],
    "preKillProcessReadback": os.environ["U5_PREKILL"],
    "sigkillIssuedAt": os.environ["U5_SIGKILL_AT"],
    "termination": termination(),
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
DRIVER_EVIDENCE_ROOT=""
DRIVER_APP_LOG=""

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

# Visible NSTextField text inside live-run-terminal-host. Written to a
# file because lldb_value only keeps the last awk field of `$0 =`.
read_terminal_host_text() {
  local dest="${1:-}"
  [ -n "$APP_PID" ] || return 1
  [ -n "$dest" ] || return 1
  rm -f "$dest"
  lldb_value "NSArray *wins=[$NSAPP windows]; NSMutableArray *parts=[NSMutableArray array]; for (NSWindow *candidate in wins) { NSMutableArray *q=[NSMutableArray arrayWithObject:[candidate contentView]]; NSView *host=(NSView*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([(NSString*)[v accessibilityIdentifier] isEqualToString:@\"live-run-terminal-host\"]) { host=v; break; } [q addObjectsFromArray:[v subviews]]; } if (!host) continue; NSMutableArray *q2=[NSMutableArray arrayWithObject:host]; while ([q2 count] > 0) { NSView *v=(NSView*)[q2 objectAtIndex:0]; [q2 removeObjectAtIndex:0]; if ([v isKindOfClass:[NSTextField class]] && ![(NSView*)v isHidden] && [[(NSTextField*)v stringValue] length] > 0) { [parts addObject:[(NSTextField*)v stringValue]]; } [q2 addObjectsFromArray:[v subviews]]; } } NSString *text=[parts componentsJoinedByString:@\" | \"]; [text writeToFile:@\"$dest\" atomically:YES encoding:4 error:(NSError**)0]; (long)[text length]" >/dev/null || true
  [ -f "$dest" ]
}

on_screen_text_from_file() {
  local dest="${1:-}"
  [ -f "$dest" ] || return 1
  tr '\n\r' '  ' < "$dest"
}

capture_timeout_on_screen() {
  local dest_txt dest_png shown="" win_id
  if [ -n "${DRIVER_EVIDENCE_ROOT:-}" ]; then
    dest_txt="$DRIVER_EVIDENCE_ROOT/08-timeout-on-screen.txt"
    dest_png="$DRIVER_EVIDENCE_ROOT/08-timeout-on-screen.png"
    if identity_matches "$LAUNCH_IDENTITY" 2>/dev/null; then
      read_terminal_host_text "$dest_txt" || true
      win_id="$(workbench_window_number 2>/dev/null || true)"
      if [ -n "$win_id" ] && [ "$win_id" != "0" ]; then
        /usr/sbin/screencapture -x -o -l "$win_id" "$dest_png" 2>/dev/null || true
      fi
    fi
    shown="$(on_screen_text_from_file "$dest_txt" || true)"
  fi
  printf '%s' "$shown"
}

emit_timeout_diagnosis() {
  format_timeout_diagnosis "$1" "$(capture_timeout_on_screen)" "$(app_log_capture_status)"
}

die_after_launch() {
  die "$(emit_timeout_diagnosis "$1")"
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

  qa_home_is_isolated "$home" \
    || die "QA home is not an isolated short rig: $home"
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

  local project_id project_name
  project_id="$(published_project_id "$home" "$project")" \
    || die "published project identity is absent from $home/project-registry.json"
  project_name="$(basename "$project")"
  [ -n "$project_name" ] || die "project name is empty"

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
  DRIVER_EVIDENCE_ROOT="$evidence_root"

  local screenshot_paths
  screenshot_paths="$(derive_screenshot_paths "$ready_path" "$evidence_root")" \
    || die "could not derive screenshot paths from the ready marker"

  local app_bundle app_log
  app_bundle="${executable%/Contents/MacOS/HiveWorkspace}"
  [ "$app_bundle/Contents/MacOS/HiveWorkspace" = "$executable" ] \
    || die "cannot derive the .app bundle from $executable"
  APP_LLDB_LOG="$evidence_root/08-workspace-lldb.log"
  app_log="$home/workspace.log"
  [ ! -e "$app_log" ] || die "workspace.log already exists: $app_log"
  DRIVER_APP_LOG="$app_log"

  local launch_args
  launch_args="$(workspace_launch_tokens \
    "$port" "$home" "$hive_bin" "$project" \
    "$project_id" "$project_name" "$instance_id" "$feed_bin")"
  printf '%s\n' "$launch_args" | grep -qx -- '--project-id' \
    || die "launch argv dropped --project-id"
  printf '%s\n' "$launch_args" | grep -qx -- '--project-name' \
    || die "launch argv dropped --project-name"

  local -a launch_tokens
  launch_tokens=()
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    launch_tokens+=("$tok")
  done <<EOF
$launch_args
EOF
  [ "${#launch_tokens[@]}" -eq 17 ] \
    || die "launch argv is incomplete: ${#launch_tokens[@]} tokens"

  local open_args
  open_args="$(production_open_arguments "$app_bundle" "${launch_tokens[@]}")" \
    || die "workspaceOpenArguments refused to build the open argv"
  printf '%s\n' "$open_args" | grep -qx -- '-n' \
    || die "production open argv dropped -n"
  printf '%s\n' "$open_args" | grep -qx -- '--stderr' \
    || die "production open argv dropped --stderr"
  printf '%s\n' "$open_args" | grep -qx -- "$app_log" \
    || die "production open argv did not bind stderr to $app_log"

  open_args="$(printf '%s\n' "$open_args" | insert_env_before_args \
    "HIVE_QA_HOME=$home" \
    "HIVE_QA_PROJECT=$project" \
    "HIVE_QA_PORT=$port" \
    "HIVE_QA_ARTIFACTS=$artifacts" \
    "HIVE_QA_SRC_ROOT=$source_root" \
    "HIVE_QA_U5_APP_READY_PATH=$ready_path" \
    "HIVE_QA_U5_APP_FEED_RECEIPT=$receipt_path")" \
    || die "could not insert QA feed environment before --args"

  local -a open_tokens
  open_tokens=()
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    open_tokens+=("$tok")
  done <<EOF
$open_args
EOF

  if bind_open_app_pid "$instance_id" "$executable" 0 >/dev/null; then
    die "a process already carries --instance-id $instance_id"
  fi

  trap cleanup_launch EXIT HUP INT TERM

  local launched_at
  launched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  /usr/bin/open "${open_tokens[@]}" || die "open refused to launch the Workspace"
  if ! APP_PID="$(bind_open_app_pid "$instance_id" "$executable" 60)"; then
    reap_launched_instance "$instance_id" "$executable" || true
    die "could not bind the launched Workspace pid for --instance-id $instance_id"
  fi
  LAUNCH_IDENTITY="$(capture_identity "$APP_PID")" \
    || die "could not capture the launched Workspace identity"

  workbench_ready() {
    local number
    identity_matches "$LAUNCH_IDENTITY" || return 1
    number="$(workbench_window_number 2>/dev/null || true)"
    [ -n "$number" ] && [ "$number" != "0" ]
  }
  wait_until_ready 90 workbench_ready >/dev/null \
    || die_after_launch "not ready after 90s: live-run-workbench window never appeared"

  host_ready() {
    local hosts
    identity_matches "$LAUNCH_IDENTITY" || return 1
    hosts="$(terminal_host_present 2>/dev/null || true)"
    [ -n "$hosts" ] && [ "$hosts" != "0" ]
  }
  wait_until_ready 90 host_ready >/dev/null \
    || die_after_launch "not ready after 90s: live-run-terminal-host never appeared"

  local provider agent_id
  while IFS="$(printf '\t')" read -r provider agent_id; do
    session_ready() {
      local hit
      identity_matches "$LAUNCH_IDENTITY" || return 1
      hit="$(session_button_present "$agent_id" 2>/dev/null || true)"
      [ -n "$hit" ] && [ "$hit" != "0" ]
    }
    wait_until_ready 90 session_ready >/dev/null \
      || die_after_launch "not ready after 90s: live-run-session-$agent_id never appeared"
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
    || die_after_launch "not ready after 90s: feed receipt never arrived"

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
      || die_after_launch "feed receipt never selected $provider/$agent_id"
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

  case "$KILL_OUTCOME" in
    reaped-as-child)
      [ "$KILL_WAIT_STATUS" = "137" ] \
        || log "reaped waitStatus $KILL_WAIT_STATUS, not 137; recording the observed value"
      ;;
    confirmed-dead-by-observation)
      log "the app belonged to launchd, so no wait status exists; recording the observation instead"
      ;;
    *) die "termination outcome was never named: '${KILL_OUTCOME:-none}'" ;;
  esac

  U5_VIEWER_PID="$viewer_pid" \
  U5_EXECUTABLE="$executable" \
  U5_LAUNCH_ARGS="$launch_args" \
  U5_LAUNCHED_AT="$launched_at" \
  U5_PREKILL="$prekill" \
  U5_SIGKILL_AT="$sigkill_at" \
  U5_KILL_OUTCOME="$KILL_OUTCOME" \
  U5_KILL_OBSERVATION="$KILL_OBSERVATION" \
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

  # Termination outcomes. The app this driver kills is reparented to launchd by
  # /usr/bin/open, so the orphan path is the REAL path and it gets a real
  # ppid-1 orphan here, not a stand-in.
  local orphan_pid_file orphan_pid orphan_ppid orphan_identity
  orphan_pid_file="$(mktemp /tmp/hvqa-u5-orphan.XXXXXX)"
  ( /bin/sleep 60 & echo $! > "$orphan_pid_file" )
  sleep 0.6
  orphan_pid="$(cat "$orphan_pid_file")"
  rm -f "$orphan_pid_file"
  orphan_ppid="$(ps -p "$orphan_pid" -o ppid= 2>/dev/null | tr -d ' ')"
  if [ "$orphan_ppid" = "1" ]; then
    ok "the fixture is a genuine launchd orphan (pid $orphan_pid, ppid 1)"
  else
    bad "the orphan fixture has ppid '${orphan_ppid:-none}', so it proves nothing about the real path"
  fi
  if process_is_own_child "$orphan_pid"; then
    bad "an orphan was read as this shell's child"
  else
    ok "parentage is read from the process: the orphan is not this shell's child"
  fi

  orphan_identity="$(capture_identity "$orphan_pid")" || bad "could not capture the orphan identity"
  if kill_scoped "$orphan_identity"; then
    ok "kill_scoped SUCCEEDS against a launchd-reparented process (it used to fail here)"
  else
    bad "kill_scoped still fails against a ppid-1 orphan: line 774 will still die"
  fi
  if [ "$KILL_OUTCOME" = "confirmed-dead-by-observation" ]; then
    ok "the orphan outcome is NAMED confirmed-dead-by-observation"
  else
    bad "orphan outcome was '${KILL_OUTCOME:-none}'"
  fi
  # The whole point: 127 means "not a child", so it must never be recorded as
  # if it were a status. A child that genuinely exits 127 returns 127 too, and
  # the two are indistinguishable by number.
  if [ -z "$KILL_WAIT_STATUS" ]; then
    ok "no wait status was recorded for the orphan: 127 was never mistaken for one"
  else
    bad "a wait status '$KILL_WAIT_STATUS' was recorded for a process we cannot wait for"
  fi
  if printf '%s' "$KILL_OBSERVATION" | grep -q "$orphan_pid"; then
    ok "the orphan death is backed by a recorded exact-pid observation"
  else
    bad "confirmed-dead carried no observation: that is an assumption, not a measurement"
  fi

  # The child path is unchanged and must stay that way.
  /bin/sh -c 'sleep 60' &
  local child_pid=$!
  sleep 0.3
  local child_identity
  child_identity="$(capture_identity "$child_pid")" || bad "could not capture the child identity"
  if kill_scoped "$child_identity" \
    && [ "$KILL_OUTCOME" = "reaped-as-child" ] && [ "$KILL_WAIT_STATUS" = "137" ]; then
    ok "a real child is still reaped as a child with its verbatim status 137"
  else
    bad "child path changed: outcome='${KILL_OUTCOME:-none}' status='${KILL_WAIT_STATUS:-none}'"
  fi

  # Teeth. A confirmation that cannot fail is indistinguishable from no check.
  # A process that survives SIGKILL cannot be built safely on this host, so the
  # refusal is proven on the function that renders the verdict.
  /bin/sh -c 'sleep 60' &
  local survivor_pid=$!
  sleep 0.3
  local survivor_identity
  survivor_identity="$(capture_identity "$survivor_pid")" || bad "could not capture the survivor identity"
  if confirm_identity_gone "$survivor_identity" 2>/dev/null; then
    bad "a live process was confirmed dead: the check has no teeth"
  else
    ok "a live process is REFUSED confirmation rather than reported dead"
  fi
  if process_alive "$survivor_pid"; then
    ok "the refused survivor is still alive and was not signalled by the check"
  else
    bad "the confirmation killed the process it was asked to observe"
  fi
  kill -KILL "$survivor_pid" 2>/dev/null || true
  wait "$survivor_pid" 2>/dev/null

  # The marker must never carry a fabricated status, and never both shapes.
  local rel_scratch rel_child rel_orphan
  rel_scratch="$(mktemp -d /tmp/hvqa-u5-rel.XXXXXX)"
  rel_child="$rel_scratch/child.json"
  rel_orphan="$rel_scratch/orphan.json"
  U5_VIEWER_PID=1234 U5_EXECUTABLE=/tmp/x U5_LAUNCH_ARGS="--a" \
  U5_LAUNCHED_AT="2026-01-01T00:00:00Z" U5_PREKILL="p" \
  U5_SIGKILL_AT="2026-01-01T00:00:01Z" U5_KILL_OUTCOME="reaped-as-child" \
  U5_KILL_OBSERVATION="" U5_WAIT_STATUS="137" U5_POSTKILL="q" \
  U5_SCREENSHOTS="/tmp/s.png" U5_RELEASE_PATH="$rel_child" write_release
  U5_VIEWER_PID=1234 U5_EXECUTABLE=/tmp/x U5_LAUNCH_ARGS="--a" \
  U5_LAUNCHED_AT="2026-01-01T00:00:00Z" U5_PREKILL="p" \
  U5_SIGKILL_AT="2026-01-01T00:00:01Z" U5_KILL_OUTCOME="confirmed-dead-by-observation" \
  U5_KILL_OBSERVATION="identity 7:1:1 no longer resolves" U5_WAIT_STATUS="" U5_POSTKILL="q" \
  U5_SCREENSHOTS="/tmp/s.png" U5_RELEASE_PATH="$rel_orphan" write_release
  if python3 - "$rel_child" "$rel_orphan" <<'PY'
import json, sys
child_doc = json.load(open(sys.argv[1]))
orphan_doc = json.load(open(sys.argv[2]))
child = child_doc["termination"]
orphan = orphan_doc["termination"]
assert child == {
    "outcome": "reaped-as-child",
    "waitStatus": "137",
    "postKillReadback": "q",
}, child
assert orphan["outcome"] == "confirmed-dead-by-observation", orphan
assert "waitStatus" not in orphan, orphan
assert orphan["identityProbe"], orphan
assert "identityProbe" not in child, child
# Each outcome proves death inside its own member: nothing is left beside them
# for a reader to guess at.
for doc in (child_doc, orphan_doc):
    assert "postKillState" not in doc, doc
    assert "postKillProbe" not in doc, doc
    assert "waitStatus" not in doc, doc
PY
  then
    ok "each outcome carries its own proof of death and nothing is left beside them"
  else
    bad "the release marker did not distinguish the two termination outcomes"
  fi
  if U5_VIEWER_PID=1234 U5_EXECUTABLE=/tmp/x U5_LAUNCH_ARGS="--a" \
    U5_LAUNCHED_AT="2026-01-01T00:00:00Z" U5_PREKILL="p" \
    U5_SIGKILL_AT="2026-01-01T00:00:01Z" U5_KILL_OUTCOME="" \
    U5_KILL_OBSERVATION="" U5_WAIT_STATUS="" U5_POSTKILL="q" \
    U5_SCREENSHOTS="/tmp/s.png" U5_RELEASE_PATH="$rel_scratch/bad.json" \
    write_release >/dev/null 2>&1; then
    bad "an unnamed termination outcome was written to the marker"
  else
    ok "an unnamed termination outcome is refused rather than written"
  fi
  rm -rf "$rel_scratch"

  # Binding the launched app. These fixtures forge argv with `exec -a`, so they
  # carry an instance id and an executable path without an app or a GUI.
  local bind_exe="/tmp/hvqa-u5-bind/HiveWorkspace.app/Contents/MacOS/HiveWorkspace"
  local bind_id="hvqabind$$" other_id="hvqaother$$"
  local bind_started bind_ended bind_elapsed bound bind_err

  # The searcher must not be a candidate. `awk -v needle=...` puts the instance
  # id into awk's own argv, so `ps` reports it and the search finds itself.
  if [ -z "$(instance_candidates "$bind_id")" ]; then
    ok "the candidate census does not match its own search process"
  else
    bad "the census matched itself: $(instance_candidates "$bind_id")"
  fi

  # THE DEFECT THIS FILE WAS OPENED FOR. A process carrying the instance id with
  # a DIFFERENT executable exists by construction — the app spawns a feed bridge
  # that repeats --instance-id in its argv. Reading only the first ps line and
  # failing on a mismatch abandons the whole wait, so the app that arrives a
  # moment later is never bound.
  /bin/sh -c "exec -a 'bun run u5-workspace-feed-bridge.ts --port 1 --instance-id $bind_id' /bin/sleep 60" &
  local decoy_pid=$!
  # A production Workspace: same executable, its own instance id, not this rig's.
  /bin/sh -c "exec -a '$bind_exe --workspace-shell-live --instance-id $other_id' /bin/sleep 60" &
  local production_pid=$!
  # The app itself appears only after the first polls have already run.
  ( sleep 2; exec -a "$bind_exe --workspace-shell-live --instance-id $bind_id --feed /tmp/f" /bin/sleep 60 ) &
  local late_app_shell=$!
  sleep 0.3

  bind_started="$(date +%s)"
  bound="$(bind_open_app_pid "$bind_id" "$bind_exe" 20 2>/dev/null)"
  bind_ended="$(date +%s)"
  bind_elapsed=$((bind_ended - bind_started))
  if [ -n "$bound" ] && [ "$bound" != "$decoy_pid" ] && [ "$bound" != "$production_pid" ]; then
    ok "a decoy carrying the instance id was skipped and the real app was bound ($bind_elapsed s)"
  else
    bad "bind returned '${bound:-nothing}' after ${bind_elapsed}s: the decoy collapsed the wait"
  fi
  if [ "$bind_elapsed" -ge 1 ]; then
    ok "the wait outlived the decoy rather than being abandoned on the first poll"
  else
    bad "bind returned in ${bind_elapsed}s: it cannot have waited for the late app"
  fi
  if [ -n "$bound" ] && process_alive "$production_pid" \
    && [ "$(/bin/ps -ww -p "$bound" -o command= | grep -c -- "--instance-id $bind_id")" -eq 1 ]; then
    ok "the production Workspace on another instance id was never bound"
  else
    bad "a Workspace on instance id $other_id was bound or the bound pid is not this rig's"
  fi

  # The pre-launch assertion is one census. Waiting for a process that is
  # supposed to be absent to appear is ten seconds of nothing on every run.
  bind_started="$(date +%s)"
  bind_open_app_pid "absent$$" "$bind_exe" 0 >/dev/null 2>&1
  bind_ended="$(date +%s)"
  if [ "$((bind_ended - bind_started))" -le 1 ]; then
    ok "the pre-launch census refuses immediately instead of waiting out a window"
  else
    bad "the zero-deadline census waited $((bind_ended - bind_started))s"
  fi

  # A genuinely absent app must still fail, and say what it waited for.
  bind_started="$(date +%s)"
  bind_err="$(bind_open_app_pid "absent$$" "$bind_exe" 2 2>&1 >/dev/null)"
  bind_ended="$(date +%s)"
  bind_elapsed=$((bind_ended - bind_started))
  if [ "$bind_elapsed" -ge 2 ] \
    && printf '%s\n' "$bind_err" | grep -q "waited ${bind_elapsed}s" \
    && printf '%s\n' "$bind_err" | grep -q "candidates seen: none"; then
    ok "an absent app fails after its full window and names the wait and the candidates"
  else
    bad "absent-app failure did not name a measured wait and its candidates: $bind_err"
  fi

  # A failed bind must not orphan what it launched. The app and the bridge it
  # spawned are reaped by exact pid; the production Workspace is not.
  kill -KILL "$decoy_pid" "$late_app_shell" 2>/dev/null || true
  wait "$decoy_pid" "$late_app_shell" 2>/dev/null
  local reap_id="hvqareap$$"
  /bin/sh -c "
    /bin/sh -c \"exec -a 'bun run u5-workspace-feed-bridge.ts --instance-id $reap_id' /bin/sleep 60\" &
    exec -a '$bind_exe --workspace-shell-live --instance-id $reap_id' /bin/sleep 60
  " &
  local reap_app=$!
  sleep 0.5
  local reap_bridge
  reap_bridge="$(instance_candidates "$reap_id" | awk -F'\t' -v p="$reap_app" '$2 == p { print $1 }')"
  if [ -n "$reap_bridge" ]; then
    ok "the fixture reproduces the leak: app $reap_app with child $reap_bridge"
  else
    bad "the reap fixture has no child process, so it cannot prove the two-process leak"
  fi
  reap_launched_instance "$reap_id" "$bind_exe" >/dev/null 2>&1
  if ! process_alive "$reap_app" && [ -n "$reap_bridge" ] && ! process_alive "$reap_bridge"; then
    ok "a failed bind reaps both the app and the child it spawned"
  else
    bad "the reap left the app or its child alive: app=$reap_app bridge=$reap_bridge"
  fi
  if process_alive "$production_pid"; then
    ok "the reap left the production Workspace on another instance id alive"
  else
    bad "the reap killed a Workspace it did not launch"
  fi
  wait "$reap_app" 2>/dev/null
  kill -KILL "$production_pid" 2>/dev/null || true
  wait "$production_pid" 2>/dev/null

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
  python3 - "$scratch/project-registry.json" <<'PY'
import json, sys
json.dump({
    "records": [{
        "hiveUuid": "48558525-a01d-4037-875e-8b72203eef0a",
        "identityKey": "/private/tmp/u5p-h",
        "confirmedCanonicalPath": "/private/tmp/u5p-h",
    }],
    "tombstones": [],
}, open(sys.argv[1], "w"))
PY
  if [ "$(published_project_id "$scratch" "/private/tmp/u5p-h")" = "48558525-a01d-4037-875e-8b72203eef0a" ] \
    && ! published_project_id "$scratch" "/private/tmp/other" >/dev/null 2>&1 \
    && ! published_project_id "$scratch/missing" "/private/tmp/u5p-h" >/dev/null 2>&1; then
    ok "project identity is read from the registry and refused when absent"
  else
    bad "project identity helper did not read or refuse correctly"
  fi

  local tokens
  tokens="$(workspace_launch_tokens 9 /tmp/h /tmp/hive /tmp/p \
    48558525-a01d-4037-875e-8b72203eef0a u5p-h abcdef /tmp/feed)"
  if printf '%s\n' "$tokens" | grep -qx -- '--project-id' \
    && printf '%s\n' "$tokens" | grep -qx -- '48558525-a01d-4037-875e-8b72203eef0a' \
    && printf '%s\n' "$tokens" | grep -qx -- '--project-name' \
    && printf '%s\n' "$tokens" | grep -qx -- 'u5p-h' \
    && [ "$(printf '%s\n' "$tokens" | grep -c .)" -eq 17 ]; then
    ok "launch argv is one list and includes project identity flags"
  else
    bad "launch argv helper dropped project identity flags: $tokens"
  fi

  local built with_env
  built="$(production_open_arguments /tmp/HiveWorkspace.app \
    --instance-home /tmp/hq-open --project /tmp/p || true)"
  if printf '%s\n' "$built" | grep -qx -- '-n' \
    && printf '%s\n' "$built" | grep -qx -- '-a' \
    && printf '%s\n' "$built" | grep -qx -- '/tmp/HiveWorkspace.app' \
    && printf '%s\n' "$built" | grep -qx -- '--stderr' \
    && printf '%s\n' "$built" | grep -qx -- '/tmp/hq-open/workspace.log' \
    && printf '%s\n' "$built" | grep -qx -- '--args'; then
    ok "open argv comes from workspaceOpenArguments and binds --stderr"
  else
    bad "production open argv is wrong: $built"
  fi
  with_env="$(printf '%s\n' "$built" | insert_env_before_args "HIVE_QA_HOME=/tmp/hq-open" || true)"
  if printf '%s\n' "$with_env" | awk '
      $0 == "--env" { getline; if ($0 == "HIVE_QA_HOME=/tmp/hq-open") env=1 }
      $0 == "--args" { args=1; exit }
      END { exit !(env && args) }
    ' \
    && printf '%s\n' "$with_env" | grep -qx -- '/tmp/hq-open/workspace.log'; then
    ok "QA feed env is inserted before --args without rewriting --stderr"
  else
    bad "QA env insert broke the production open argv: $with_env"
  fi

  if [ "$(format_timeout_diagnosis "feed receipt never selected claude/x" "Terminal transport is absent in this launch." empty)" \
      = "feed receipt never selected claude/x (on-screen: Terminal transport is absent in this launch.; app-log: empty)" ] \
    && [ "$(format_timeout_diagnosis "feed receipt never arrived" "" absent)" \
      = "feed receipt never arrived (on-screen: unreadable; app-log: absent)" ]; then
    ok "timeout names the on-screen placeholder rather than only the missing receipt"
  else
    bad "timeout diagnosis does not surface on-screen text"
  fi

  # Formatter-only is not the capture path. Induce a bounded wait
  # failure and run the same emit die_after_launch uses.
  local saved_evidence saved_app_log timeout_miss timeout_hit timeout_empty timeout_bytes
  saved_evidence="${DRIVER_EVIDENCE_ROOT:-}"
  saved_app_log="${DRIVER_APP_LOG:-}"
  DRIVER_EVIDENCE_ROOT="$scratch/timeout-evidence"
  DRIVER_APP_LOG=""
  mkdir -p "$DRIVER_EVIDENCE_ROOT"
  if wait_until_ready 1 never_ready >/dev/null 2>&1; then
    bad "induced timeout did not fail"
  else
    timeout_miss="$(emit_timeout_diagnosis "feed receipt never selected claude/x")"
    if [ "$timeout_miss" = "feed receipt never selected claude/x (on-screen: unreadable; app-log: absent)" ]; then
      ok "induced timeout with no capture file reports unreadable"
    else
      bad "empty capture was not unreadable: $timeout_miss"
    fi
    printf '%s\n' "Terminal transport is absent in this launch." \
      > "$DRIVER_EVIDENCE_ROOT/08-timeout-on-screen.txt"
    timeout_hit="$(emit_timeout_diagnosis "feed receipt never selected claude/x")"
    if [ "$timeout_hit" = "feed receipt never selected claude/x (on-screen: Terminal transport is absent in this launch.; app-log: absent)" ]; then
      ok "induced timeout reports the on-screen placeholder the capture wrote"
    else
      bad "capture did not report the induced on-screen text: $timeout_hit"
    fi
    : > "$DRIVER_EVIDENCE_ROOT/08-workspace-app.log"
    DRIVER_APP_LOG="$DRIVER_EVIDENCE_ROOT/08-workspace-app.log"
    timeout_empty="$(emit_timeout_diagnosis "feed receipt never selected claude/x")"
    if [ "$timeout_empty" = "feed receipt never selected claude/x (on-screen: Terminal transport is absent in this launch.; app-log: empty)" ]; then
      ok "a 0-byte app log is reported empty rather than treated as silence"
    else
      bad "0-byte app log was not named empty: $timeout_empty"
    fi
    printf 'nslog line\n' > "$DRIVER_APP_LOG"
    timeout_bytes="$(emit_timeout_diagnosis "feed receipt never selected claude/x")"
    if [ "$timeout_bytes" = "feed receipt never selected claude/x (on-screen: Terminal transport is absent in this launch.; app-log: captured 11 bytes)" ]; then
      ok "a non-empty app log reports a captured byte count"
    else
      bad "non-empty app log was not named as captured: $timeout_bytes"
    fi
  fi
  DRIVER_EVIDENCE_ROOT="$saved_evidence"
  DRIVER_APP_LOG="$saved_app_log"

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
