#!/usr/bin/env bash
# qa/workspace-ui.sh — headless proof legs for the new Workspace shell.
#
#   qa/workspace-ui.sh run <artifacts> <home> <port> <hive-bin>
#   qa/workspace-ui.sh probe forged-proof|corpus-retired-row|sandbox-blind
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SCRIPT_DIR/repo-root.sh"
SRC_ROOT="$(qa_repo_root "$SCRIPT_DIR")" || exit 2
PRIMARY_CHECKOUT="/Users/scottkellar/Projects/hive"

# The Swift sources under test are this checkout's, so a leg run on a branch
# measures the branch. GhosttyKit.xcframework is a build output that is never in
# a worktree; only that prebuilt binary is borrowed, from WORKSPACE_ROOT.
WS_ROOT="${WSUI_WORKSPACE:-$SRC_ROOT/workspace}"
VENDOR_SOURCE="${WORKSPACE_ROOT:-$PRIMARY_CHECKOUT/workspace}"
FIXTURE_CORPUS="${FIXTURE_CORPUS:-$WS_ROOT/Tests/WorkspaceCoreTests/Fixtures}"

# Every availability row the fixture store can serve.
SCENARIOS=(current unknown stale disconnected unauthorized conflicting replaced)

# Route slugs used ONLY to synthesise forged proof lines in the probes. This is
# test input, never a contract: the legs read the route set out of the binary's
# own report, so no screen is named in an assertion and there is no per-screen
# exception list to keep in step with the shell.
FORGED_ROUTES=(run router models queen memory-overview memory-library
  memory-recall memory-maintenance)


die() { echo "workspace-ui: $*" >&2; exit 1; }
log() { echo "workspace-ui: $*" >&2; }

usage() {
  echo "usage: qa/workspace-ui.sh run <artifacts> <home> <port> <hive-bin>" >&2
  echo "       qa/workspace-ui.sh probe forged-healthy|forged-counters" >&2
  echo "       qa/workspace-ui.sh probe end-state-reachable|corpus-retired-row" >&2
  echo "       qa/workspace-ui.sh probe screen-registry" >&2
  echo "       qa/workspace-ui.sh probe sandbox-blind <artifacts> <home> <port> <hive-bin>" >&2
  exit 2
}

# --- building the binary under test ---------------------------------------

# Sets BINARY on success. On refusal it sets BUILD_REFUSAL to one line naming
# the remedy and returns 1; the leg turns that into broken rows rather than a
# skip, because a leg that quietly did not run reads exactly like a green one.
#
# It stages nothing. GhosttyKit.xcframework is a gitignored build output that
# no fresh worktree carries, and staging it is the build's job, not QA's — a
# suite that silently repaired its own inputs could never report that a clean
# checkout cannot build.
build_qa_binary() {
  local artifacts="$1"
  BUILD_REFUSAL=""
  if [ ! -d "$WS_ROOT" ]; then
    BUILD_REFUSAL="no-workspace-source-at:$WS_ROOT"
    return 1
  fi
  if [ ! -d "$WS_ROOT/Vendor/GhosttyKit.xcframework" ]; then
    BUILD_REFUSAL="GhosttyKit not staged; run: mkdir -p $WS_ROOT/Vendor && ln -s $VENDOR_SOURCE/Vendor/GhosttyKit.xcframework $WS_ROOT/Vendor/GhosttyKit.xcframework"
    return 1
  fi
  # Build inside this checkout's own .build: concurrent SwiftPM runs sharing
  # one build directory block on each other's lock.
  if ! ( cd "$WS_ROOT" && swift build --product HiveWorkspaceQA ) \
    >"$artifacts/build.log" 2>&1; then
    BUILD_REFUSAL="swift build --product HiveWorkspaceQA failed: $(tail -3 "$artifacts/build.log" | tr '\n|' '  ')"
    return 1
  fi
  BINARY="$WS_ROOT/.build/debug/HiveWorkspaceQA"
  if [ ! -x "$BINARY" ]; then
    BUILD_REFUSAL="no HiveWorkspaceQA at $BINARY after a successful build"
    return 1
  fi
  return 0
}

# Every row this leg owns, so a refusal before any measurement still reports
# each of them as broken with the same reason.
emit_refusal_rows() {
  local reason="$1" rid
  for rid in WSUI-01 WSUI-02 WSUI-03 WSUI-04 WSUI-05 WSUI-06; do
    printf 'ROW|%s|broken|%s\n' "$rid" "$reason"
  done
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
  python3 - "$proofs" "${SCENARIOS[*]}" <<'PY'
import sys
from pathlib import Path

proofs = Path(sys.argv[1])
scenarios = sys.argv[2].split()

def read(label):
    """The measured line, its exit code, and the availability map it carries.

    A measurement that was never taken reads as a refusal, never as silence:
    an absent file returns exit 127 and an empty map, so every row that
    depends on it goes red instead of passing on nothing.
    """
    line_path = proofs / f"{label}.line"
    if not line_path.exists():
        return "", 127, {}, {}
    # The run now prints one SHELL-SCREEN line per declared screen before its
    # summary, so the summary is selected by name rather than by being the only
    # line in the file. A refusal prints SHELL-PROOF FAIL and is matched too.
    text = line_path.read_text(encoding="utf-8")
    line = next(
        (candidate.strip() for candidate in text.splitlines()
         if candidate.startswith("SHELL-PROOF ")),
        text.strip().splitlines()[0].strip() if text.strip() else "")
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

def read_declarations(label):
    """The screens this build declares, and the count it claims to have printed.

    Returns (slugs, claimed). `claimed` is None when the run printed no
    terminator, which is how a truncated run and a build with no registry are
    both kept distinguishable from a genuinely short list.
    """
    path = proofs / f"{label}.line"
    if not path.exists():
        return [], None
    slugs, claimed = [], None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("SHELL-SCREEN "):
            slugs.append(line[len("SHELL-SCREEN "):].split("|", 1)[0])
        elif line.startswith("SHELL-PROOF-END screens="):
            tail = line[len("SHELL-PROOF-END screens="):].strip()
            claimed = int(tail) if tail.isdigit() else None
    return slugs, claimed

rows = []
def row(rid, ok, *evidence):
    rows.append((rid, "working" if ok else "broken", [str(e) for e in evidence]))

# WSUI-01 — the inventory is complete and describes itself. No screen is named
# here: the route set is read out of the binary's own report, so this cannot go
# stale when a screen is added or omitted, and it cannot pass on an empty world
# — an empty or shrinking set is a disagreement, not a silence.
faults, ok01, seen_sets = [], True, {}
for scenario in scenarios:
    line, code, fields, avail = read(f"fixture-{scenario}")
    if code != 0 or not line.startswith("SHELL-PROOF routes="):
        faults.append(f"{scenario}:exit={code}")
        ok01 = False
        continue
    if not avail:
        faults.append(f"{scenario}:no-route-reported")
        ok01 = False
        continue
    if fields.get("routes") != str(len(avail)):
        faults.append(
            f"{scenario}:routes={fields.get('routes')}-but-{len(avail)}-reported")
        ok01 = False
    unreported = sorted(r for r, v in avail.items() if v == "missing")
    if unreported:
        faults.append(f"{scenario}:missing-screen={','.join(unreported)}")
        ok01 = False
    seen_sets[scenario] = frozenset(avail)
distinct = set(seen_sets.values())
if len(distinct) > 1:
    faults.append(f"route-set-varies-by-scenario:{len(distinct)}-sets")
    ok01 = False
inventory = sorted(next(iter(distinct))) if len(distinct) == 1 else []
row("WSUI-01", ok01, f"scenarios={len(scenarios)}", f"routes={len(inventory)}",
    "proofs/fixture-<scenario>.line",
    *(faults[:6] or ["every route reported a state in every row"]))

# WSUI-02 — nothing is exposed without an honest contract, and everything
# exposed is reachable: the three counters the shell derives independently —
# routes it registers, screens whose wire is frozen, and rows it puts in the
# sidebar — must be the same number. A screen with no contract raises `routes`
# above `wired`; a screen dropped from the sidebar drops `nav` below `routes`.
# Neither can be excused per screen, which is the point: an exception list is
# how the omission rule grew two implementations in the first place.
#
# `wired` alone is an overstating counter — it counts any screen whose generic
# contract is frozen, so a hollow panel raises it. Requiring agreement with two
# counters it does not control is what makes it safe to read here.
faults, ok02 = [], True
for scenario in scenarios:
    _, code, fields, _ = read(f"fixture-{scenario}")
    if code != 0:
        faults.append(f"{scenario}:exit={code}")
        ok02 = False
        continue
    counters = {name: fields.get(name) for name in ("routes", "wired", "nav")}
    if None in counters.values() or len(set(counters.values())) != 1:
        faults.append(
            f"{scenario}:routes={counters['routes']}"
            f"-wired={counters['wired']}-nav={counters['nav']}")
        ok02 = False
row("WSUI-02", ok02, "routes==wired==nav", "proofs/fixture-<scenario>.line",
    *(faults[:6] or ["the three counters agreed in every row"]))

# WSUI-03 — a fault holds on every screen the shell exposes, and none of them
# renders as healthy while it holds. Every route the binary reported is checked,
# so a screen that ignores the injected state cannot be excused by naming it.
faults, ok03 = [], True
for scenario in scenarios:
    if scenario == "current":
        continue
    _, code, _, avail = read(f"fixture-{scenario}")
    if code != 0 or not avail:
        faults.append(f"{scenario}:exit={code}")
        ok03 = False
        continue
    for route in sorted(avail):
        if avail[route] != scenario:
            faults.append(f"{scenario}:{route}={avail[route]}")
            ok03 = False
row("WSUI-03", ok03, f"faults={len(scenarios) - 1}", f"screens={len(inventory)}",
    "proofs/fixture-<scenario>.line",
    *(faults[:6] or ["every screen held every injected fault"]))

# WSUI-04 — the fixture view layer reaches no network. Three readings, because
# the interesting one is an absence: the render is unchanged with the network
# denied, the profile provably blocks a real connection, and the live launch
# that does use the network visibly loses it under the same profile.
faults, ok04 = [], True
_, base_code, base_fields, base_avail = read("fixture-current")
_, net_code, net_fields, net_avail = read("fixture-nonet")
if net_code != 0:
    faults.append(f"denied-network-exit={net_code}")
    ok04 = False
if net_avail != base_avail or base_code != 0 or not base_avail:
    faults.append("render-changed-without-network")
    ok04 = False
if net_fields.get("wired") != base_fields.get("wired"):
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
if home_avail != base_avail or base_code != 0 or not base_avail:
    faults.append("render-changed-without-home")
    ok05 = False
if home_fields.get("wired") != base_fields.get("wired"):
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

# WSUI-06 — the shell's route inventory is exactly the availability registry's
# declared list. One assertion catches both directions: a screen the cutover
# omitted that reappears, and a declared screen the shell quietly stopped
# building. It names no screen, so it needs no maintenance when the declared set
# changes, and it covers omissions this leg was never told about.
#
# Read off the running binary rather than the route enum on purpose: a screen
# deleted from the enum but still built into the window passes a source-level
# check and fails here.
faults, ok06 = [], True
declared, claimed = read_declarations("fixture-current")
if claimed is None:
    # No terminator: either a truncated run or a build with no registry. Both
    # are failures to measure, never an empty list standing in for an answer.
    faults.append("no-declaration-terminator")
    ok06 = False
elif claimed != len(declared):
    faults.append(f"declared-count={claimed}-but-{len(declared)}-lines-read")
    ok06 = False
elif not declared:
    faults.append("shell-declares-no-screens")
    ok06 = False
elif not inventory:
    faults.append("no-inventory-to-compare")
    ok06 = False
else:
    undeclared = sorted(set(inventory) - set(declared))
    unbuilt = sorted(set(declared) - set(inventory))
    if undeclared:
        faults.append(f"built-but-not-declared={','.join(undeclared)}")
        ok06 = False
    if unbuilt:
        faults.append(f"declared-but-not-built={','.join(unbuilt)}")
        ok06 = False
row("WSUI-06", ok06, f"declared={len(declared)}", f"inventory={len(inventory)}",
    "proofs/fixture-current.line",
    *(faults[:4] or ["the inventory is exactly the declared list"]))

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
  mkdir -p "$artifacts"
  local refusal=""
  [ -d "$home" ] || refusal="rig home does not exist:$home"
  [ -n "$refusal" ] || [ -x "$hive_bin" ] || refusal="no hive binary at:$hive_bin"
  [ -n "$refusal" ] || [ -d "$FIXTURE_CORPUS" ] || refusal="no fixture corpus at:$FIXTURE_CORPUS"
  if [ -z "$refusal" ] && ! build_qa_binary "$artifacts"; then
    refusal="$BUILD_REFUSAL"
  fi
  if [ -n "$refusal" ]; then
    log "refusing to measure: $refusal"
    emit_refusal_rows "$refusal"
    return 1
  fi
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

# The other half of a red control. WSUI-02 and WSUI-03 assert the end state and
# are red against today's shell, so "red" alone cannot tell a real finding from
# a checker that can never pass. Each probe names the rows that must stay green.
require_working() {
  local rows="$1" rid="$2" what="$3"
  grep -q "^ROW|$rid|working|" "$rows" \
    || die "$what: $rid must stay green, or the corruption was not targeted ($rows)"
}

# forge_proof <proofs> <label> <scenario> <wired> <nav> <value> <exit>
# forge_proof <proofs> <label> <scenario> <wired> <nav> <value> <exit> [declared...]
# Declarations default to the same routes the proof line reports; a probe that
# wants them to disagree passes its own list.
forge_proof() {
  local proofs="$1" label="$2" scenario="$3" wired="$4" nav="$5" value="$6" code="$7"
  shift 7
  local -a declared=("$@")
  [ "${#declared[@]}" -gt 0 ] || declared=("${FORGED_ROUTES[@]}")
  {
    local declaration
    for declaration in "${declared[@]}"; do
      printf 'SHELL-SCREEN %s|show-%s|Group|Title %s\n' \
        "$declaration" "$declaration" "$declaration"
    done
    printf 'SHELL-PROOF routes=%d wired=%s scenario=%s active=run nav=%s' \
      "${#FORGED_ROUTES[@]}" "$wired" "$scenario" "$nav"
    printf ' drawer=hidden banner=none'
    local route
    for route in "${FORGED_ROUTES[@]}"; do
      printf ' availability-%s=%s' "$route" "$value"
    done
    printf '\n'
    printf 'SHELL-PROOF-END screens=%d\n' "${#declared[@]}"
  } >"$proofs/$label.line"
  printf '%s\n' "$code" >"$proofs/$label.exit"
}

# The readings the two IO rows need, all healthy, so a probe aimed elsewhere
# does not turn them red as collateral and blur what it proved.
forge_io_readings() {
  local proofs="$1" wired="$2" nav="$3"
  forge_proof "$proofs" fixture-nonet current "$wired" "$nav" current 0
  forge_proof "$proofs" fixture-nohome current "$wired" "$nav" current 0
  forge_proof "$proofs" live-open current "$wired" "$nav" current 0
  forge_proof "$proofs" live-nonet current "$wired" "$nav" disconnected 0
  printf 'CONNECTED\n' >"$proofs/control-net-open.txt"
  printf 'DENIED\n' >"$proofs/control-net-denied.txt"
  printf 'READ\n' >"$proofs/control-home-open.txt"
  printf 'DENIED\n' >"$proofs/control-home-denied.txt"
}

probe_forged_healthy() {
  local work
  work="$(mktemp -d -t wsui-healthy)"
  local proofs="$work/proofs"
  mkdir -p "$proofs"
  # A shell that ignores the injected fault and renders every screen healthy —
  # the exact defect WSUI-03 exists to catch. Its counters agree and it exits 0,
  # so a leg reading the exit code, or the counters alone, would call it a pass.
  local n=${#FORGED_ROUTES[@]} scenario
  for scenario in "${SCENARIOS[@]}"; do
    forge_proof "$proofs" "fixture-$scenario" "$scenario" "$n" "$n" current 0
  done
  forge_io_readings "$proofs" "$n" "$n"
  local rows="$work/rows.txt"
  assert_rows "$proofs" >"$rows" 2>&1 || true
  require_broken "$rows" WSUI-03 "forged-healthy"
  require_working "$rows" WSUI-01 "forged-healthy"
  require_working "$rows" WSUI-02 "forged-healthy"
  require_working "$rows" WSUI-04 "forged-healthy"
  require_working "$rows" WSUI-05 "forged-healthy"
  require_working "$rows" WSUI-06 "forged-healthy"
  echo "PROBE OK: forged-healthy (only WSUI-03 moved)"
  rm -rf "$work"
}

probe_forged_counters() {
  local work
  work="$(mktemp -d -t wsui-counters)"
  local proofs="$work/proofs"
  mkdir -p "$proofs"
  # A shell that registers more screens than it has contracts for, and puts
  # fewer in the sidebar than it registers — a screen shipped without an honest
  # wire and a screen that exists but cannot be reached. Every state is
  # otherwise correct, so only WSUI-02 may move.
  local n=${#FORGED_ROUTES[@]} scenario
  for scenario in "${SCENARIOS[@]}"; do
    forge_proof "$proofs" "fixture-$scenario" "$scenario" \
      "$((n - 2))" "$((n - 1))" "$scenario" 0
  done
  forge_io_readings "$proofs" "$((n - 2))" "$((n - 1))"
  local rows="$work/rows.txt"
  assert_rows "$proofs" >"$rows" 2>&1 || true
  require_broken "$rows" WSUI-02 "forged-counters"
  require_working "$rows" WSUI-01 "forged-counters"
  require_working "$rows" WSUI-03 "forged-counters"
  require_working "$rows" WSUI-04 "forged-counters"
  require_working "$rows" WSUI-05 "forged-counters"
  require_working "$rows" WSUI-06 "forged-counters"
  echo "PROBE OK: forged-counters (only WSUI-02 moved)"
  rm -rf "$work"
}

# The inverse control for the two end-state rows: they are red against today's
# shell, so this proves they are capable of green rather than structurally red.
probe_end_state_reachable() {
  local work
  work="$(mktemp -d -t wsui-endstate)"
  local proofs="$work/proofs"
  mkdir -p "$proofs"
  # The shell as it must be once the omission and the availability registry
  # land: every registered screen has a contract, every one is in the sidebar,
  # and every one holds the injected fault.
  local n=${#FORGED_ROUTES[@]} scenario
  for scenario in "${SCENARIOS[@]}"; do
    forge_proof "$proofs" "fixture-$scenario" "$scenario" "$n" "$n" "$scenario" 0
  done
  forge_io_readings "$proofs" "$n" "$n"
  local rows="$work/rows.txt"
  assert_rows "$proofs" >"$rows" 2>&1 || true
  local rid
  for rid in WSUI-01 WSUI-02 WSUI-03 WSUI-04 WSUI-05 WSUI-06; do
    require_working "$rows" "$rid" "end-state-reachable"
  done
  echo "PROBE OK: end-state-reachable (every row green on the end state)"
  rm -rf "$work"
}

# WSUI-06 derives its expectation from the shell's own declarations, so it must
# be shown to fail in BOTH directions — otherwise it would pass just as happily
# against a hardcoded list, which is the thing it replaced. The third case is
# the one that keeps it honest when a run dies: a truncated declaration must be
# a failure to measure, never a short list.
probe_screen_registry() {
  local work proofs rows n
  work="$(mktemp -d -t wsui-registry)"
  proofs="$work/proofs"
  n=${#FORGED_ROUTES[@]}

  forge_case() {
    local dir="$1"
    shift
    mkdir -p "$dir"
    local scenario
    for scenario in "${SCENARIOS[@]}"; do
      proofs="$dir" forge_proof "$dir" "fixture-$scenario" "$scenario" \
        "$n" "$n" "$scenario" 0 "$@"
    done
    forge_io_readings "$dir" "$n" "$n"
  }

  # A screen the registry declares that the shell never built.
  forge_case "$proofs/ghost" "${FORGED_ROUTES[@]}" phantom-screen
  rows="$work/ghost.txt"
  assert_rows "$proofs/ghost" >"$rows" 2>&1 || true
  require_broken "$rows" WSUI-06 "declared-but-not-built"
  grep -q 'declared-but-not-built=phantom-screen' "$rows" \
    || die "declared-but-not-built: the row did not name the undeclared screen"

  # A screen the shell built that the registry does not declare.
  forge_case "$proofs/undeclared" "${FORGED_ROUTES[@]:1}"
  rows="$work/undeclared.txt"
  assert_rows "$proofs/undeclared" >"$rows" 2>&1 || true
  require_broken "$rows" WSUI-06 "built-but-not-declared"
  grep -q "built-but-not-declared=${FORGED_ROUTES[0]}" "$rows" \
    || die "built-but-not-declared: the row did not name the surplus screen"

  # A run cut off before it closed its declaration list.
  forge_case "$proofs/truncated" "${FORGED_ROUTES[@]}"
  local label
  for label in fixture-current fixture-nonet fixture-nohome; do
    grep -v '^SHELL-PROOF-END ' "$proofs/truncated/$label.line" \
      >"$proofs/truncated/$label.trimmed"
    mv "$proofs/truncated/$label.trimmed" "$proofs/truncated/$label.line"
  done
  rows="$work/truncated.txt"
  assert_rows "$proofs/truncated" >"$rows" 2>&1 || true
  require_broken "$rows" WSUI-06 "truncated-declaration"
  grep -q 'no-declaration-terminator' "$rows" \
    || die "truncated-declaration: the row did not name the missing terminator"

  echo "PROBE OK: screen-registry (both directions and a truncated run)"
  rm -rf "$work"
}

probe_corpus_retired_row() {
  local work
  work="$(mktemp -d -t wsui-corpus)"
  local corpus="$work/corpus"
  cp -R "$FIXTURE_CORPUS" "$corpus"
  # Put a RETIRED screen back into the absent-screens corpus. ShellRoute has a
  # case only for a screen the registry declares, so an autonomy row cannot
  # decode into a route, and the store must refuse the whole corpus rather than
  # serve a shell with a resurrected destination.
  #
  # This probe used to REMOVE the autonomy row instead, and that expectation
  # went stale: making absence structural deleted the retired rows from the
  # corpus, so there was nothing left to remove and the probe could no longer
  # bite. Removal is also no longer constructible for any screen — every
  # ShellRoute case is wired, so no route needs an absent row at all. Adding an
  # undeclared one is the direction that still has a subject, and it guards the
  # property that actually matters: a retired screen must not be reinstatable
  # through fixture data.
  python3 - "$corpus/shell-absent-screens-corpus.json" <<'PY'
import json, sys
path = sys.argv[1]
rows = json.loads(open(path, encoding="utf-8").read())
if any(row["value"]["route"] == "autonomy" for row in rows):
    raise SystemExit("corpus already declares autonomy; the probe must add it")
rows.append(
    {
        "schemaVersion": 1,
        "source": {"revision": None, "generation": None},
        "observedAt": None,
        "freshness": "unknown",
        "availability": "unknown",
        "evidence": None,
        "value": {
            "route": "autonomy",
            "contractState": "retired",
            "reason": "Probe row: a retired screen must not be reinstatable.",
        },
    }
)
open(path, "w", encoding="utf-8").write(json.dumps(rows, indent=2))
PY
  build_qa_binary "$work" || die "$BUILD_REFUSAL"
  local proofs="$work/proofs"
  mkdir -p "$proofs"
  local scenario
  for scenario in "${SCENARIOS[@]}"; do
    proof_run "$proofs" "fixture-$scenario" "$scenario" "" --workspace-shell "$corpus"
  done
  grep -q '^SHELL-PROOF FAIL' "$proofs/fixture-current.line" \
    || die "corpus-retired-row: the shell accepted a corpus reinstating a retired screen"
  # Named, not merely failed: a corpus that died for an unrelated reason would
  # otherwise satisfy the check above and prove nothing about the retired row.
  grep -q 'invalidAbsentRow' "$proofs/fixture-current.line" \
    || die "corpus-retired-row: the shell refused for the wrong reason: $(cat "$proofs/fixture-current.line")"
  [ "$(cat "$proofs/fixture-current.exit")" != 0 ] \
    || die "corpus-retired-row: the shell exited 0 on a corpus it should refuse"
  printf 'CONNECTED\n' >"$proofs/control-net-open.txt"
  printf 'DENIED\n' >"$proofs/control-net-denied.txt"
  printf 'READ\n' >"$proofs/control-home-open.txt"
  printf 'DENIED\n' >"$proofs/control-home-denied.txt"
  local rows="$work/rows.txt"
  assert_rows "$proofs" >"$rows" 2>&1 || true
  require_broken "$rows" WSUI-01 "corpus-retired-row"
  rm -rf "$work"
}

probe_sandbox_blind() {
  local artifacts="$1" home="$2" port="$3" hive_bin="$4"
  [ -n "$artifacts" ] && [ -n "$home" ] && [ -n "$port" ] && [ -n "$hive_bin" ] || usage
  mkdir -p "$artifacts"
  build_qa_binary "$artifacts" || die "$BUILD_REFUSAL"
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
      forged-healthy) probe_forged_healthy ;;
      forged-counters) probe_forged_counters ;;
      end-state-reachable) probe_end_state_reachable ;;
      screen-registry) probe_screen_registry ;;
      corpus-retired-row) probe_corpus_retired_row ;;
      sandbox-blind) shift; probe_sandbox_blind "${1:-}" "${2:-}" "${3:-}" "${4:-}" ;;
      *) usage ;;
    esac
    ;;
  *) usage ;;
esac
