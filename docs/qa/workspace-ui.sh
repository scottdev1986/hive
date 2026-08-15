#!/usr/bin/env bash
# qa/workspace-ui.sh — headless proof legs for the new Workspace shell.
#
#   qa/workspace-ui.sh run <artifacts> <home> <port> <hive-bin>
#   qa/workspace-ui.sh probe forged-proof|corpus-gap|sandbox-blind
#
# `run` drives the QA-only executable HiveWorkspaceQA under HIVE_SHELL_PROOF=1,
# which builds the shell, prints one measured SHELL-PROOF line and exits without
# showing a window. Every claim below is read off that line, never off an exit
# code: the binary exits 0 whether or not the screens it built are honest.
#
# It emits one `ROW|<id>|<verdict>|<evidence>...` line per matrix row on stdout.
# The caller turns those into report rows; this script owns no JSON, so the
# suite keeps exactly one row emitter.
#
# `probe` proves the assertions can fail. Each probe corrupts one input and
# requires `run`'s checker to go red for that reason; a probe that leaves the
# checker green is itself a failure, because a check nobody can fail reports
# nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# This script lives at <checkout>/docs/qa, so the checkout is two levels up.
SRC_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
PRIMARY_CHECKOUT="/Users/scottkellar/Projects/hive"

# The Swift sources under test are this checkout's, so a leg run on a branch
# measures the branch. GhosttyKit.xcframework is a build output that is never in
# a worktree; only that prebuilt binary is borrowed, from WORKSPACE_ROOT.
WS_ROOT="${WSUI_WORKSPACE:-$SRC_ROOT/workspace}"
VENDOR_SOURCE="${WORKSPACE_ROOT:-$PRIMARY_CHECKOUT/workspace}"
FIXTURE_CORPUS="${FIXTURE_CORPUS:-$WS_ROOT/Tests/WorkspaceCoreTests/Fixtures}"

# Every availability row the fixture store can serve, and the ten shell routes.
SCENARIOS=(current unknown stale disconnected unauthorized conflicting replaced)
ROUTES=(run router models tokens queen autonomy memory-overview memory-library
  memory-recall memory-maintenance)
# Screens with no frozen daemon wire in this build. They render an absent row
# from shell-absent-screens-corpus.json and must never report a healthy state.
UNWIRED=(tokens autonomy)

die() { echo "workspace-ui: $*" >&2; exit 1; }
log() { echo "workspace-ui: $*" >&2; }

usage() {
  echo "usage: qa/workspace-ui.sh run <artifacts> <home> <port> <hive-bin>" >&2
  echo "       qa/workspace-ui.sh probe forged-proof|corpus-gap|sandbox-blind" >&2
  exit 2
}

# --- building the binary under test ---------------------------------------

build_qa_binary() {
  local artifacts="$1"
  [ -d "$WS_ROOT" ] || die "no workspace source at $WS_ROOT"
  if [ ! -d "$WS_ROOT/Vendor/GhosttyKit.xcframework" ]; then
    [ -d "$VENDOR_SOURCE/Vendor/GhosttyKit.xcframework" ] \
      || die "GhosttyKit.xcframework is absent from both $WS_ROOT and $VENDOR_SOURCE"
    log "staging GhosttyKit from $VENDOR_SOURCE"
    mkdir -p "$WS_ROOT/Vendor"
    /usr/bin/ditto "$VENDOR_SOURCE/Vendor/GhosttyKit.xcframework" \
      "$WS_ROOT/Vendor/GhosttyKit.xcframework" \
      || die "could not stage GhosttyKit into $WS_ROOT/Vendor"
  fi
  ( cd "$WS_ROOT" && swift build --product HiveWorkspaceQA ) \
    >"$artifacts/build.log" 2>&1 \
    || die "swift build --product HiveWorkspaceQA failed: $(tail -5 "$artifacts/build.log")"
  BINARY="$WS_ROOT/.build/debug/HiveWorkspaceQA"
  [ -x "$BINARY" ] || die "no HiveWorkspaceQA at $BINARY after a successful build"
}

# --- collecting measured proof lines ---------------------------------------

# proof_run <proofs-dir> <label> <scenario> <profile-or-empty> <launch-args...>
# Records the process's own stdout and exit code. A refused launch prints
# SHELL-PROOF FAIL and exits 1; both are kept so the checker sees the refusal
# rather than an empty file it could mistake for a clean run.
proof_run() {
  local proofs="$1" label="$2" scenario="$3" profile="$4"
  shift 4
  local code=0
  if [ -n "$profile" ]; then
    env -u HIVE_SHELL_PROOF_MUTATE HIVE_HOME="$proofs/$label-home" \
      HIVE_SHELL_PROOF=1 HIVE_SHELL_SCENARIO="$scenario" \
      /usr/bin/sandbox-exec -f "$profile" "$BINARY" "$@" \
      >"$proofs/$label.line" 2>"$proofs/$label.err" || code=$?
  else
    env -u HIVE_SHELL_PROOF_MUTATE HIVE_HOME="$proofs/$label-home" \
      HIVE_SHELL_PROOF=1 HIVE_SHELL_SCENARIO="$scenario" \
      "$BINARY" "$@" \
      >"$proofs/$label.line" 2>"$proofs/$label.err" || code=$?
  fi
  printf '%s\n' "$code" >"$proofs/$label.exit"
}

# A control that proves a sandbox profile actually blocks the access the leg
# claims it blocks. Without it, "the app touched nothing" and "the profile is
# inert" produce the same silence.
control_connect() {
  local out="$1" port="$2" profile="$3"
  local script="
import socket
s = socket.socket()
s.settimeout(2)
try:
    s.connect(('127.0.0.1', $port))
    print('CONNECTED')
except PermissionError:
    print('DENIED')
except Exception as exc:
    print('OTHER', type(exc).__name__)
"
  if [ -n "$profile" ]; then
    /usr/bin/sandbox-exec -f "$profile" python3 -c "$script" >"$out" 2>&1 || true
  else
    python3 -c "$script" >"$out" 2>&1 || true
  fi
}

control_read() {
  local out="$1" path="$2" profile="$3"
  local script="
try:
    with open('$path', 'rb') as fh:
        fh.read(1)
    print('READ')
except PermissionError:
    print('DENIED')
except Exception as exc:
    print('OTHER', type(exc).__name__)
"
  if [ -n "$profile" ]; then
    /usr/bin/sandbox-exec -f "$profile" python3 -c "$script" >"$out" 2>&1 || true
  else
    python3 -c "$script" >"$out" 2>&1 || true
  fi
}

collect() {
  local proofs="$1" home="$2" port="$3" hive_bin="$4"
  mkdir -p "$proofs"

  local scenario
  for scenario in "${SCENARIOS[@]}"; do
    proof_run "$proofs" "fixture-$scenario" "$scenario" "" \
      --workspace-shell "$FIXTURE_CORPUS"
  done

  printf '(version 1)\n(allow default)\n(deny network*)\n' >"$proofs/no-net.sb"
  printf '(version 1)\n(allow default)\n(deny file-read* (subpath "%s"))\n(deny file-write* (subpath "%s"))\n' \
    "$home" "$home" >"$proofs/no-home.sb"
  # The blind profile denies nothing. It is the negative control for the two
  # above: the same access must succeed under it, or the DENIED readings prove
  # nothing about the profiles.
  printf '(version 1)\n(allow default)\n' >"$proofs/blind.sb"

  proof_run "$proofs" "fixture-nonet" current "$proofs/${WSUI_NET_PROFILE:-no-net.sb}" \
    --workspace-shell "$FIXTURE_CORPUS"
  proof_run "$proofs" "fixture-nohome" current "$proofs/no-home.sb" \
    --workspace-shell "$FIXTURE_CORPUS"

  control_connect "$proofs/control-net-open.txt" "$port" ""
  control_connect "$proofs/control-net-denied.txt" "$port" \
    "$proofs/${WSUI_NET_PROFILE:-no-net.sb}"
  control_read "$proofs/control-home-open.txt" "$home/daemon.port" ""
  control_read "$proofs/control-home-denied.txt" "$home/daemon.port" \
    "$proofs/no-home.sb"

  # The live pair is the loud fixture for the network claim: the same launch
  # that reads the daemon over loopback must visibly lose those reads when the
  # profile is on. Without this pair, "fixture mode used no network" is
  # indistinguishable from "this binary never uses the network at all".
  local live_args=(--workspace-shell-live --port "$port" --instance-home "$home"
    --hive "$hive_bin")
  proof_run "$proofs" "live-open" current "" "${live_args[@]}"
  proof_run "$proofs" "live-nonet" current \
    "$proofs/${WSUI_NET_PROFILE:-no-net.sb}" "${live_args[@]}"
}

# --- asserting on what was measured ----------------------------------------

assert_rows() {
  local proofs="$1"
  python3 - "$proofs" "${SCENARIOS[*]}" "${ROUTES[*]}" "${UNWIRED[*]}" <<'PY'
import sys
from pathlib import Path

proofs = Path(sys.argv[1])
scenarios = sys.argv[2].split()
routes = sys.argv[3].split()
unwired = set(sys.argv[4].split())
wired = [r for r in routes if r not in unwired]

def read(label):
    """The measured line, its exit code, and the availability map it carries.

    A measurement that was never taken reads as a refusal, never as silence:
    an absent file returns exit 127 and an empty map, so every row that
    depends on it goes red instead of passing on nothing.
    """
    line_path = proofs / f"{label}.line"
    if not line_path.exists():
        return "", 127, {}, {}
    line = line_path.read_text(encoding="utf-8").strip()
    code_path = proofs / f"{label}.exit"
    code = int(code_path.read_text().strip()) if code_path.exists() else 127
    fields = {}
    for token in line.split():
        if "=" in token:
            key, value = token.split("=", 1)
            fields[key] = value
    avail = {
        key[len("availability-"):]: value
        for key, value in fields.items()
        if key.startswith("availability-")
    }
    return line, code, fields, avail

def control(name):
    path = proofs / f"control-{name}.txt"
    return path.read_text(encoding="utf-8").strip() if path.exists() else "ABSENT"

rows = []
def row(rid, ok, *evidence):
    rows.append((rid, "working" if ok else "broken", [str(e) for e in evidence]))

# WSUI-01 — every registered screen renders from the frozen corpus, in every
# availability row the corpus can serve.
faults, ok01 = [], True
for scenario in scenarios:
    line, code, fields, avail = read(f"fixture-{scenario}")
    if code != 0 or not line.startswith("SHELL-PROOF "):
        faults.append(f"{scenario}:exit={code}")
        ok01 = False
        continue
    if fields.get("routes") != str(len(routes)):
        faults.append(f"{scenario}:routes={fields.get('routes')}")
        ok01 = False
    missing = [r for r in routes if r not in avail]
    if missing:
        faults.append(f"{scenario}:absent-field={','.join(missing)}")
        ok01 = False
    unreported = [r for r, v in avail.items() if v == "missing"]
    if unreported:
        faults.append(f"{scenario}:missing-screen={','.join(unreported)}")
        ok01 = False
    extra = [r for r in avail if r not in routes]
    if extra:
        faults.append(f"{scenario}:unknown-route={','.join(extra)}")
        ok01 = False
row("WSUI-01", ok01, f"scenarios={len(scenarios)}", f"routes={len(routes)}",
    "proofs/fixture-<scenario>.line",
    *(faults[:6] or ["every route reported a state in every row"]))

# WSUI-02 — a screen with no frozen contract never claims health. The claim is
# an absence, so it is read off the two screens that are known to be unwired:
# if the corpus ever wires them, `wired` moves off 8 and this row goes red
# rather than passing vacuously.
faults, ok02 = [], True
for scenario in scenarios:
    _, code, fields, avail = read(f"fixture-{scenario}")
    if code != 0:
        faults.append(f"{scenario}:exit={code}")
        ok02 = False
        continue
    if fields.get("wired") != str(len(wired)):
        faults.append(f"{scenario}:wired={fields.get('wired')}")
        ok02 = False
    for route in sorted(unwired):
        if avail.get(route) != "unknown":
            faults.append(f"{scenario}:{route}={avail.get(route)}")
            ok02 = False
row("WSUI-02", ok02, f"unwired={','.join(sorted(unwired))}",
    f"wired={len(wired)}", "proofs/fixture-<scenario>.line",
    *(faults[:6] or ["no unwired screen claimed a state in any row"]))

# WSUI-03 — a fault holds on every wired screen and none of them renders as
# healthy while it holds.
faults, ok03 = [], True
for scenario in scenarios:
    if scenario == "current":
        continue
    _, code, _, avail = read(f"fixture-{scenario}")
    if code != 0:
        faults.append(f"{scenario}:exit={code}")
        ok03 = False
        continue
    for route in wired:
        seen = avail.get(route)
        if seen != scenario:
            faults.append(f"{scenario}:{route}={seen}")
            ok03 = False
row("WSUI-03", ok03, f"faults={len(scenarios) - 1}", f"screens={len(wired)}",
    "proofs/fixture-<scenario>.line",
    *(faults[:6] or ["every wired screen held every injected fault"]))

# WSUI-04 — the fixture view layer reaches no network. Three readings, because
# the interesting one is an absence: the render is unchanged with the network
# denied, the profile provably blocks a real connection, and the live launch
# that does use the network visibly loses it under the same profile.
faults, ok04 = [], True
_, base_code, _, base_avail = read("fixture-current")
_, net_code, net_fields, net_avail = read("fixture-nonet")
if net_code != 0:
    faults.append(f"denied-network-exit={net_code}")
    ok04 = False
if net_avail != base_avail or base_code != 0:
    faults.append("render-changed-without-network")
    ok04 = False
if net_fields.get("wired") != str(len(wired)):
    faults.append(f"denied-network-wired={net_fields.get('wired')}")
    ok04 = False
open_read, denied_read = control("net-open"), control("net-denied")
if denied_read != "DENIED":
    faults.append(f"profile-does-not-block:{denied_read}")
    ok04 = False
if open_read == "DENIED":
    faults.append("unsandboxed-connect-also-denied")
    ok04 = False
_, live_code, _, live_avail = read("live-open")
_, blocked_code, _, blocked_avail = read("live-nonet")
live_current = sorted(r for r, v in live_avail.items() if v == "current")
blocked_current = sorted(r for r, v in blocked_avail.items() if v == "current")
if live_code != 0 or not live_current:
    faults.append(f"live-control-served-nothing:exit={live_code}")
    ok04 = False
if blocked_current:
    faults.append(f"live-current-without-network={','.join(blocked_current)}")
    ok04 = False
row("WSUI-04", ok04, f"unsandboxed-connect={open_read}",
    f"sandboxed-connect={denied_read}",
    f"live-current={len(live_current)}",
    f"live-current-denied={len(blocked_current)}",
    "proofs/fixture-nonet.line", "proofs/live-nonet.line",
    *(faults[:4] or ["the fixture shell rendered identically with no network"]))

# WSUI-05 — the fixture view layer reads and writes nothing inside the Hive
# instance home, so no screen is backed by daemon state on disk.
faults, ok05 = [], True
_, home_code, home_fields, home_avail = read("fixture-nohome")
if home_code != 0:
    faults.append(f"denied-home-exit={home_code}")
    ok05 = False
if home_avail != base_avail or base_code != 0:
    faults.append("render-changed-without-home")
    ok05 = False
if home_fields.get("wired") != str(len(wired)):
    faults.append(f"denied-home-wired={home_fields.get('wired')}")
    ok05 = False
open_home, denied_home = control("home-open"), control("home-denied")
if denied_home != "DENIED":
    faults.append(f"home-profile-does-not-block:{denied_home}")
    ok05 = False
if open_home != "READ":
    faults.append(f"home-control-unreadable:{open_home}")
    ok05 = False
row("WSUI-05", ok05, f"unsandboxed-read={open_home}",
    f"sandboxed-read={denied_home}", "proofs/fixture-nohome.line",
    *(faults[:4] or ["the fixture shell rendered identically with the home denied"]))

broken = 0
for rid, verdict, evidence in rows:
    if verdict == "broken":
        broken += 1
    print("|".join(["ROW", rid, verdict, *evidence]))
sys.exit(1 if broken else 0)
PY
}

run_leg() {
  local artifacts="$1" home="$2" port="$3" hive_bin="$4"
  [ -n "$artifacts" ] && [ -n "$home" ] && [ -n "$port" ] && [ -n "$hive_bin" ] || usage
  [ -d "$home" ] || die "rig home $home does not exist"
  [ -x "$hive_bin" ] || die "no hive binary at $hive_bin"
  [ -d "$FIXTURE_CORPUS" ] || die "no fixture corpus at $FIXTURE_CORPUS"
  mkdir -p "$artifacts"
  build_qa_binary "$artifacts"
  log "measuring shell proofs corpus=$FIXTURE_CORPUS binary=$BINARY"
  collect "$artifacts/proofs" "$home" "$port" "$hive_bin"
  assert_rows "$artifacts/proofs"
}

# --- probes: each one must drive `run`'s checker red -----------------------

# A probe asserts on the checker, not on the product: it replaces one measured
# input with a known-bad one and requires the named row to turn broken.
require_broken() {
  local rows="$1" rid="$2" what="$3"
  # A checker that crashed emits no rows at all, which must never be read as
  # "the row stayed green" — the two failures need different repairs.
  grep -q "^ROW|" "$rows" \
    || die "$what: the checker emitted no rows, so nothing was proven ($rows)"
  grep -q "^ROW|$rid|broken|" "$rows" \
    || die "$what: $rid stayed green on a corrupted input ($rows)"
  echo "PROBE BITES: $what -> $rid broken"
}

probe_forged_proof() {
  local work
  work="$(mktemp -d -t wsui-forged)"
  local proofs="$work/proofs"
  mkdir -p "$proofs"
  # A shell that ignores the injected fault and renders every screen healthy —
  # the exact defect WSUI-02 and WSUI-03 exist to catch. It exits 0, so a leg
  # that trusted the exit code would call this a pass.
  local scenario
  for scenario in "${SCENARIOS[@]}"; do
    {
      printf 'SHELL-PROOF routes=10 wired=10 scenario=%s active=run nav=10' "$scenario"
      printf ' drawer=hidden banner=none'
      local route
      for route in "${ROUTES[@]}"; do
        printf ' availability-%s=current' "$route"
      done
      printf '\n'
    } >"$proofs/fixture-$scenario.line"
    printf '0\n' >"$proofs/fixture-$scenario.exit"
  done
  cp "$proofs/fixture-current.line" "$proofs/fixture-nonet.line"
  cp "$proofs/fixture-current.exit" "$proofs/fixture-nonet.exit"
  cp "$proofs/fixture-current.line" "$proofs/fixture-nohome.line"
  cp "$proofs/fixture-current.exit" "$proofs/fixture-nohome.exit"
  cp "$proofs/fixture-current.line" "$proofs/live-open.line"
  cp "$proofs/fixture-current.exit" "$proofs/live-open.exit"
  cp "$proofs/fixture-current.line" "$proofs/live-nonet.line"
  cp "$proofs/fixture-current.exit" "$proofs/live-nonet.exit"
  printf 'CONNECTED\n' >"$proofs/control-net-open.txt"
  printf 'DENIED\n' >"$proofs/control-net-denied.txt"
  printf 'READ\n' >"$proofs/control-home-open.txt"
  printf 'DENIED\n' >"$proofs/control-home-denied.txt"
  local rows="$work/rows.txt"
  assert_rows "$proofs" >"$rows" 2>&1 || true
  require_broken "$rows" WSUI-02 "forged-proof"
  require_broken "$rows" WSUI-03 "forged-proof"
  require_broken "$rows" WSUI-04 "forged-proof"
  # The routes are all present and all named, so the inventory row is the
  # control that the corruption was targeted rather than total.
  grep -q '^ROW|WSUI-01|working|' "$rows" \
    || die "forged-proof: WSUI-01 must stay green, or the probe proves nothing"
  echo "PROBE OK: forged-proof (WSUI-01 unaffected)"
  rm -rf "$work"
}

probe_corpus_gap() {
  local work
  work="$(mktemp -d -t wsui-corpus)"
  local corpus="$work/corpus"
  cp -R "$FIXTURE_CORPUS" "$corpus"
  # Drop the absent-screen row for one unwired screen. The store must refuse
  # the whole corpus rather than serve nine routes and let a screen vanish.
  python3 - "$corpus/shell-absent-screens-corpus.json" <<'PY'
import json, sys
path = sys.argv[1]
rows = json.loads(open(path, encoding="utf-8").read())
kept = [r for r in rows if r["value"]["route"] != "autonomy"]
if len(kept) == len(rows):
    raise SystemExit("corpus has no autonomy absent row to remove")
open(path, "w", encoding="utf-8").write(json.dumps(kept, indent=2))
PY
  build_qa_binary "$work"
  local proofs="$work/proofs"
  mkdir -p "$proofs"
  local scenario
  for scenario in "${SCENARIOS[@]}"; do
    proof_run "$proofs" "fixture-$scenario" "$scenario" "" --workspace-shell "$corpus"
  done
  grep -q '^SHELL-PROOF FAIL' "$proofs/fixture-current.line" \
    || die "corpus-gap: the shell accepted a corpus missing an absent-screen row"
  [ "$(cat "$proofs/fixture-current.exit")" != 0 ] \
    || die "corpus-gap: the shell exited 0 on a corpus it should refuse"
  printf 'CONNECTED\n' >"$proofs/control-net-open.txt"
  printf 'DENIED\n' >"$proofs/control-net-denied.txt"
  printf 'READ\n' >"$proofs/control-home-open.txt"
  printf 'DENIED\n' >"$proofs/control-home-denied.txt"
  local rows="$work/rows.txt"
  assert_rows "$proofs" >"$rows" 2>&1 || true
  require_broken "$rows" WSUI-01 "corpus-gap"
  rm -rf "$work"
}

probe_sandbox_blind() {
  local artifacts="$1" home="$2" port="$3" hive_bin="$4"
  [ -n "$artifacts" ] && [ -n "$home" ] && [ -n "$port" ] && [ -n "$hive_bin" ] || usage
  mkdir -p "$artifacts"
  build_qa_binary "$artifacts"
  # Swap the network profile for one that denies nothing. Every reading stays
  # identical except the control, which now connects — and the leg must red,
  # because a profile that blocks nothing cannot witness an absence.
  WSUI_NET_PROFILE=blind.sb collect "$artifacts/proofs" "$home" "$port" "$hive_bin"
  local rows="$artifacts/rows.txt"
  assert_rows "$artifacts/proofs" >"$rows" 2>&1 || true
  grep -q '^ROW|WSUI-04|broken|.*profile-does-not-block' "$rows" \
    || die "sandbox-blind: WSUI-04 passed with an inert profile ($rows)"
  echo "PROBE BITES: sandbox-blind -> WSUI-04 broken on an inert profile"
}

mode="${1:-}"
[ -n "$mode" ] || usage
shift || true

case "$mode" in
  run) run_leg "${1:-}" "${2:-}" "${3:-}" "${4:-}" ;;
  probe)
    case "${1:-}" in
      forged-proof) probe_forged_proof ;;
      corpus-gap) probe_corpus_gap ;;
      sandbox-blind) shift; probe_sandbox_blind "${1:-}" "${2:-}" "${3:-}" "${4:-}" ;;
      *) usage ;;
    esac
    ;;
  *) usage ;;
esac
