#!/usr/bin/env bash
# qa/rig.sh — stand up, drive, and tear down an isolated QA Hive.
#
#   qa/rig.sh up             bring up the QA daemon and leave it running
#   qa/rig.sh run <cmd...>   up, run the command with HIVE_QA_* exported, down
#   qa/rig.sh down           stop QA processes; exit 1 if any survive
#
# Parameters (environment):
#   QA_HOME          /tmp/hvqa-<checkout hash> — must resolve under hvqa-*
#   QA_PROJECT       /Users/scottkellar/Projects/hive-test-project
#   QA_SRC_ROOT      the checkout containing this script (the code under test)
#   QA_HIVE_BIN      optional compiled Hive binary; source execution is the default
#   QA_SESSIOND_BIN  the staged binary in the primary checkout
#   QA_SKIP_POLICY   1 leaves routing unconfigured, so spawns are refused
#
# The daemon runs FROM SOURCE: `bun run $QA_SRC_ROOT/src/cli.ts daemon`. No
# shared development runtime is involved. After bring-up the daemon's own
# startup announcement is compared
# against the hash of the sources under test (qa/verify-announcement.ts), so
# a stale or wrong-tree daemon fails loudly instead of testing the wrong code.
#
# The gate resolves QA_HOME before checking its name. This matters on macOS,
# where /tmp resolves through /private, and it prevents a safely named symlink
# from redirecting the rig into the user or development instance.
set -uo pipefail

PRIMARY_CHECKOUT="/Users/scottkellar/Projects/hive"
QA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$QA_DIR/repo-root.sh"
SRC_DEFAULT="$(qa_repo_root "$QA_DIR")" || exit 2
# Where the QA tree sits inside a checkout, so the harness helpers below can
# be found inside the source root UNDER TEST, which is not always this one.
QA_TREE_SUBDIR="$(qa_tree_subdir "$QA_DIR")" || exit 2
QA_SRC_ROOT="${QA_SRC_ROOT:-$SRC_DEFAULT}"
QA_HOME_TAG="$(printf '%s' "$SRC_DEFAULT" | /usr/bin/shasum -a 256 | cut -c1-10)"
QA_HOME_REQUESTED="${QA_HOME:-/tmp/hvqa-$QA_HOME_TAG}"
QA_HOME="$QA_HOME_REQUESTED"
QA_PROJECT="${QA_PROJECT:-/Users/scottkellar/Projects/hive-test-project}"
QA_HIVE_BIN="${QA_HIVE_BIN:-}"
QA_SESSIOND_BIN="${QA_SESSIOND_BIN:-$PRIMARY_CHECKOUT/native/sessiond/zig-out/bin/hive-sessiond}"

refuse() { echo "rig: refusing: $*" >&2; exit 2; }

# --- the gate -----------------------------------------------------------
command -v python3 >/dev/null || refuse "python3 is required"
command -v lsof >/dev/null || refuse "lsof is required"
QA_HOME_RESOLVED="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$QA_HOME")" \
  || refuse "could not resolve QA_HOME '$QA_HOME'"
PRIMARY_RESOLVED="$(cd "$PRIMARY_CHECKOUT" && pwd -P)" \
  || refuse "primary checkout does not exist: $PRIMARY_CHECKOUT"
DEV_HOME_TAG="$(printf '%s' "$PRIMARY_RESOLVED" | /usr/bin/shasum -a 256 | cut -c1-10)"
DEV_HOME_RESOLVED="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$HOME/.hive/instances/dev-$DEV_HOME_TAG")" \
  || refuse "could not resolve the primary development home"
USER_HOME_RESOLVED="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$HOME/.hive")" \
  || refuse "could not resolve the user home"

case "$QA_HOME_RESOLVED" in
  "$USER_HOME_RESOLVED"|"$USER_HOME_RESOLVED"/*)
    refuse "QA_HOME resolves to the protected user home: '$QA_HOME_RESOLVED'" ;;
  "$DEV_HOME_RESOLVED"|"$DEV_HOME_RESOLVED"/*)
    refuse "QA_HOME resolves to the protected primary dev home: '$QA_HOME_RESOLVED'" ;;
esac
case "$QA_HOME_RESOLVED" in
  /tmp/hvqa-?*|/private/tmp/hvqa-?*) ;;
  *) refuse "QA_HOME must resolve under /tmp/hvqa-* (got '$QA_HOME' -> '$QA_HOME_RESOLVED')" ;;
esac

# Bind the checked path into every later use. Keeping the caller's symlink here
# would reopen the gate if that link were swapped after validation.
QA_HOME="$QA_HOME_RESOLVED"
ARTIFACTS="$QA_HOME/artifacts"
QA_DEFAULT_HOME="$QA_HOME/default"

mode="${1:-}"
[ -n "$mode" ] || { echo "usage: qa/rig.sh up|run <cmd...>|down" >&2; exit 2; }
shift

# --- helpers ------------------------------------------------------------
require_project() {
  [ -d "$QA_SRC_ROOT/src" ] || refuse "QA_SRC_ROOT has no source tree: $QA_SRC_ROOT"
  [ -d "$QA_PROJECT" ] || refuse "QA_PROJECT does not exist: $QA_PROJECT"
  [ -e "$QA_PROJECT/.git" ] || refuse "QA_PROJECT is not a git repository: $QA_PROJECT"
  local projp srcp
  projp="$(cd "$QA_PROJECT" && pwd -P)"
  srcp="$(cd "$QA_SRC_ROOT" && pwd -P)"
  # The rig must never aim Hive at the Hive checkout itself (init would write
  # into the live repo's .hive), nor at a parent of it (the primary checkout
  # when running from a worktree).
  case "$projp/" in "$srcp"/*) refuse "QA_PROJECT is inside QA_SRC_ROOT ($projp)";; esac
  case "$srcp/" in "$projp"/*) refuse "QA_PROJECT contains QA_SRC_ROOT ($projp)";; esac
  case "$projp" in "$HOME/.hive"|"$HOME/.hive/"*) refuse "QA_PROJECT is under ~/.hive";; esac
}

daemon_env() {
  env HIVE_HOME="$QA_HOME" HIVE_PORT=0 HIVE_DISABLE_UPDATES=1 \
    HIVE_DEFAULT_HOME="$QA_DEFAULT_HOME" \
    HIVE_SESSIOND_BIN="$QA_SESSIOND_BIN" "$@"
}

hive_cli() {
  if [ -n "$QA_HIVE_BIN" ]; then
    daemon_env "$QA_HIVE_BIN" "$@"
  else
    daemon_env bun run "$QA_SRC_ROOT/src/cli.ts" "$@"
  fi
}

# Detached with its own session so the process survives this shell. Prints the
# child pid on stdout.
start_detached() { # <logfile> <cwd> <argv...>
  local log="$1" cwd="$2"; shift 2
  HIVE_QA_DETACH_LOG="$log" HIVE_QA_DETACH_CWD="$cwd" \
  HIVE_HOME="$QA_HOME" HIVE_PORT=0 HIVE_DISABLE_UPDATES=1 \
  HIVE_DEFAULT_HOME="$QA_DEFAULT_HOME" \
  HIVE_SESSIOND_BIN="$QA_SESSIOND_BIN" \
  python3 - "$@" <<'PY'
import os, subprocess, sys
log = open(os.environ["HIVE_QA_DETACH_LOG"], "a")
p = subprocess.Popen(
    sys.argv[1:], cwd=os.environ["HIVE_QA_DETACH_CWD"], env=dict(os.environ),
    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
)
print(p.pid)
PY
}

wait_for_file() { # <path> <seconds>
  local i=0
  while [ "$i" -lt "$2" ]; do [ -s "$1" ] && return 0; sleep 1; i=$((i + 1)); done
  [ -s "$1" ]
}

valid_pid() {
  case "${1:-}" in ""|*[!0-9]*) return 1;; esac
  [ "$1" -gt 1 ] 2>/dev/null
}

process_alive() {
  local state
  valid_pid "${1:-}" || return 1
  state="$(ps -p "$1" -o stat= 2>/dev/null | tr -d ' ')"
  case "$state" in ""|Z*) return 1;; esac
  return 0
}

# A pidfile proves where to look, not what may be killed. The recorded start
# time and an open QA-home binding together keep stale or reused PIDs out.
process_start() {
  # PROC_PIDTBSDINFO records birth seconds and microseconds at byte 120. Unlike
  # ps lstart, this cannot collide when a PID is reused within the same second.
  python3 - "$1" <<'PY'
import ctypes
import struct
import sys

pid = int(sys.argv[1])
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
buffer = ctypes.create_string_buffer(136)
if lib.proc_pidinfo(pid, 3, 0, buffer, len(buffer)) != len(buffer):
    raise SystemExit(1)
seconds, microseconds = struct.unpack_from("<QQ", buffer.raw, 120)
print(f"{seconds}:{microseconds}")
PY
}

# A PID alone is never signal authority. The start token stays attached through
# every grace-period check, so PID reuse cannot redirect TERM or KILL.
process_token() {
  process_start "$1"
}

identity_for_pid() {
  local token
  process_alive "$1" || return 1
  token="$(process_token "$1")" || return 1
  printf '%s:%s\n' "$1" "$token"
}

identity_matches() {
  local identity="$1" p token current
  p="${identity%%:*}"
  token="${identity#*:}"
  valid_pid "$p" || return 1
  [ "$token" != "$identity" ] || return 1
  process_alive "$p" || return 1
  current="$(process_token "$p")" || return 1
  [ "$current" = "$token" ]
}

# A forged pidfile cannot render the rig or any invoking shell eligible for a
# signal. Such a process remains visible to the final binding readback.
is_invoker_pid() {
  local target="$1" current="$$" parent
  while valid_pid "$current"; do
    [ "$target" != "$current" ] || return 0
    parent="$(ps -p "$current" -o ppid= 2>/dev/null | tr -d ' ')"
    valid_pid "$parent" || break
    [ "$parent" != "$current" ] || break
    current="$parent"
  done
  return 1
}

# lsof's empty result is trustworthy only after the same invocation sees this
# shell's cwd inside the home. That positive control turns reader failures red.
BOUND_PIDS=""
read_bound_pids() {
  local prior output p
  BOUND_PIDS=""
  [ ! -e "$QA_HOME" ] || [ -d "$QA_HOME" ] \
    || { echo "rig: binding readback failed: QA_HOME is not a directory" >&2; return 2; }
  [ -d "$QA_HOME" ] || return 0
  prior="$(pwd -P)" || return 2
  cd "$QA_HOME" \
    || { echo "rig: binding readback could not enter $QA_HOME" >&2; return 2; }
  output="$(lsof -n -P +D . -Fp 2>&1)"
  cd "$prior" \
    || { echo "rig: binding readback could not restore $prior" >&2; return 2; }
  if printf '%s\n' "$output" | grep -q '^lsof:' ||
     ! printf '%s\n' "$output" | grep -Fxq "p$$"; then
    echo "rig: binding readback failed its lsof positive control" >&2
    return 2
  fi
  for p in $(printf '%s\n' "$output" | sed -n 's/^p//p'); do
    valid_pid "$p" \
      || { echo "rig: binding readback returned an invalid pid" >&2; return 2; }
    [ "$p" != "$$" ] || continue
    process_alive "$p" && BOUND_PIDS="$BOUND_PIDS $p"
  done
  return 0
}

ROOT_IDENTITIES=""
recorded_root_identities() {
  local bound="$1" kind file start_file p recorded_start current_start identity
  ROOT_IDENTITIES=""
  for kind in daemon owner; do
    file="$QA_HOME/$kind.pid"
    start_file="$QA_HOME/$kind.start"
    [ -f "$file" ] || continue
    p="$(sed -n '1p' "$file" 2>/dev/null)"
    if ! valid_pid "$p"; then
      echo "rig: ignoring invalid $kind pidfile: $file" >&2
      continue
    fi
    process_alive "$p" || continue
    if is_invoker_pid "$p"; then
      echo "rig: ignoring invoker $kind pid $p" >&2
      continue
    fi
    recorded_start="$(sed -n '1p' "$start_file" 2>/dev/null)"
    current_start="$(process_start "$p")"
    if [ -z "$recorded_start" ] || [ "$recorded_start" != "$current_start" ]; then
      echo "rig: ignoring stale $kind pid $p" >&2
      continue
    fi
    case " $bound " in
      *" $p "*) ;;
      *) echo "rig: ignoring unbound $kind pid $p" >&2; continue;;
    esac
    identity="$(identity_for_pid "$p")" || continue
    ROOT_IDENTITIES="$ROOT_IDENTITIES $identity"
  done
}

# Capture the whole tree before signalling its roots. Interactive shells give
# each background job a different process group, but parentage still identifies
# the job until its shell exits.
OWNED_IDENTITIES=""
collect_owned_identities() {
  local roots="$1" known=" " changed p parent identity entry
  OWNED_IDENTITIES="$roots"
  for entry in $roots; do
    p="${entry%%:*}"
    known="$known$p "
  done
  while :; do
    changed=0
    while read -r p parent; do
      valid_pid "$p" && valid_pid "$parent" || continue
      case "$known" in *" $parent "*)
        case "$known" in
          *" $p "*) ;;
          *)
            identity="$(identity_for_pid "$p")" || continue
            known="$known$p "
            OWNED_IDENTITIES="$OWNED_IDENTITIES $identity"
            changed=1
            ;;
        esac
        ;;
      esac
    done < <(ps -axo pid=,ppid=)
    [ "$changed" -eq 1 ] || break
  done
}

ALIVE_IDENTITIES=""
refresh_alive_identities() {
  local entry
  ALIVE_IDENTITIES=""
  for entry in $1; do
    identity_matches "$entry" && ALIVE_IDENTITIES="$ALIVE_IDENTITIES $entry"
  done
}

signal_identities() {
  local signal="$1" identities="$2" entry p
  for entry in $identities; do
    if identity_matches "$entry"; then
      p="${entry%%:*}"
      kill -s "$signal" "$p" 2>/dev/null || true
    fi
  done
}

terminate_identities() {
  local signal="$1" identities="$2" i=0
  signal_identities "$signal" "$identities"
  i=0
  while [ "$i" -lt 20 ]; do
    refresh_alive_identities "$identities"
    [ -z "$ALIVE_IDENTITIES" ] && break
    sleep 0.5; i=$((i + 1))
  done
  signal_identities KILL "$ALIVE_IDENTITIES"
  i=0
  while [ "$i" -lt 20 ]; do
    refresh_alive_identities "$ALIVE_IDENTITIES"
    [ -z "$ALIVE_IDENTITIES" ] && break
    sleep 0.1; i=$((i + 1))
  done
}

OWNED_SURVIVORS=""
sweep() {
  local entry
  OWNED_SURVIVORS=""
  read_bound_pids || return $?
  recorded_root_identities "$BOUND_PIDS"
  collect_owned_identities "$ROOT_IDENTITIES"
  terminate_identities TERM "$OWNED_IDENTITIES"
  for entry in $ALIVE_IDENTITIES; do
    OWNED_SURVIVORS="$OWNED_SURVIVORS ${entry%%:*}"
  done
}

rig_down() {
  local survivors p
  sweep || return $?
  read_bound_pids || return $?
  survivors="$(printf '%s\n' $OWNED_SURVIVORS $BOUND_PIDS | sed '/^$/d' | sort -un)"
  if [ -n "$survivors" ]; then
    echo "rig: down FAILED — processes still bound to $QA_HOME:" >&2
    for p in $survivors; do ps -p "$p" -o pid=,command= >&2; done
    return 1
  fi
  if [ -d "$QA_HOME" ]; then
    ( cd "$QA_HOME" && rm -f daemon.pid daemon.start owner.pid owner.start ) \
      || { echo "rig: could not remove clean teardown records" >&2; return 2; }
  fi
  echo "rig: down clean — nothing bound to $QA_HOME"
}

rig_up() {
  require_project
  [ -z "$QA_HIVE_BIN" ] || [ -x "$QA_HIVE_BIN" ] \
    || refuse "QA_HIVE_BIN is not executable: $QA_HIVE_BIN"
  [ -x "$QA_SESSIOND_BIN" ] || refuse "no executable hive-sessiond at" \
    "$QA_SESSIOND_BIN — stage one there or set QA_SESSIOND_BIN explicitly"
  command -v bun >/dev/null || refuse "bun is required"
  mkdir -p "$QA_HOME" "$ARTIFACTS"

  local src_sha src_dirty
  src_sha="$(git -C "$QA_SRC_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  src_dirty="clean"
  [ -z "$(git -C "$QA_SRC_ROOT" status --porcelain 2>/dev/null)" ] || src_dirty="dirty"

  if [ ! -f "$QA_HOME/hive.db" ]; then
    echo "rig: hive init in $QA_PROJECT"
    ( cd "$QA_PROJECT" && hive_cli init ) \
      > "$QA_HOME/init.log" 2>&1 \
      || { tail -5 "$QA_HOME/init.log" >&2; refuse "hive init failed; see $QA_HOME/init.log"; }
  fi

  # Rotate logs: both post-start checks read these files, and a line left by
  # a PREVIOUS run (an old announcement, an old "owner registered") would
  # satisfy them for the wrong process.
  rm -f "$QA_HOME/daemon.port"
  [ ! -f "$QA_HOME/daemon.log" ] || mv "$QA_HOME/daemon.log" "$QA_HOME/daemon.log.prev"
  [ ! -f "$QA_HOME/owner.log" ] || mv "$QA_HOME/owner.log" "$QA_HOME/owner.log.prev"
  if [ -n "$QA_HIVE_BIN" ]; then
    start_detached "$QA_HOME/daemon.log" "$QA_PROJECT" \
      "$QA_HIVE_BIN" daemon > "$QA_HOME/daemon.pid"
  else
    start_detached "$QA_HOME/daemon.log" "$QA_PROJECT" \
      bun run "$QA_SRC_ROOT/src/cli.ts" daemon > "$QA_HOME/daemon.pid"
  fi
  local daemon_pid daemon_start
  daemon_pid="$(cat "$QA_HOME/daemon.pid")"
  daemon_start="$(process_start "$daemon_pid")"
  [ -n "$daemon_start" ] \
    || { rig_down || true; refuse "could not record daemon identity"; }
  printf '%s\n' "$daemon_start" > "$QA_HOME/daemon.start"

  if ! wait_for_file "$QA_HOME/daemon.port" 60; then
    echo "rig: daemon never bound a port; log tail:" >&2
    tail -20 "$QA_HOME/daemon.log" >&2
    rig_down || true
    exit 1
  fi
  local port; port="$(cat "$QA_HOME/daemon.port")"

  # Ownership must land before the daemon's no-owner deadline
  # (WORKSPACE_OWNER_REGISTRATION_TIMEOUT_MS); the holder also publishes the
  # empty visibility snapshot spawn admission requires.
  start_detached "$QA_HOME/owner.log" "$QA_PROJECT" \
    bun run "$QA_SRC_ROOT/$QA_TREE_SUBDIR/hold-owner.ts" > "$QA_HOME/owner.pid"
  local owner_pid owner_start
  owner_pid="$(cat "$QA_HOME/owner.pid")"
  owner_start="$(process_start "$owner_pid")"
  [ -n "$owner_start" ] \
    || { rig_down || true; refuse "could not record owner identity"; }
  printf '%s\n' "$owner_start" > "$QA_HOME/owner.start"
  local i=0
  while [ "$i" -lt 10 ]; do
    grep -q "owner registered" "$QA_HOME/owner.log" 2>/dev/null && break
    sleep 1; i=$((i + 1))
  done
  if ! grep -q "owner registered" "$QA_HOME/owner.log" 2>/dev/null; then
    echo "rig: workspace owner never registered; owner.log:" >&2
    tail -10 "$QA_HOME/owner.log" >&2
    rig_down || true
    exit 1
  fi

  # The version-under-test gate: the daemon must announce the hash of the
  # sources this rig was pointed at, or nothing it serves can be trusted.
  if ! bun run "$QA_SRC_ROOT/$QA_TREE_SUBDIR/verify-announcement.ts" \
      "$QA_HOME/daemon.log" "$QA_SRC_ROOT" "$daemon_pid" \
      | tee "$QA_HOME/announcement.txt"; then
    echo "rig: source-hash assert failed" >&2
    rig_down || true
    exit 1
  fi
  local announcement_line
  announcement_line="$(grep -m1 '^Hive daemon ready: ' "$QA_HOME/daemon.log")" \
    || { rig_down || true; refuse "startup announcement disappeared from daemon.log"; }

  if [ "${QA_SKIP_POLICY:-}" != "1" ]; then
    local revision
    revision="$(hive_cli routing export --port "$port" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])')" \
      || { rig_down || true; refuse "could not read routing policy for seeding"; }
    hive_cli routing set-route global user-weighted \
      "claude/claude-fable-5@none=1" --expect-revision "$revision" --port "$port" \
      >/dev/null \
      || { rig_down || true; refuse "routing seed failed (set QA_SKIP_POLICY=1 to run without spawns)"; }
  fi

  {
    echo "=== up $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "src=$QA_SRC_ROOT sha=$src_sha ($src_dirty)"
    echo "project=$QA_PROJECT sha=$(git -C "$QA_PROJECT" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "sessiond=$QA_SESSIOND_BIN bytes=$(stat -f %z "$QA_SESSIOND_BIN") mtime=$(stat -f %Sm "$QA_SESSIOND_BIN")"
    echo "port=$port daemon_pid=$daemon_pid owner_pid=$(cat "$QA_HOME/owner.pid")"
    echo "$announcement_line"
    cat "$QA_HOME/announcement.txt"
  } >> "$ARTIFACTS/rig-record.txt"

  # Rig-bound CLI shim for tour live mode and suite consumers.
  local hive_bin="$ARTIFACTS/hive-bin"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    if [ -n "$QA_HIVE_BIN" ]; then
      printf '%s\n' "exec $(printf '%q' "$QA_HIVE_BIN") \"\$@\""
    else
      printf '%s\n' "exec bun run $(printf '%q' "$QA_SRC_ROOT")/src/cli.ts \"\$@\""
    fi
  } > "$hive_bin"
  chmod +x "$hive_bin" \
    || { rig_down || true; refuse "could not publish executable hive-bin at $hive_bin"; }

  {
    echo "requested_home=$QA_HOME_REQUESTED"
    echo "home=$QA_HOME"
    echo "default_home=$QA_DEFAULT_HOME"
    echo "port=$port"
    echo "project=$QA_PROJECT"
    echo "source=$QA_SRC_ROOT"
    echo "hive_bin=$hive_bin"
  } > "$ARTIFACTS/coordinates.txt"

  echo "rig: up — home=$QA_HOME port=$port daemon_pid=$daemon_pid project=$QA_PROJECT"
  echo "rig: source $src_sha ($src_dirty); record in $ARTIFACTS/rig-record.txt"
  echo "rig: published coordinates in $ARTIFACTS/coordinates.txt"
  echo "rig: published hive-bin=$hive_bin"
}

run_cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  rig_down || { [ "$status" -ne 0 ] || status=1; }
  exit "$status"
}

RUN_CHILD_IDENTITY=""
forward_run_signal() {
  local signal="$1" status="$2"
  trap - HUP INT TERM
  if [ -n "$RUN_CHILD_IDENTITY" ]; then
    collect_owned_identities "$RUN_CHILD_IDENTITY"
    terminate_identities "$signal" "$OWNED_IDENTITIES"
  fi
  exit "$status"
}

case "$mode" in
  up)
    trap 'rig_down || true; exit 129' HUP
    trap 'rig_down || true; exit 130' INT
    trap 'rig_down || true; exit 143' TERM
    rig_up
    trap - HUP INT TERM
    ;;
  run)
    [ "$#" -ge 1 ] || { echo "usage: qa/rig.sh run <cmd...>" >&2; exit 2; }
    trap run_cleanup EXIT
    trap 'forward_run_signal HUP 129' HUP
    trap 'forward_run_signal INT 130' INT
    trap 'forward_run_signal TERM 143' TERM
    rig_up
    HIVE_QA_HOME="$QA_HOME" HIVE_QA_PORT="$(cat "$QA_HOME/daemon.port")" \
      HIVE_QA_PROJECT="$QA_PROJECT" HIVE_QA_SRC_ROOT="$QA_SRC_ROOT" \
      HIVE_QA_BIN="$QA_HIVE_BIN" \
      HIVE_HOME="$QA_HOME" HIVE_PORT=0 HIVE_DISABLE_UPDATES=1 \
      HIVE_DEFAULT_HOME="$QA_DEFAULT_HOME" \
      HIVE_SESSIOND_BIN="$QA_SESSIOND_BIN" "$@" <&0 &
    run_pid=$!
    RUN_CHILD_IDENTITY="$(identity_for_pid "$run_pid")" || RUN_CHILD_IDENTITY=""
    wait "$run_pid"
    run_status=$?
    RUN_CHILD_IDENTITY=""
    exit "$run_status"
    ;;
  down)
    rig_down
    ;;
  *)
    echo "usage: qa/rig.sh up|run <cmd...>|down" >&2
    exit 2
    ;;
esac
