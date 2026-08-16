#!/usr/bin/env bash
# qa/suite.sh — composition runner for the deterministic matrix in MATRIX_ROWS.
#
#   qa/suite.sh fixture              private rig + landed legs + suite-report.jsonl
#   qa/suite.sh probe missing-row    aggregator must red on incomplete coverage
#   qa/suite.sh probe forged-tier    SYS-12 production origin refusal
#   qa/suite.sh probe teardown-leak  down leak must exit nonzero
#   qa/suite.sh probe schema         invalid leg row must red aggregation
#   qa/suite.sh probe broken-exit    a broken verdict forbids green / exit 0
#   qa/suite.sh probe shared-home    preflight refuses the known shared home
#   qa/suite.sh probe cleanup-trap   mid-run die still tears down the private rig
#   qa/suite.sh probe workspace-ui   every workspace-ui row must be able to fail
#
# Dev is the sole driver: preflight records sourceTier=dev and refuses a
# production origin. The suite never globs /tmp/hvqa-* and never reuses a
# shared rig; it publishes its own QA_HOME via qa/rig.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SCRIPT_DIR/repo-root.sh"
. "$SCRIPT_DIR/tour-interaction-slugs.sh"
SRC_ROOT="$(qa_repo_root "$SCRIPT_DIR")" || exit 2
PRIMARY_CHECKOUT="/Users/scottkellar/Projects/hive"
# Known shared live-phase home (ownerless custodian rig). Suite must never use it.
SHARED_QA_HOME_MARK="hvqa-0de8db4fd4"
RIG="$SCRIPT_DIR/rig.sh"
RESET="$SCRIPT_DIR/reset-test-project.sh"
TOUR="$SCRIPT_DIR/tour.sh"
WORKSPACE_UI="$SCRIPT_DIR/workspace-ui.sh"
DAEMON_SCENARIO="$SCRIPT_DIR/daemon-scenario.ts"
FIXTURE_CORPUS="${FIXTURE_CORPUS:-$SRC_ROOT/workspace/Tests/WorkspaceCoreTests/Fixtures}"
# Tour uses [ -z "${TOUR_CALIBRATION:-}" ] to mean off (tour.sh route_red).
# Contract: empty/unset = off; only the value "1" enables calibration.
# Never default to "0" — that is non-empty and would enable calibration.
TOUR_CALIBRATION="${TOUR_CALIBRATION:-}"
# GhosttyKit.xcframework is a build output (not in worktrees). Prefer primary.
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$PRIMARY_CHECKOUT/workspace}"

QA_PROJECT="${QA_PROJECT:-/Users/scottkellar/Projects/hive-test-project}"
SUITE_HOME_TAG="$(printf 'suite-%s-%s' "$$" "$(date +%s)" | /usr/bin/shasum -a 256 | cut -c1-10)"
QA_HOME="${QA_HOME:-/tmp/hvqa-$SUITE_HOME_TAG}"

# Known leg outputs only — never glob legs/*.jsonl (stale files must not ingest).
# queen-scenario.jsonl is optional this S wave (absent → SYS-07 etc. NOT-RUN-BY-S
# ownerLeg=Q). Once the file exists it is ingested and schema-validated.
# agent-scenario.jsonl is reserved the same way when A lands a JSONL emitter.
LEG_FILES=(
  s-rows.jsonl
  daemon-scenario.jsonl
  tour-rows.jsonl
  tour-interaction-rows.jsonl
  workspace-ui-rows.jsonl
  queen-scenario.jsonl
  agent-scenario.jsonl
)
# Comma/space-separated leg basenames that MUST exist for this run (red if absent).
# Default: empty — optional legs (Q/A) may be absent when those legs did not run.
QA_SUITE_EXPECT_LEGS="${QA_SUITE_EXPECT_LEGS:-}"

refuse() { echo "suite: refusing: $*" >&2; exit 2; }
die() { echo "suite: $*" >&2; exit 1; }
log() { echo "suite: $*" >&2; }

usage() {
  echo "usage: qa/suite.sh fixture" >&2
  echo "       qa/suite.sh probe missing-row|forged-tier|teardown-leak|schema|broken-exit|shared-home|cleanup-trap|raw-d|green-needs|tour-calibration|tour-interaction-row|declared-screens|declared-catalog|screen-id-binding|queen-leg|workspace-ui" >&2
  exit 2
}

mode="${1:-}"
[ -n "$mode" ] || usage
shift || true

# --- matrix catalog: id, determinism, owning leg when not run by S --------
MATRIX_ROWS="$(cat <<'EOF'
MCP-01|yes|D
MCP-02|yes|D
MCP-03|bounded|A
MCP-04|yes|D
MCP-05|yes|D
MCP-06|bounded|D
MCP-07|bounded|D
MCP-08|yes|D
MCP-09|yes|D
MCP-10|yes|D
MCP-11|bounded|A
MCP-12|bounded|D
MCP-13|yes|D
MCP-14|bounded|D
MCP-15|bounded|D
MCP-16|yes|D
MCP-17|yes|D
MCP-18|yes|D
MCP-19|yes|D
MCP-20|yes|D
MCP-21|yes|D
MCP-22|bounded|A
MCP-23|yes|D
MCP-24|yes|D
MCP-25|yes|D
MCP-26|yes|D
MCP-27|yes|D
MCP-28|yes|D
MCP-29|yes|D
MCP-30|yes|D
MCP-31|yes|D
MCP-32|yes|D
MCP-34|yes|D
MCP-36|yes|D
MCP-38|yes|D
MCP-39|yes|D
MCP-40|yes|D
CLI-01|yes|D
CLI-02|yes|D
CLI-03|yes|F
CLI-04|yes|F
CLI-05|bounded|F
CLI-06|bounded|D
CLI-07|yes|D
CLI-08|yes|D
CLI-09|bounded|D
CLI-10|yes|D
CLI-11|yes|D
CLI-12|yes|D
CLI-13|yes|D
CLI-14|yes|D
CLI-15|yes|D
CLI-16|yes|D
CLI-17|bounded|A
UI-01|calibrated|T
UI-02|calibrated|T
UI-03|calibrated|T
UI-05|calibrated|T
UI-07|calibrated|T
UI-08|calibrated|T
UI-09|calibrated|T
UI-10|calibrated|T
SYS-01|yes|S
SYS-02|yes|D
SYS-03|yes|D
SYS-04|yes|D
SYS-05|yes|D
SYS-06|bounded|A
SYS-07|bounded|Q
SYS-08|bounded|D
SYS-09|yes|D
SYS-10|calibrated|T-interact
SYS-11|yes|F
SYS-12|yes|S
WSUI-01|yes|W
WSUI-02|yes|W
WSUI-03|yes|W
WSUI-04|yes|W
WSUI-05|yes|W
WSUI-06|yes|W
EOF
)"
# Derived from the catalog above and never restated. A second copy of this
# number is exactly how a row gets added while the totals check keeps passing.
MATRIX_ROW_COUNT="$(printf '%s\n' "$MATRIX_ROWS" | grep -c '|')"

# Stable UI id → declared slug, and the only place the pairing is stated.
# UI-04 (tokens) and UI-06 (autonomy) are absent because they name no screen;
# every surviving screen keeps the number it has always had. Renumbering is
# what this table exists to prevent: an id is a stable name, so shifting one
# silently re-points every stored capture and report at a different screen.
#
# The ids are deliberately not contiguous, and closing the gaps would be the
# bug. Rows once derived their id from a slug's POSITION in a hand-kept list,
# so removing a screen from the middle renumbered every screen after it while
# the suite stayed green — that is how memory-overview through
# memory-maintenance each came to answer to the id of their predecessor.
TOUR_SCREEN_MAP="$(cat <<'EOF'
UI-01|run
UI-02|router
UI-03|models
UI-05|queen
UI-07|memory-overview
UI-08|memory-library
UI-09|memory-recall
UI-10|memory-maintenance
EOF
)"

# Catalog T rows must be exactly these ids. A reintroduced UI-04/UI-06 or a
# renamed survivor is a failed catalog, not a row to mark broken.
qa_catalog_ui_ids() {
  printf '%s\n' "$MATRIX_ROWS" | awk -F'|' '$1 ~ /^UI-/ && $3 == "T" { print $1 }' | sort
}

qa_map_ui_ids() {
  printf '%s\n' "$TOUR_SCREEN_MAP" | awk -F'|' '{ print $1 }' | sort
}

qa_map_slugs() {
  printf '%s\n' "$TOUR_SCREEN_MAP" | awk -F'|' '{ print $2 }' | sort
}

qa_declared_vs_catalog() {
  local declared_file="$1"
  local extra missing
  extra="$(comm -13 <(qa_map_slugs) <(sort "$declared_file"))"
  missing="$(comm -23 <(qa_map_slugs) <(sort "$declared_file"))"
  if [ -n "$extra" ] || [ -n "$missing" ]; then
    extra="${extra//$'\n'/,}"
    missing="${missing//$'\n'/,}"
    echo "declared list disagrees with the screen catalog extra=[${extra}] missing=[${missing}]"
    return 1
  fi
  return 0
}

# The settled id-to-slug pairing, written out a second time on purpose.
#
# This is the expectation, so it must not be read from TOUR_SCREEN_MAP: a
# control that derives its expected value from the thing under test agrees with
# every edit, including the wrong ones. Same reason FROZEN_DECLARED_SCREENS is
# a literal. Changing a pairing here is a deliberate act with a reviewer
# attached, which is exactly what a silent re-point never had.
#
# UI-04 (tokens) and UI-06 (autonomy) are retired. A retired id is a tombstone,
# never a free slot to hand to the next screen.
FROZEN_SCREEN_ID_BINDING="$(cat <<'EOF'
UI-01|run
UI-02|router
UI-03|models
UI-05|queen
UI-07|memory-overview
UI-08|memory-library
UI-09|memory-recall
UI-10|memory-maintenance
EOF
)"
RETIRED_SCREEN_IDS="UI-04 UI-06"

# Fails naming the screen whose id moved. The set comparisons next door cannot
# see this: swap two slugs' ids and both the id set and the slug set are
# unchanged, so the mismatch they look for never appears.
qa_assert_screen_id_binding() {
  local id slug actual_id actual_slug drift=0
  while IFS='|' read -r id slug; do
    [ -n "$id" ] || continue
    actual_id="$(printf '%s\n' "$TOUR_SCREEN_MAP" | awk -F'|' -v s="$slug" '$2 == s { print $1 }')"
    if [ "$actual_id" != "$id" ]; then
      echo "screen $slug is bound to ${actual_id:-<absent>}, settled id is $id" >&2
      drift=1
    fi
  done <<EOF
$FROZEN_SCREEN_ID_BINDING
EOF
  for id in $RETIRED_SCREEN_IDS; do
    actual_slug="$(printf '%s\n' "$TOUR_SCREEN_MAP" | awk -F'|' -v i="$id" '$1 == i { print $2 }')"
    if [ -n "$actual_slug" ]; then
      echo "retired id $id was reissued to $actual_slug" >&2
      drift=1
    fi
  done
  [ "$drift" -eq 0 ]
}

catalog_ui_ids="$(qa_catalog_ui_ids)"
map_ui_ids="$(qa_map_ui_ids)"
if [ "$catalog_ui_ids" != "$map_ui_ids" ]; then
  die "screen catalog ids disagree with the declared-screen map catalog=[${catalog_ui_ids//$'\n'/,}] map=[${map_ui_ids//$'\n'/,}]"
fi
# Every run, not just `probe screen-id-binding`. The check above compares sets
# and so cannot see a screen handed another screen's id; this one names it.
qa_assert_screen_id_binding || die "the settled screen id binding drifted"

resolve_real() {
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

# Resolve QA_HOME and refuse the known shared live-phase home before any mutation.
# Returns 2 on shared-home refusal so probes can assert without the process exiting first.
preflight_qa_home() {
  local resolved
  resolved="$(resolve_real "$QA_HOME")" || refuse "could not resolve QA_HOME '$QA_HOME'"
  case "$resolved" in
    */"$SHARED_QA_HOME_MARK"|*/"$SHARED_QA_HOME_MARK"/*)
      echo "suite: refusing: QA_HOME resolves to the shared ownerless rig ($resolved); suite requires a private home" >&2
      return 2
      ;;
  esac
  case "$QA_HOME" in
    *"$SHARED_QA_HOME_MARK"*)
      echo "suite: refusing: QA_HOME names the shared ownerless rig ($QA_HOME); suite requires a private home" >&2
      return 2
      ;;
  esac
  # Bind the resolved path so later steps cannot follow a swapped symlink.
  QA_HOME="$resolved"
  log "private QA_HOME=$QA_HOME (preflight; never shared $SHARED_QA_HOME_MARK)"
}

# SYS-12: execution origin. Production origin is refused before any work.
preflight_origin() {
  local run_dir="$1"
  local source_tier="${QA_SUITE_FORCE_SOURCE_TIER:-dev}"
  local src_sha src_dirty

  case "$source_tier" in
    production|prod)
      {
        echo "sourceTier=$source_tier"
        echo "source=$SRC_ROOT"
        echo "reason=production origin refused; QA is driven only from the development checkout"
      } > "$run_dir/execution-origin.txt"
      echo "suite: refusing: production origin (sourceTier=$source_tier); SYS-12 forbids QA from a production driver" >&2
      return 2
      ;;
    dev) ;;
    *)
      refuse "unknown sourceTier='$source_tier' (expected dev)"
      ;;
  esac

  [ -d "$SRC_ROOT/src" ] || refuse "source root has no src/: $SRC_ROOT"
  [ -f "$SCRIPT_DIR/suite.sh" ] || refuse "suite driver missing under qa/"
  [ -d "$SRC_ROOT/.git" ] || [ -f "$SRC_ROOT/.git" ] || refuse "source root is not a git checkout: $SRC_ROOT"

  src_sha="$(git -C "$SRC_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  src_dirty="clean"
  [ -z "$(git -C "$SRC_ROOT" status --porcelain 2>/dev/null)" ] || src_dirty="dirty"

  {
    echo "sourceTier=dev"
    echo "source=$SRC_ROOT"
    echo "sourceSha=$src_sha"
    echo "sourceDirty=$src_dirty"
    echo "qaProject=$QA_PROJECT"
    echo "qaHomeRequested=$QA_HOME"
  } > "$run_dir/execution-origin.txt"

  [ "$QA_PROJECT" = "/Users/scottkellar/Projects/hive-test-project" ] \
    || refuse "QA project must be the designated target (got $QA_PROJECT)"

  log "SYS-12 origin recorded: sourceTier=dev sha=$src_sha ($src_dirty)"
  printf '%s\n' "$src_sha"
}

write_row() {
  # write_row <jsonl> <id> <mode> <verdict> <determinism> <sourceSha> <evidence...>
  local jsonl="$1" id="$2" mode="$3" verdict="$4" det="$5" sha="$6"
  shift 6
  python3 - "$jsonl" "$id" "$mode" "$verdict" "$det" "$sha" "$@" <<'PY'
import json, sys
path, id_, mode, verdict, det, sha = sys.argv[1:7]
evidence = list(sys.argv[7:])
row = {
    "id": id_,
    "mode": mode,
    "verdict": verdict,
    "determinism": det,
    "bugs": {"present": [], "absent": []},
    "evidence": evidence,
    "sourceSha": sha,
}
if verdict == "NOT-RUN-BY-S":
    owner = None
    for item in evidence:
        if item.startswith("owner:"):
            owner = item.split(":", 1)[1]
    if owner:
        row["ownerLeg"] = owner
with open(path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(row, separators=(",", ":")) + "\n")
PY
}

# Returns 0 when report is schema-valid and complete; 1 when incomplete/invalid schema;
# always writes the report when the whole catalog is present after fills. Exit 2 reserved.
# Suite exit nonzero when any broken verdict exists is signaled via manifest.green=false
# and aggregate exit code 1 when broken>0 OR schema invalid.
aggregate_report() {
  local run_dir="$1" source_sha="$2" report="$3"
  local legs_dir="$run_dir/legs"
  mkdir -p "$legs_dir"
  local drop="${QA_SUITE_FORCE_DROP_ROW:-}"
  local leg_list expect_list
  leg_list="$(printf '%s\n' "${LEG_FILES[@]}")"
  expect_list="${QA_SUITE_EXPECT_LEGS:-}"

  local declared_file="${QA_SUITE_DECLARED_SCREENS:-}"
  python3 - "$MATRIX_ROWS" "$legs_dir" "$report" "$source_sha" "$drop" "$run_dir" "$leg_list" "$expect_list" "$TOUR_SCREEN_MAP" "$declared_file" <<'PY'
import json, sys
from pathlib import Path

matrix_text, legs_dir, report_path, source_sha, drop, run_dir, leg_list, expect_list, tour_map, declared_file = sys.argv[1:11]
ALLOWED_VERDICTS = {"working", "broken", "NEEDS-FIXTURE", "NOT-RUN-BY-S"}
ALLOWED_MODES = {"fixture", "live"}
ALLOWED_DET = {"yes", "bounded", "calibrated"}
REQUIRED = ("id", "mode", "verdict", "determinism", "bugs", "evidence", "sourceSha")

matrix = {}
for line in matrix_text.strip().splitlines():
    rid, det, owner = line.split("|", 2)
    matrix[rid] = {"determinism": det, "owner": owner}

# Catalog owners whose rows are filled as NOT-RUN-BY-S when their leg file is
# absent (this S wave does not execute A/Q/F).
not_run_owners = {"A", "Q", "F"}
# Every enumerated leg file maps to exactly one matrix owner. A row ID in a
# file may only claim matrix rows whose catalog owner matches that file.
LEG_OWNER = {
    "s-rows.jsonl": "S",
    "daemon-scenario.jsonl": "D",
    "tour-rows.jsonl": "T",
    "tour-interaction-rows.jsonl": "T-interact",
    "workspace-ui-rows.jsonl": "W",
    "queen-scenario.jsonl": "Q",
    "agent-scenario.jsonl": "A",
}
collected = {}
schema_errors = []
leg_presence = {}

def reject(msg: str) -> None:
    schema_errors.append(msg)

map_ids = {line.split("|", 1)[0] for line in tour_map.splitlines() if line.strip()}
catalog_ui = {rid for rid, meta in matrix.items() if rid.startswith("UI-") and meta["owner"] == "T"}
if catalog_ui != map_ids:
    reject(
        "catalog T ids "
        + ",".join(sorted(catalog_ui))
        + " != declared-screen map "
        + ",".join(sorted(map_ids))
    )
if declared_file:
    declared_path = Path(declared_file)
    if not declared_path.is_file():
        reject(f"declared list missing: {declared_file}")
    else:
        declared = {line.strip() for line in declared_path.read_text().splitlines() if line.strip()}
        map_slugs = {line.split("|", 1)[1] for line in tour_map.splitlines() if line.strip()}
        extra = sorted(declared - map_slugs)
        missing = sorted(map_slugs - declared)
        if extra or missing:
            reject(
                "declared list disagrees with the screen catalog"
                + (f" extra={','.join(extra)}" if extra else "")
                + (f" missing={','.join(missing)}" if missing else "")
            )

leg_names = [n for n in leg_list.splitlines() if n.strip()]
expected = {n.strip() for n in expect_list.replace(",", " ").split() if n.strip()}

for name in leg_names:
    path = Path(legs_dir) / name
    if not path.is_file():
        leg_presence[name] = "absent"
        if name in expected:
            reject(f"expected leg file absent: {name}")
        # Absent optional leg: rows stay NOT-RUN-BY-S via catalog fill below.
        continue
    leg_presence[name] = "present"
    file_owner = LEG_OWNER.get(name)
    if file_owner is None:
        reject(f"{name}: enumerated leg has no LEG_OWNER mapping")
        continue
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        # Present but empty is a leg defect when the file was written.
        reject(f"{name}: leg file is present but empty")
        continue
    for lineno, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            reject(f"{name}:{lineno}: invalid JSON ({exc})")
            continue
        if not isinstance(row, dict):
            reject(f"{name}:{lineno}: row is not an object")
            continue
        for key in REQUIRED:
            if key not in row:
                reject(f"{name}:{lineno}: missing required field {key}")
        rid = row.get("id")
        if not isinstance(rid, str) or rid not in matrix:
            reject(f"{name}:{lineno}: unknown or missing id {rid!r}")
            continue
        catalog_owner = matrix[rid]["owner"]
        if catalog_owner != file_owner:
            reject(
                f"{name}:{lineno}: foreign row id {rid} "
                f"(catalog owner {catalog_owner}, file owner {file_owner})"
            )
            continue
        if drop and rid == drop:
            continue
        if rid in collected:
            reject(f"{name}:{lineno}: duplicate row id {rid}")
            continue
        verdict = row.get("verdict")
        if verdict not in ALLOWED_VERDICTS:
            reject(f"{name}:{lineno}: invalid verdict {verdict!r} for {rid}")
            continue
        mode = row.get("mode")
        if mode not in ALLOWED_MODES:
            reject(f"{name}:{lineno}: invalid mode {mode!r} for {rid}")
            continue
        det = row.get("determinism")
        catalog_det = matrix[rid]["determinism"]
        if det not in ALLOWED_DET:
            reject(f"{name}:{lineno}: invalid determinism {det!r} for {rid}")
            continue
        if det != catalog_det:
            reject(
                f"{name}:{lineno}: determinism {det!r} for {rid} "
                f"does not match catalog {catalog_det!r}"
            )
            continue
        if row.get("sourceSha") != source_sha:
            reject(
                f"{name}:{lineno}: sourceSha {row.get('sourceSha')!r} for {rid} "
                f"does not match bound suite SHA {source_sha!r}"
            )
            continue
        bugs = row.get("bugs")
        if not isinstance(bugs, dict) or not isinstance(bugs.get("present"), list) or not isinstance(bugs.get("absent"), list):
            reject(f"{name}:{lineno}: bugs must be {{present:[], absent:[]}} for {rid}")
            continue
        evidence = row.get("evidence")
        if not isinstance(evidence, list) or not all(isinstance(x, str) for x in evidence):
            reject(f"{name}:{lineno}: evidence must be a string list for {rid}")
            continue
        supplied_owner = row.get("ownerLeg")
        if supplied_owner is not None and supplied_owner != catalog_owner:
            reject(
                f"{name}:{lineno}: ownerLeg {supplied_owner!r} for {rid} "
                f"does not match catalog owner {catalog_owner!r}"
            )
            continue
        if verdict == "NOT-RUN-BY-S":
            row = dict(row)
            row["ownerLeg"] = catalog_owner
        elif supplied_owner is not None:
            row = dict(row)
            row["ownerLeg"] = catalog_owner
        collected[rid] = row

Path(run_dir, "leg-presence.json").write_text(
    json.dumps(leg_presence, indent=2) + "\n", encoding="utf-8"
)

# Fill present-but-not-run rows owned by legs S does not execute this wave.
# Only when that owner's leg file is absent (or not in LEG_OWNER). If the
# owner leg file is present, missing IDs for that owner are incomplete/red.
present_owners = {
    LEG_OWNER[name]
    for name, state in leg_presence.items()
    if state == "present" and name in LEG_OWNER
}
missing = []
for rid, meta in matrix.items():
    if rid in collected:
        continue
    owner = meta["owner"]
    if owner in present_owners:
        missing.append(f"{rid}(owner={owner},leg-present-but-row-missing)")
        continue
    if owner in not_run_owners:
        collected[rid] = {
            "id": rid,
            "mode": "fixture",
            "verdict": "NOT-RUN-BY-S",
            "determinism": meta["determinism"],
            "bugs": {"present": [], "absent": []},
            "evidence": [f"owner:{owner}", "suite-wave-S", "leg-absent"],
            "sourceSha": source_sha,
            "ownerLeg": owner,
        }
    else:
        missing.append(f"{rid}(owner={owner})")

if missing:
    Path(run_dir, "aggregate-incomplete.txt").write_text(
        "incomplete coverage:\n" + "\n".join(missing) + "\n", encoding="utf-8"
    )
    print(
        f"suite: incomplete coverage — missing {len(missing)} row(s): {', '.join(missing)}",
        file=sys.stderr,
    )

if schema_errors:
    Path(run_dir, "aggregate-schema-errors.txt").write_text(
        "\n".join(schema_errors) + "\n", encoding="utf-8"
    )
    print(f"suite: schema validation failed ({len(schema_errors)} error(s))", file=sys.stderr)
    for err in schema_errors[:20]:
        print(f"  {err}", file=sys.stderr)

if missing or schema_errors:
    sys.exit(1)

expected_rows = len(matrix)
if len(collected) != expected_rows or set(collected) != set(matrix):
    print(
        f"suite: expected exactly the {expected_rows} matrix ids, "
        f"got {len(collected)}",
        file=sys.stderr,
    )
    sys.exit(1)

order = list(matrix.keys())
with open(report_path, "w", encoding="utf-8") as fh:
    for rid in order:
        fh.write(json.dumps(collected[rid], separators=(",", ":")) + "\n")

working = sum(1 for r in collected.values() if r["verdict"] == "working")
broken = sum(1 for r in collected.values() if r["verdict"] == "broken")
needs = sum(1 for r in collected.values() if r["verdict"] == "NEEDS-FIXTURE")
notrun = sum(1 for r in collected.values() if r["verdict"] == "NOT-RUN-BY-S")
total = working + broken + needs + notrun
if total != expected_rows:
    print(
        f"suite: verdict totals sum to {total}, expected {expected_rows}",
        file=sys.stderr,
    )
    sys.exit(1)

# Green only when every row in the catalog is working.
# NEEDS-FIXTURE, NOT-RUN-BY-S, and broken are all non-green: the matrix is
# complete (valid) but the suite is not a green product summary.
green = working == expected_rows and broken == 0 and needs == 0 and notrun == 0
manifest = {
    "rows": expected_rows,
    "working": working,
    "broken": broken,
    "needsFixture": needs,
    "notRunByS": notrun,
    "totalsSum": total,
    "report": report_path,
    "valid": True,
    "green": green,
}
Path(run_dir, "suite-manifest.json").write_text(
    json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
)
print(
    f"suite: wrote {report_path} "
    f"(working={working} broken={broken} needs-fixture={needs} "
    f"not-run-by-s={notrun} totalsSum={total} green={str(green).lower()})"
)
if not green:
    reasons = []
    if broken:
        reasons.append(f"broken={broken}")
    if needs:
        reasons.append(f"needs-fixture={needs}")
    if notrun:
        reasons.append(f"not-run-by-s={notrun}")
    print(
        "suite: green summary forbidden — "
        + (", ".join(reasons) if reasons else f"not all {expected_rows} working"),
        file=sys.stderr,
    )
    sys.exit(1)
PY
}

publish_s_rows() {
  local legs="$1" source_sha="$2" hive_bin="$3" home="$4" port="$5"
  local out="$legs/s-rows.jsonl"
  : > "$out"
  write_row "$out" "SYS-12" "fixture" "working" "yes" "$source_sha" \
    "execution-origin.txt" "sourceTier=dev"
  if [ -x "$hive_bin" ] && [ -n "$port" ]; then
    write_row "$out" "SYS-01" "fixture" "working" "yes" "$source_sha" \
      "coordinates.txt" "hive-bin" "port=$port" "home=$home"
  else
    write_row "$out" "SYS-01" "fixture" "broken" "yes" "$source_sha" \
      "missing-hive-bin-or-port"
  fi
}

publish_tour_rows() {
  local legs="$1" source_sha="$2" tour_artifacts="$3" tour_ok="$4" tour_log="${5:-}"
  local out="$legs/tour-rows.jsonl"
  : > "$out"
  local declared="$tour_artifacts/declared-screens.txt"
  if [ ! -f "$declared" ]; then
    log "tour-rows: no declared-screens.txt — cannot derive UI rows from the declared list"
    return 0
  fi
  local disagree
  if ! disagree="$(qa_declared_vs_catalog "$declared")"; then
    die "tour-rows: $disagree"
  fi
  local slug id png
  while IFS= read -r slug; do
    [ -n "$slug" ] || continue
    id="$(printf '%s\n' "$TOUR_SCREEN_MAP" | awk -F'|' -v s="$slug" '$2 == s { print $1 }')"
    [ -n "$id" ] || die "tour-rows: declared slug $slug has no stable UI id"
    png="$tour_artifacts/fixture-$slug.png"
    if [ -n "$tour_log" ] && grep -q "^ok ${slug} -> " "$tour_log" 2>/dev/null \
      && [ -f "$png" ] && [ -s "$png" ]; then
      write_row "$out" "$id" "fixture" "working" "calibrated" "$source_sha" \
        "fixture-$slug.png" "proof.txt"
    else
      write_row "$out" "$id" "fixture" "broken" "calibrated" "$source_sha" \
        "tour-failed-or-missing-capture:$slug" "tour_ok=$tour_ok"
    fi
  done < "$declared"
}

publish_tour_interaction_row() {
  local legs="$1" source_sha="$2" tour_artifacts="$3"
  local out="$legs/tour-interaction-rows.jsonl" slug verdict=working
  local ledger="$tour_artifacts/interactions.tsv"
  if [ ! -f "$ledger" ] || [ "$(wc -l < "$ledger")" -ne "${#TOUR_INTERACTION_SLUGS[@]}" ]; then
    verdict=broken
  fi
  for slug in "${TOUR_INTERACTION_SLUGS[@]}"; do
    [ "$(awk -F '\t' -v slug="$slug" '$1 == slug && $2 == "ok" { found++ } END { print found+0 }' "$ledger" 2>/dev/null)" = 1 ] \
      || verdict=broken
    [ -s "$tour_artifacts/fixture-$slug.png" ] || verdict=broken
  done
  : > "$out"
  write_row "$out" "SYS-10" "fixture" "$verdict" "calibrated" "$source_sha" \
    "interactions.tsv" "${#TOUR_INTERACTION_SLUGS[@]} interaction captures" "post-state and settledness guards"
}

publish_workspace_ui_rows() {
  local legs="$1" source_sha="$2" artifacts="$3" home="$4" port="$5" hive_bin="$6"
  local out="$legs/workspace-ui-rows.jsonl"
  : > "$out"
  mkdir -p "$artifacts"
  local rows="$artifacts/rows.txt"
  # The leg exits nonzero when a row is broken, which is a verdict, not a suite
  # failure — the aggregator decides that. Only an empty row set is fatal here.
  "$WORKSPACE_UI" run "$artifacts" "$home" "$port" "$hive_bin" \
    >"$rows" 2>"$artifacts/leg.log" || true
  local -a parts=()
  local seen=0
  while IFS='|' read -r -a parts; do
    [ "${parts[0]:-}" = ROW ] || continue
    write_row "$out" "${parts[1]}" "fixture" "${parts[2]}" "yes" "$source_sha" \
      "${parts[@]:3}"
    seen=$((seen + 1))
  done < "$rows"
  if [ "$seen" -eq 0 ]; then
    # A leg that produced no rows must say so in the report rather than leave
    # its ids missing, where an incomplete-matrix error would hide the cause.
    log "workspace-ui leg emitted no rows (see $artifacts/leg.log)"
    local rid
    for rid in WSUI-01 WSUI-02 WSUI-03 WSUI-04 WSUI-05 WSUI-06; do
      write_row "$out" "$rid" "fixture" "broken" "yes" "$source_sha" \
        "workspace-ui leg emitted no rows" "leg.log"
    done
  fi
}

# Teardown installed immediately after successful rig up.
SUITE_RIG_UP=0
suite_cleanup() {
  local code=$?
  trap - EXIT HUP INT TERM
  if [ "$SUITE_RIG_UP" -eq 1 ]; then
    log "cleanup trap: rig down + project reset"
    QA_HOME="$QA_HOME" "$RIG" down >"${SUITE_CLEANUP_LOG:-/dev/null}" 2>&1 || true
    "$RESET" reset >/dev/null 2>&1 || true
    "$RESET" check >/dev/null 2>&1 || true
    SUITE_RIG_UP=0
  fi
  exit "$code"
}

prove_hive_bin_credential() {
  # Prove Authorization JSON without persisting the bearer token.
  local home="$1" hive_bin="$2" evidence="$3"
  local out
  out="$(HIVE_HOME="$home" "$hive_bin" credential --agent user 2>/dev/null)" \
    || die "hive-bin credential --agent user failed"
  printf '%s' "$out" | python3 -c '
import json, sys
h = json.load(sys.stdin)
auth = h.get("Authorization", "")
if not isinstance(auth, str) or not auth.startswith("Bearer "):
    raise SystemExit("credential is not Authorization Bearer JSON")
# discard token; never write it
' || die "hive-bin credential output is not Authorization JSON"
  # Evidence is a non-secret proof line only.
  umask 077
  printf 'credential_ok=1\nsubject=user\nformat=Authorization-Bearer\n' > "$evidence"
  chmod 600 "$evidence" 2>/dev/null || true
}

run_fixture() {
  local run_dir source_sha home port hive_bin coords
  local tour_artifacts tour_ok=0
  local status=0

  # Private run dir: not world-readable (credential evidence lives here).
  umask 077
  run_dir="${SUITE_RUN_DIR:-$(mktemp -d -t hive-suite-XXXXXX)}"
  mkdir -p -m 700 "$run_dir/legs" "$run_dir/artifacts"
  chmod 700 "$run_dir" 2>/dev/null || true
  log "run-dir=$run_dir"

  # Preflight BEFORE any project mutation or rig up.
  preflight_qa_home || exit $?
  source_sha="$(preflight_origin "$run_dir")" || exit $?

  if ! "$RESET" check >"$run_dir/pre-check.txt" 2>&1; then
    log "pre-check failed; resetting designated project to seed"
    "$RESET" reset >"$run_dir/pre-reset.txt" 2>&1 || die "reset-test-project reset failed"
    "$RESET" check >"$run_dir/pre-check.txt" 2>&1 || die "reset-test-project check still failing"
  fi
  log "precondition check passed"

  QA_HOME="$QA_HOME" QA_PROJECT="$QA_PROJECT" QA_SRC_ROOT="$SRC_ROOT" \
    QA_SKIP_POLICY="${QA_SKIP_POLICY:-1}" \
    "$RIG" up >"$run_dir/rig-up.txt" 2>&1 || {
      tail -30 "$run_dir/rig-up.txt" >&2
      die "rig up failed"
    }
  # Trap immediately after up so die-paths cannot leak the rig or project.
  SUITE_RIG_UP=1
  SUITE_CLEANUP_LOG="$run_dir/cleanup-trap.txt"
  trap suite_cleanup EXIT HUP INT TERM

  coords="$QA_HOME/artifacts/coordinates.txt"
  [ -f "$coords" ] || die "coordinates not published"
  home="$(sed -n 's/^home=//p' "$coords")"
  port="$(sed -n 's/^port=//p' "$coords")"
  hive_bin="$(sed -n 's/^hive_bin=//p' "$coords")"
  [ -n "$home" ] && [ -n "$port" ] && [ -x "$hive_bin" ] \
    || die "incomplete coordinates (home/port/hive_bin)"
  # Defense in depth — shared home must already have been refused in preflight.
  case "$home" in
    */"$SHARED_QA_HOME_MARK") die "refusing shared ownerless rig home $home" ;;
  esac
  cp "$coords" "$run_dir/artifacts/coordinates.txt"
  log "rig up home=$home port=$port hive_bin=$hive_bin"

  if [ "${QA_SUITE_FORCE_DIE_AFTER_UP:-}" = "1" ]; then
    die "forced mid-run die after rig up (cleanup-trap probe)"
  fi

  publish_s_rows "$run_dir/legs" "$source_sha" "$hive_bin" "$home" "$port"
  prove_hive_bin_credential "$home" "$hive_bin" "$run_dir/artifacts/credential-proof.txt"

  log "running daemon-scenario"
  if HIVE_QA_HOME="$home" HIVE_QA_PORT="$port" HIVE_QA_PROJECT="$QA_PROJECT" \
      HIVE_QA_SRC_ROOT="$SRC_ROOT" HIVE_QA_ARTIFACTS="$home/artifacts" \
      HIVE_HOME="$home" \
      bun run "$DAEMON_SCENARIO" >"$run_dir/daemon-scenario.out" 2>&1; then
    log "daemon-scenario finished"
  else
    log "daemon-scenario exited nonzero (rows still consumed if present)"
    status=1
  fi
  if [ -f "$home/artifacts/daemon-scenario.jsonl" ]; then
    # Mutation probe: corrupt the RAW D file before the suite ingests it.
    if [ "${QA_SUITE_FORCE_CORRUPT_D:-}" = "1" ]; then
      log "forcing raw D corruption (QA_SUITE_FORCE_CORRUPT_D=1)"
      python3 - "$home/artifacts/daemon-scenario.jsonl" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
for row in rows:
    if row.get("id") == "MCP-12":
        row["sourceSha"] = "forged-raw-d-sha"
        row.pop("bugs", None)
        row.pop("mode", None)
        row.pop("evidence", None)
        row["verdict"] = "working"
path.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
PY
    fi
    # Copy RAW leg claims only — never overwrite sourceSha or synthesize
    # mode/bugs/evidence/determinism. Missing or forged fields must red at aggregate.
    cp "$home/artifacts/daemon-scenario.jsonl" "$run_dir/legs/daemon-scenario.jsonl"
  else
    die "daemon-scenario did not write daemon-scenario.jsonl"
  fi

  tour_artifacts="$run_dir/artifacts/tour"
  mkdir -p "$tour_artifacts"
  if [ "${QA_SUITE_SKIP_TOUR:-}" = "1" ]; then
    log "skipping fixture tour (QA_SUITE_SKIP_TOUR=1)"
    : >"$run_dir/tour.out"
    tour_ok=0
  else
    log "running fixture tour corpus=$FIXTURE_CORPUS"
    # Empty TOUR_CALIBRATION must stay unset across the tour boundary (-z = off).
    # Only the literal value "1" enables calibration; never pass "0".
    local tour_status=0
    if [ "$TOUR_CALIBRATION" = "1" ]; then
      log "TOUR_CALIBRATION=1 (calibration walk-on-red)"
      env TOUR_CALIBRATION=1 \
        ARTIFACTS="$tour_artifacts" WORKSPACE_ROOT="$WORKSPACE_ROOT" \
        "$TOUR" fixture "$FIXTURE_CORPUS" \
        >"$run_dir/tour.out" 2>&1 || tour_status=$?
    else
      env -u TOUR_CALIBRATION \
        ARTIFACTS="$tour_artifacts" WORKSPACE_ROOT="$WORKSPACE_ROOT" \
        "$TOUR" fixture "$FIXTURE_CORPUS" \
        >"$run_dir/tour.out" 2>&1 || tour_status=$?
    fi
    # Record the exact calibration value seen by the tour child for probes.
    if [ "$TOUR_CALIBRATION" = "1" ]; then
      printf 'TOUR_CALIBRATION=1\n' >"$run_dir/tour-calibration.env"
    else
      printf 'TOUR_CALIBRATION=\n' >"$run_dir/tour-calibration.env"
    fi
    if [ "$tour_status" -eq 0 ]; then
      tour_ok=1
      log "tour fixture finished"
    else
      log "tour fixture failed (see $run_dir/tour.out)"
      status=1
    fi
  fi
  publish_tour_rows "$run_dir/legs" "$source_sha" "$tour_artifacts" "$tour_ok" "$run_dir/tour.out"
  publish_tour_interaction_row "$run_dir/legs" "$source_sha" "$tour_artifacts"

  log "running workspace-ui shell proofs"
  publish_workspace_ui_rows "$run_dir/legs" "$source_sha" \
    "$run_dir/artifacts/workspace-ui" "$home" "$port" "$hive_bin"

  if [ -f "$tour_artifacts/declared-screens.txt" ]; then
    QA_SUITE_DECLARED_SCREENS="$tour_artifacts/declared-screens.txt"
  else
    unset QA_SUITE_DECLARED_SCREENS
  fi
  if ! aggregate_report "$run_dir" "$source_sha" "$run_dir/suite-report.jsonl"; then
    status=1
  fi

  log "tearing down private rig"
  if [ "${QA_SUITE_FORCE_TEARDOWN_LEAK:-}" = "1" ]; then
    python3 - "$home" <<'PY' &
import os, sys, time
home = sys.argv[1]
fd = open(os.path.join(home, "suite-leak-probe"), "w")
fd.write("leak\n"); fd.flush()
time.sleep(120)
PY
    sleep 0.5
  fi
  if ! QA_HOME="$QA_HOME" "$RIG" down >"$run_dir/rig-down.txt" 2>&1; then
    log "rig down failed (nonzero-binding or survivor)"
    cat "$run_dir/rig-down.txt" >&2 || true
    status=1
  else
    log "rig down clean"
  fi
  SUITE_RIG_UP=0
  trap - EXIT HUP INT TERM

  if ! "$RESET" reset >"$run_dir/post-reset.txt" 2>&1; then
    log "post reset failed"
    status=1
  fi
  if ! "$RESET" check >"$run_dir/post-check.txt" 2>&1; then
    log "post check failed"
    status=1
  else
    log "post check passed"
  fi

  if [ -f "$run_dir/suite-report.jsonl" ]; then
    log "report=$run_dir/suite-report.jsonl"
    log "manifest=$run_dir/suite-manifest.json"
  fi
  [ "$status" -eq 0 ] || exit "$status"
  log "fixture suite complete"
}

write_complete_stub_legs() {
  # Write known LEG_FILES with working rows for every S/D/T-owned id.
  local legs="$1" sha="$2" broken_id="${3:-}"
  python3 - "$legs" "$MATRIX_ROWS" "$sha" "$broken_id" <<'PY'
import json, sys
from pathlib import Path
legs, matrix_text, sha, broken_id = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
# Owners this stub writes a file for. Owners absent here are the ones the S
# wave does not execute; the aggregator fills those as NOT-RUN-BY-S.
mapping = {
    "S": "s-rows.jsonl",
    "D": "daemon-scenario.jsonl",
    "T": "tour-rows.jsonl",
    "T-interact": "tour-interaction-rows.jsonl",
    "W": "workspace-ui-rows.jsonl",
}
produce = {owner: [] for owner in mapping}
for line in matrix_text.strip().splitlines():
    rid, det, owner = line.split("|", 2)
    if owner not in produce:
        continue
    verdict = "broken" if rid == broken_id else "working"
    produce[owner].append({
        "id": rid, "mode": "fixture", "verdict": verdict,
        "determinism": det, "bugs": {"present": [], "absent": []},
        "evidence": ["probe-stub"], "sourceSha": sha,
    })
for owner, name in mapping.items():
    rows = produce[owner]
    (legs / name).write_text(
        "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows),
        encoding="utf-8",
    )
PY
}

probe_missing_row() {
  local run_dir sha="deadbeef"
  run_dir="$(mktemp -d -t hive-suite-missing-XXXXXX)"
  mkdir -p "$run_dir/legs"
  log "probe missing-row: forcing drop of MCP-12 from leg collection"
  write_complete_stub_legs "$run_dir/legs" "$sha"
  export QA_SUITE_FORCE_DROP_ROW=MCP-12
  set +e
  aggregate_report "$run_dir" "$sha" "$run_dir/suite-report.jsonl" 2>"$run_dir/agg.err"
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "probe missing-row: aggregator exited 0; expected incomplete coverage red"
  grep -q 'incomplete coverage' "$run_dir/agg.err" \
    || die "probe missing-row: missing incomplete coverage message"
  grep -q 'MCP-12' "$run_dir/aggregate-incomplete.txt" \
    || die "probe missing-row: incomplete file does not name MCP-12"
  log "probe missing-row: RED as required"
}

probe_forged_tier() {
  local run_dir code
  run_dir="$(mktemp -d -t hive-suite-forged-XXXXXX)"
  export QA_SUITE_FORCE_SOURCE_TIER=production
  log "probe forged-tier: sourceTier=production must refuse"
  set +e
  preflight_origin "$run_dir" >"$run_dir/refuse.out" 2>"$run_dir/refuse.err"
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "probe forged-tier: preflight accepted production origin"
  [ "$code" -eq 2 ] || die "probe forged-tier: expected exit 2, got $code"
  grep -q 'production origin' "$run_dir/refuse.err" \
    || die "probe forged-tier: refusal message missing"
  log "probe forged-tier: RED (refused) as required"
}

probe_teardown_leak() {
  local run_dir home_for_probe leak_pid down_code
  log "probe teardown-leak: leaving a bound process so down fails"
  run_dir="$(mktemp -d -t hive-suite-leak-XXXXXX)"
  preflight_qa_home || die "leak probe: private home preflight failed"
  preflight_origin "$run_dir" >/dev/null || die "leak probe: origin preflight failed"
  if ! "$RESET" check >"$run_dir/pre-check.txt" 2>&1; then
    "$RESET" reset >"$run_dir/pre-reset.txt" 2>&1 || true
    "$RESET" check >"$run_dir/pre-check.txt" 2>&1 || true
  fi
  QA_HOME="$QA_HOME" QA_PROJECT="$QA_PROJECT" QA_SRC_ROOT="$SRC_ROOT" \
    QA_SKIP_POLICY=1 "$RIG" up >"$run_dir/rig-up.txt" 2>&1 || die "leak probe: rig up failed"
  home_for_probe="$QA_HOME"
  python3 - "$home_for_probe" <<'PY' &
import os, sys, time
home = sys.argv[1]
fd = open(os.path.join(home, "suite-leak-probe"), "w")
fd.write("leak\n"); fd.flush()
time.sleep(120)
PY
  leak_pid=$!
  printf '%s\n' "$leak_pid" >"$run_dir/leak.pid"
  sleep 0.5
  kill -0 "$leak_pid" 2>/dev/null || die "leak probe: binder pid $leak_pid is not alive"
  set +e
  QA_HOME="$QA_HOME" "$RIG" down >"$run_dir/rig-down.txt" 2>&1
  down_code=$?
  set -e
  [ "$down_code" -ne 0 ] || die "probe teardown-leak: down exited 0 with a live binder"
  log "probe teardown-leak: RED (down nonzero) as required"
  # Measured cleanup: kill the exact binder, wait for it, require a clean final down.
  kill "$leak_pid" 2>/dev/null || true
  wait "$leak_pid" 2>/dev/null || true
  if kill -0 "$leak_pid" 2>/dev/null; then
    kill -9 "$leak_pid" 2>/dev/null || true
    wait "$leak_pid" 2>/dev/null || true
  fi
  kill -0 "$leak_pid" 2>/dev/null \
    && die "leak probe: binder pid $leak_pid still alive after kill"
  QA_HOME="$QA_HOME" "$RIG" down >"$run_dir/rig-down-final.txt" 2>&1 \
    || {
      cat "$run_dir/rig-down-final.txt" >&2 || true
      die "leak probe: final down failed — bindings remain"
    }
  "$RESET" reset >"$run_dir/post-reset.txt" 2>&1 || die "leak probe: project reset failed"
  "$RESET" check >"$run_dir/post-check.txt" 2>&1 || die "leak probe: project check failed after restore"
  log "probe teardown-leak: project restored; zero bindings"
}

probe_schema() {
  local run_dir sha="deadbeef"
  run_dir="$(mktemp -d -t hive-suite-schema-XXXXXX)"
  mkdir -p "$run_dir/legs"
  log "probe schema: inject verdict=banana + wrong determinism + forged SHA"
  write_complete_stub_legs "$run_dir/legs" "$sha"
  # Corrupt one D row in place.
  python3 - "$run_dir/legs/daemon-scenario.jsonl" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
for row in rows:
    if row["id"] == "MCP-12":
        row["verdict"] = "banana"
        row["determinism"] = "nope"
        row["sourceSha"] = "forged"
        del row["bugs"]
path.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
PY
  set +e
  aggregate_report "$run_dir" "$sha" "$run_dir/suite-report.jsonl" 2>"$run_dir/agg.err"
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "probe schema: aggregator accepted invalid row"
  grep -q 'schema validation failed' "$run_dir/agg.err" \
    || die "probe schema: missing schema failure message"
  [ -f "$run_dir/aggregate-schema-errors.txt" ] \
    || die "probe schema: no schema error file"
  log "probe schema: RED as required"
}

probe_broken_exit() {
  local run_dir sha="deadbeef"
  run_dir="$(mktemp -d -t hive-suite-broken-XXXXXX)"
  mkdir -p "$run_dir/legs"
  log "probe broken-exit: one structurally valid broken row must forbid green"
  write_complete_stub_legs "$run_dir/legs" "$sha" "MCP-12"
  set +e
  aggregate_report "$run_dir" "$sha" "$run_dir/suite-report.jsonl" 2>"$run_dir/agg.err"
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "probe broken-exit: aggregator exited 0 with a broken row"
  [ -f "$run_dir/suite-report.jsonl" ] || die "probe broken-exit: report was not written"
  python3 - "$run_dir/suite-manifest.json" "$MATRIX_ROW_COUNT" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assert m.get("valid") is True, m
assert m.get("green") is False, m
assert m.get("broken", 0) >= 1, m
assert m.get("totalsSum") == int(sys.argv[2]), m
PY
  grep -q 'green summary forbidden' "$run_dir/agg.err" \
    || die "probe broken-exit: missing green-forbidden message"
  log "probe broken-exit: RED as required (report written, green=false)"
}

probe_green_needs() {
  # NEEDS-FIXTURE and NOT-RUN-BY-S complete the matrix but are non-green.
  local run_dir sha="deadbeef"
  run_dir="$(mktemp -d -t hive-suite-green-XXXXXX)"
  mkdir -p "$run_dir/legs"
  log "probe green-needs: NEEDS-FIXTURE + NOT-RUN rows must set green=false"
  write_complete_stub_legs "$run_dir/legs" "$sha"
  # Flip one D row to NEEDS-FIXTURE (structurally valid).
  python3 - "$run_dir/legs/daemon-scenario.jsonl" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
for row in rows:
    if row["id"] == "MCP-05":
        row["verdict"] = "NEEDS-FIXTURE"
path.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
PY
  set +e
  aggregate_report "$run_dir" "$sha" "$run_dir/suite-report.jsonl" 2>"$run_dir/agg.err"
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "probe green-needs: aggregator exited 0 with NEEDS-FIXTURE/NOT-RUN"
  python3 - "$run_dir/suite-manifest.json" "$MATRIX_ROW_COUNT" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assert m.get("valid") is True, m
assert m.get("green") is False, m
assert m.get("needsFixture", 0) >= 1, m
assert m.get("notRunByS", 0) >= 1, m
assert m.get("broken", 0) == 0, m
assert m.get("totalsSum") == int(sys.argv[2]), m
PY
  grep -q 'needs-fixture=' "$run_dir/agg.err" \
    || die "probe green-needs: missing needs-fixture reason"
  log "probe green-needs: RED as required (valid complete, green=false)"
}

probe_raw_d() {
  # Corrupt raw D on the guarded fixture path (not direct aggregate_report).
  local run_dir home_after code
  log "probe raw-d: forged/missing fields on raw D must red through run_fixture"
  run_dir="$(mktemp -d -t hive-suite-rawd-XXXXXX)"
  mkdir -p -m 700 "$run_dir"
  preflight_qa_home || die "raw-d: private home preflight failed"
  home_after="$QA_HOME"
  set +e
  SUITE_RUN_DIR="$run_dir" \
    QA_HOME="$QA_HOME" \
    QA_PROJECT="$QA_PROJECT" \
    QA_SRC_ROOT="$SRC_ROOT" \
    QA_SUITE_FORCE_CORRUPT_D=1 \
    QA_SUITE_SKIP_TOUR=1 \
    "$SCRIPT_DIR/suite.sh" fixture >"$run_dir/console.log" 2>&1
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "probe raw-d: suite exited 0 after raw D corruption"
  grep -q 'forcing raw D corruption' "$run_dir/console.log" \
    || die "probe raw-d: corruption hook did not run"
  # Schema must reject the forged sourceSha / missing fields (not sanitize them).
  if [ -f "$run_dir/aggregate-schema-errors.txt" ]; then
    grep -E 'sourceSha|missing required|invalid' "$run_dir/aggregate-schema-errors.txt" \
      || die "probe raw-d: schema errors do not name the corruption"
  else
    grep -q 'schema validation failed\|incomplete coverage' "$run_dir/console.log" \
      || die "probe raw-d: no schema/incomplete failure in suite log"
  fi
  # Sanitizer must not have rewritten forged SHA into a green report.
  if [ -f "$run_dir/suite-manifest.json" ]; then
    python3 - "$run_dir/suite-manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assert m.get("green") is not True, m
PY
  fi
  QA_HOME="$home_after" "$RIG" down >"$run_dir/down-after.txt" 2>&1 || true
  "$RESET" check >"$run_dir/check-after.txt" 2>&1 || {
    "$RESET" reset >/dev/null 2>&1 || true
    "$RESET" check >"$run_dir/check-after.txt" 2>&1 \
      || die "raw-d: project not clean after probe"
  }
  log "probe raw-d: RED as required (raw path, no sanitization)"
}

probe_queen_leg() {
  # queen-scenario.jsonl is enumerated: absent → NOT-RUN-BY-S owner Q;
  # present → ingested/validated; expected-but-absent and malformed → red.
  local run_dir sha="deadbeef"
  run_dir="$(mktemp -d -t hive-suite-queen-XXXXXX)"
  mkdir -p "$run_dir/legs"
  log "probe queen-leg: absent / present-valid / expected-absent / malformed"

  # 1) Absent: SYS-07 remains NOT-RUN-BY-S ownerLeg=Q.
  write_complete_stub_legs "$run_dir/legs" "$sha"
  set +e
  aggregate_report "$run_dir" "$sha" "$run_dir/suite-report.jsonl" 2>"$run_dir/agg-absent.err"
  set -e
  # green=false (NOT-RUN) → exit 1, but valid complete set writes the manifest.
  [ -f "$run_dir/suite-manifest.json" ] || die "queen-leg absent: no manifest"
  python3 - "$run_dir/suite-report.jsonl" "$run_dir/leg-presence.json" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
sys07 = next(r for r in rows if r["id"] == "SYS-07")
assert sys07["verdict"] == "NOT-RUN-BY-S", sys07
assert sys07.get("ownerLeg") == "Q", sys07
pres = json.load(open(sys.argv[2]))
assert pres.get("queen-scenario.jsonl") == "absent", pres
PY
  log "probe queen-leg: absent → NOT-RUN-BY-S owner=Q"

  # 2) Present valid Q row replaces NOT-RUN fill.
  python3 - "$run_dir/legs/queen-scenario.jsonl" "$sha" <<'PY'
import json, sys
from pathlib import Path
path, sha = Path(sys.argv[1]), sys.argv[2]
row = {
    "id": "SYS-07", "mode": "fixture", "verdict": "working",
    "determinism": "bounded", "bugs": {"present": [], "absent": []},
    "evidence": ["queen-scenario"], "sourceSha": sha,
}
path.write_text(json.dumps(row, separators=(",", ":")) + "\n")
PY
  set +e
  aggregate_report "$run_dir" "$sha" "$run_dir/suite-report-q.jsonl" 2>"$run_dir/agg-present.err"
  set -e
  python3 - "$run_dir/suite-report-q.jsonl" "$run_dir/leg-presence.json" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
sys07 = next(r for r in rows if r["id"] == "SYS-07")
assert sys07["verdict"] == "working", sys07
pres = json.load(open(sys.argv[2]))
assert pres.get("queen-scenario.jsonl") == "present", pres
PY
  log "probe queen-leg: present valid → ingested"

  # 3) Expected but absent → red.
  rm -f "$run_dir/legs/queen-scenario.jsonl"
  set +e
  QA_SUITE_EXPECT_LEGS=queen-scenario.jsonl \
    aggregate_report "$run_dir" "$sha" "$run_dir/suite-report-exp.jsonl" 2>"$run_dir/agg-exp.err"
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "queen-leg: expected-absent did not red"
  grep -q 'expected leg file absent: queen-scenario.jsonl' "$run_dir/aggregate-schema-errors.txt" \
    || die "queen-leg: missing expected-absent error"
  log "probe queen-leg: expected-absent → red"

  # 4) Present malformed → red.
  printf '%s\n' '{"id":"SYS-07","verdict":"working"}' >"$run_dir/legs/queen-scenario.jsonl"
  set +e
  aggregate_report "$run_dir" "$sha" "$run_dir/suite-report-bad.jsonl" 2>"$run_dir/agg-bad.err"
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "queen-leg: malformed present file did not red"
  grep -q 'missing required field' "$run_dir/aggregate-schema-errors.txt" \
    || die "queen-leg: malformed did not report missing fields"
  log "probe queen-leg: malformed present → red"

  # 5) Foreign row ID in queen leg (A-owned MCP-03) must red; cannot satisfy A.
  write_complete_stub_legs "$run_dir/legs" "$sha"
  python3 - "$run_dir/legs/queen-scenario.jsonl" "$sha" <<'PY'
import json, sys
from pathlib import Path
path, sha = Path(sys.argv[1]), sys.argv[2]
rows = [
    {
        "id": "SYS-07", "mode": "fixture", "verdict": "working",
        "determinism": "bounded", "bugs": {"present": [], "absent": []},
        "evidence": ["queen-scenario"], "sourceSha": sha,
    },
    {
        "id": "MCP-03", "mode": "fixture", "verdict": "working",
        "determinism": "bounded", "bugs": {"present": [], "absent": []},
        "evidence": ["trespass"], "sourceSha": sha,
    },
]
path.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
PY
  set +e
  aggregate_report "$run_dir" "$sha" "$run_dir/suite-report-foreign.jsonl" 2>"$run_dir/agg-foreign.err"
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "queen-leg: foreign MCP-03 in queen file was accepted"
  grep -q 'foreign row id MCP-03' "$run_dir/aggregate-schema-errors.txt" \
    || die "queen-leg: missing foreign-row error for MCP-03"
  # MCP-03 must not have been stolen into working; still NOT-RUN owner A if report wrote.
  if [ -f "$run_dir/suite-report-foreign.jsonl" ]; then
    python3 - "$run_dir/suite-report-foreign.jsonl" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
# Foreign row rejected → should not appear as working from Q file.
mcp = next((r for r in rows if r["id"] == "MCP-03"), None)
if mcp is not None:
    assert mcp.get("verdict") != "working" or mcp.get("ownerLeg") == "A", mcp
PY
  fi
  log "probe queen-leg: foreign-row-in-leg → red"

  # 6) Mismatched ownerLeg on a NOT-RUN row must red.
  write_complete_stub_legs "$run_dir/legs" "$sha"
  rm -f "$run_dir/legs/queen-scenario.jsonl"
  # Inject a NOT-RUN row with wrong ownerLeg into s-rows (will also fail file-owner
  # if id is Q-owned — put wrong ownerLeg on an S-owned NOT-RUN claim instead).
  # S-owned rows cannot be NOT-RUN in catalog; inject via queen file with SYS-07
  # and ownerLeg=A (catalog owner is Q).
  python3 - "$run_dir/legs/queen-scenario.jsonl" "$sha" <<'PY'
import json, sys
from pathlib import Path
path, sha = Path(sys.argv[1]), sys.argv[2]
row = {
    "id": "SYS-07", "mode": "fixture", "verdict": "NOT-RUN-BY-S",
    "determinism": "bounded", "bugs": {"present": [], "absent": []},
    "evidence": ["forged-owner"], "sourceSha": sha,
    "ownerLeg": "A",
}
path.write_text(json.dumps(row, separators=(",", ":")) + "\n")
PY
  set +e
  aggregate_report "$run_dir" "$sha" "$run_dir/suite-report-ownerleg.jsonl" 2>"$run_dir/agg-ownerleg.err"
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "queen-leg: mismatched ownerLeg was accepted"
  grep -q 'ownerLeg .A. for SYS-07' "$run_dir/aggregate-schema-errors.txt" \
    || grep -q "ownerLeg 'A' for SYS-07" "$run_dir/aggregate-schema-errors.txt" \
    || die "queen-leg: missing mismatched ownerLeg error"
  log "probe queen-leg: mismatched ownerLeg → red"
  log "probe queen-leg: all cases pinned"
}

probe_tour_calibration() {
  # Pin the empty/1 contract against tour.sh's [ -z "${TOUR_CALIBRATION:-}" ].
  log "probe tour-calibration: empty means off; only 1 enables"
  # Default suite value must be empty (not the string "0").
  local default
  default="$(TOUR_CALIBRATION= bash -c 'TOUR_CALIBRATION="${TOUR_CALIBRATION:-}"; printf %s "$TOUR_CALIBRATION"')"
  [ -z "$default" ] || die "probe tour-calibration: default is not empty (got '$default')"
  # tour.sh route_red: empty → die; non-empty → walk on.
  # Prove suite does not export "0" when unset.
  local env_dump
  env_dump="$(env -u TOUR_CALIBRATION bash -c '
    TOUR_CALIBRATION="${TOUR_CALIBRATION:-}"
    if [ "$TOUR_CALIBRATION" = "1" ]; then
      env TOUR_CALIBRATION=1 printenv TOUR_CALIBRATION
    else
      env -u TOUR_CALIBRATION printenv TOUR_CALIBRATION 2>/dev/null || echo "__UNSET__"
    fi
  ')"
  [ "$env_dump" = "__UNSET__" ] || die "probe tour-calibration: expected unset, got '$env_dump'"
  env_dump="$(TOUR_CALIBRATION=1 bash -c '
    TOUR_CALIBRATION="${TOUR_CALIBRATION:-}"
    if [ "$TOUR_CALIBRATION" = "1" ]; then
      env TOUR_CALIBRATION=1 printenv TOUR_CALIBRATION
    else
      echo fail
    fi
  ')"
  [ "$env_dump" = "1" ] || die "probe tour-calibration: expected 1, got '$env_dump'"
  # Documented tour check: -z is true for empty/unset, false for "0" and "1".
  bash -c 'test -z "${TOUR_CALIBRATION:-}"' || die "probe tour-calibration: ambient -z failed"
  ! TOUR_CALIBRATION=0 bash -c 'test -z "${TOUR_CALIBRATION:-}"' \
    || die "probe tour-calibration: string 0 is empty under -z (would enable calibration)"
  ! TOUR_CALIBRATION=1 bash -c 'test -z "${TOUR_CALIBRATION:-}"' \
    || die "probe tour-calibration: string 1 is empty under -z"
  log "probe tour-calibration: empty/1 contract pinned"
}

probe_tour_interaction_row() {
  local root artifacts legs slug
  root="$(mktemp -d -t hive-suite-tour-interaction-XXXXXX)"
  artifacts="$root/artifacts"
  legs="$root/legs"
  mkdir -p "$artifacts" "$legs"
  for slug in "${TOUR_INTERACTION_SLUGS[@]}"; do
    printf '%s\tok\tprobe\n' "$slug" >> "$artifacts/interactions.tsv"
    printf 'capture\n' > "$artifacts/fixture-$slug.png"
  done

  publish_tour_interaction_row "$legs" probe-sha "$artifacts"
  grep -q '"verdict":"working"' "$legs/tour-interaction-rows.jsonl" \
    || die "probe tour-interaction-row: complete evidence did not publish working"

  sed -i '' 's/run-menu-hive\tok\t/run-menu-hive\tred\t/' "$artifacts/interactions.tsv"
  publish_tour_interaction_row "$legs" probe-sha "$artifacts"
  grep -q '"verdict":"broken"' "$legs/tour-interaction-rows.jsonl" \
    || die "probe tour-interaction-row: red ledger state published working"
  sed -i '' 's/run-menu-hive\tred\t/run-menu-hive\tok\t/' "$artifacts/interactions.tsv"

  rm "$artifacts/fixture-run-modal.png"
  publish_tour_interaction_row "$legs" probe-sha "$artifacts"
  grep -q '"verdict":"broken"' "$legs/tour-interaction-rows.jsonl" \
    || die "probe tour-interaction-row: missing capture published working"
  printf 'capture\n' > "$artifacts/fixture-run-modal.png"

  printf 'unexpected\tok\tprobe\n' >> "$artifacts/interactions.tsv"
  publish_tour_interaction_row "$legs" probe-sha "$artifacts"
  grep -q '"verdict":"broken"' "$legs/tour-interaction-rows.jsonl" \
    || die "probe tour-interaction-row: extra ledger row published working"
  log "probe tour-interaction-row: complete/red/missing/extra controls pinned"
}

# Frozen eight-screen emission matching the settled declared list. Tokens and
# Autonomy are omitted on purpose — a control that puts either back must go red.
FROZEN_DECLARED_SCREENS="$(cat <<'EOF'
SHELL-SCREEN run|show-live-run|Workspace|Live Run
SHELL-SCREEN router|show-task-router|Workspace|Task Router
SHELL-SCREEN models|show-models|Workspace|Models & Quota
SHELL-SCREEN queen|show-queen|Workspace|Queen Provider
SHELL-SCREEN memory-overview|show-memory-overview|Memory|Memory Overview
SHELL-SCREEN memory-library|show-memory-library|Memory|Memory Library
SHELL-SCREEN memory-recall|show-memory-recall|Memory|Recall Lab
SHELL-SCREEN memory-maintenance|show-memory-maintenance|Memory|Memory Maintenance
SHELL-PROOF routes=8 wired=8 scenario=current active=run nav=8
SHELL-PROOF-END screens=8
EOF
)"

probe_declared_screens() {
  . "$SCRIPT_DIR/declared-screens.sh"
  local records slugs titles err
  log "probe declared-screens: frozen emission, missing terminator, count mismatch, empty title"
  records="$(qa_parse_declared_screens "$FROZEN_DECLARED_SCREENS")" \
    || die "probe declared-screens: frozen emission did not parse"
  slugs="$(printf '%s\n' "$records" | cut -d'|' -f1 | tr '\n' ' ')"
  titles="$(printf '%s\n' "$records" | cut -d'|' -f2- | tr '\n' '|')"
  [ "$slugs" = "run router models queen memory-overview memory-library memory-recall memory-maintenance " ] \
    || die "probe declared-screens: unexpected slugs [$slugs]"
  printf '%s\n' "$titles" | grep -q 'Live Run|' \
    || die "probe declared-screens: titles were not parsed [$titles]"
  printf '%s\n' "$titles" | grep -q 'Recall Lab|' \
    || die "probe declared-screens: Recall Lab title missing [$titles]"
  ! printf '%s\n' "$records" | grep -q 'tokens\|autonomy' \
    || die "probe declared-screens: frozen emission smuggled tokens or autonomy"

  err="$(qa_parse_declared_screens "$(printf '%s\n' "$FROZEN_DECLARED_SCREENS" | grep -v SHELL-PROOF-END)" 2>&1)" \
    && die "probe declared-screens: missing terminator parsed as a list"
  printf '%s' "$err" | grep -q 'no SHELL-PROOF-END terminator' \
    || die "probe declared-screens: missing terminator failed for the wrong reason: $err"

  err="$(qa_parse_declared_screens "$(printf '%s\n' "$FROZEN_DECLARED_SCREENS" | sed 's/screens=8/screens=7/')" 2>&1)" \
    && die "probe declared-screens: count mismatch parsed as a list"
  printf '%s' "$err" | grep -q 'claimed 7 screens and printed 8' \
    || die "probe declared-screens: count mismatch failed for the wrong reason: $err"

  err="$(qa_parse_declared_screens "$(printf '%s\n' "$FROZEN_DECLARED_SCREENS" | sed 's/|Live Run$/|/' )" 2>&1)" \
    && die "probe declared-screens: empty title parsed as a list"
  printf '%s' "$err" | grep -q 'has no title' \
    || die "probe declared-screens: empty title failed for the wrong reason: $err"
  log "probe declared-screens: frozen/terminator/count/title controls pinned"
}

probe_declared_catalog() {
  local root declared legs err
  root="$(mktemp -d -t hive-suite-declared-catalog-XXXXXX)"
  declared="$root/declared-screens.txt"
  legs="$root/legs"
  mkdir -p "$legs"
  log "probe declared-catalog: matching list, extra slug, missing slug, tokens reinstated"

  qa_map_slugs > "$declared"
  qa_declared_vs_catalog "$declared" >/dev/null \
    || die "probe declared-catalog: matching declared list disagreed with the catalog"

  printf '%s\n' tokens >> "$declared"
  err="$(qa_declared_vs_catalog "$declared" 2>&1)" \
    && die "probe declared-catalog: extra slug tokens did not fail"
  printf '%s' "$err" | grep -q 'extra=\[tokens\]' \
    || die "probe declared-catalog: extra slug failed without naming tokens: $err"

  qa_map_slugs | grep -v '^run$' > "$declared"
  err="$(qa_declared_vs_catalog "$declared" 2>&1)" \
    && die "probe declared-catalog: missing slug run did not fail"
  printf '%s' "$err" | grep -q 'missing=\[run\]' \
    || die "probe declared-catalog: missing slug failed without naming run: $err"

  {
    qa_map_slugs
    printf '%s\n' tokens autonomy
  } > "$declared"
  err="$(qa_declared_vs_catalog "$declared" 2>&1)" \
    && die "probe declared-catalog: reinstated tokens/autonomy did not fail"
  printf '%s' "$err" | grep -q 'tokens' \
    || die "probe declared-catalog: reinstated tokens not named: $err"
  printf '%s' "$err" | grep -q 'autonomy' \
    || die "probe declared-catalog: reinstated autonomy not named: $err"

  qa_map_slugs > "$declared"
  : > "$root/tour.out"
  mkdir -p "$root/artifacts"
  cp "$declared" "$root/artifacts/declared-screens.txt"
  publish_tour_rows "$legs" probe-sha "$root/artifacts" 0 "$root/tour.out"
  grep -q '"id":"UI-01"' "$legs/tour-rows.jsonl" \
    || die "probe declared-catalog: derived rows omitted UI-01"
  grep -q '"id":"UI-05"' "$legs/tour-rows.jsonl" \
    || die "probe declared-catalog: derived rows omitted UI-05 (would mean queen was renumbered)"
  grep -q '"id":"UI-10"' "$legs/tour-rows.jsonl" \
    || die "probe declared-catalog: derived rows omitted UI-10"
  ! grep -q '"id":"UI-04"' "$legs/tour-rows.jsonl" \
    || die "probe declared-catalog: derived rows reinstated UI-04"
  ! grep -q '"id":"UI-06"' "$legs/tour-rows.jsonl" \
    || die "probe declared-catalog: derived rows reinstated UI-06"
  [ "$(grep -c '"id":"UI-' "$legs/tour-rows.jsonl")" -eq 8 ] \
    || die "probe declared-catalog: expected 8 derived UI rows"

  write_complete_stub_legs "$legs" probe-sha
  QA_SUITE_DECLARED_SCREENS="$declared"
  printf '%s\n' tokens >> "$declared"
  set +e
  aggregate_report "$root" probe-sha "$root/suite-report.jsonl" 2>"$root/agg.err"
  local code=$?
  set -e
  unset QA_SUITE_DECLARED_SCREENS
  [ "$code" -ne 0 ] || die "probe declared-catalog: aggregator accepted a catalog/declared mismatch"
  grep -q 'declared list disagrees with the screen catalog' "$root/agg.err" \
    || grep -q 'declared list disagrees with the screen catalog' "$root/aggregate-schema-errors.txt" \
    || die "probe declared-catalog: aggregator mismatch not named: $(cat "$root/agg.err") $(cat "$root/aggregate-schema-errors.txt" 2>/dev/null)"
  log "probe declared-catalog: match/extra/missing/omission/aggregator controls pinned"
}

probe_screen_id_binding() {
  log "probe screen-id-binding: settled pairing, re-point, swap, tombstone reuse"
  qa_assert_screen_id_binding \
    || die "probe screen-id-binding: the shipped binding already drifted"

  local saved="$TOUR_SCREEN_MAP" err

  # A re-point of one screen, the 85afb4cc5 defect in miniature.
  TOUR_SCREEN_MAP="${saved//UI-07|memory-overview/UI-06|memory-overview}"
  err="$(qa_assert_screen_id_binding 2>&1)" \
    && { TOUR_SCREEN_MAP="$saved"; die "probe screen-id-binding: a re-pointed id passed"; }
  printf '%s' "$err" | grep -q 'screen memory-overview is bound to UI-06, settled id is UI-07' \
    || { TOUR_SCREEN_MAP="$saved"; die "probe screen-id-binding: re-point not named: $err"; }
  printf '%s' "$err" | grep -q 'retired id UI-06 was reissued to memory-overview' \
    || { TOUR_SCREEN_MAP="$saved"; die "probe screen-id-binding: tombstone reuse not named: $err"; }

  # A swap, which leaves both the id set and the slug set identical.
  TOUR_SCREEN_MAP="$(printf '%s\n' "$saved" \
    | sed -e 's/^UI-08|memory-library$/UI-08|memory-recall/' \
          -e 's/^UI-09|memory-recall$/UI-09|memory-library/')"
  err="$(qa_assert_screen_id_binding 2>&1)" \
    && { TOUR_SCREEN_MAP="$saved"; die "probe screen-id-binding: a swapped pair passed"; }
  printf '%s' "$err" | grep -q 'screen memory-library is bound to UI-09, settled id is UI-08' \
    || { TOUR_SCREEN_MAP="$saved"; die "probe screen-id-binding: swap not named: $err"; }

  # The set checks must be shown BLIND to that swap, or this probe is redundant.
  local swapped_ids swapped_slugs
  swapped_ids="$(printf '%s\n' "$TOUR_SCREEN_MAP" | awk -F'|' '{ print $1 }' | sort | tr '\n' ',')"
  swapped_slugs="$(printf '%s\n' "$TOUR_SCREEN_MAP" | awk -F'|' '{ print $2 }' | sort | tr '\n' ',')"
  TOUR_SCREEN_MAP="$saved"
  [ "$swapped_ids" = "$(qa_map_ui_ids | tr '\n' ',')" ] \
    || die "probe screen-id-binding: the swap changed the id set, so it was not a silent re-point"
  [ "$swapped_slugs" = "$(qa_map_slugs | tr '\n' ',')" ] \
    || die "probe screen-id-binding: the swap changed the slug set, so it was not a silent re-point"

  qa_assert_screen_id_binding \
    || die "probe screen-id-binding: binding not restored after the controls"
  log "probe screen-id-binding: re-point, swap and tombstone reuse all fail by name"
}

probe_shared_home() {
  log "probe shared-home: preflight must refuse before reset/up"
  local saved="$QA_HOME" code
  QA_HOME="/tmp/$SHARED_QA_HOME_MARK"
  set +e
  preflight_qa_home >"/tmp/hive-suite-shared-refuse.out" 2>"/tmp/hive-suite-shared-refuse.err"
  code=$?
  set -e
  QA_HOME="$saved"
  [ "$code" -eq 2 ] || die "probe shared-home: expected refuse exit 2, got $code"
  grep -q 'shared ownerless rig' /tmp/hive-suite-shared-refuse.err \
    || die "probe shared-home: refusal message missing"
  log "probe shared-home: RED (refused) as required"
}

probe_cleanup_trap() {
  local run_dir home_after code
  log "probe cleanup-trap: forced die after up must still down + reset"
  run_dir="$(mktemp -d -t hive-suite-trap-XXXXXX)"
  mkdir -p -m 700 "$run_dir"
  # Child process so die/exit cannot abort this probe harness.
  preflight_qa_home || die "cleanup-trap: private home preflight failed"
  home_after="$QA_HOME"
  set +e
  SUITE_RUN_DIR="$run_dir" \
    QA_HOME="$QA_HOME" \
    QA_PROJECT="$QA_PROJECT" \
    QA_SRC_ROOT="$SRC_ROOT" \
    QA_SUITE_FORCE_DIE_AFTER_UP=1 \
    "$SCRIPT_DIR/suite.sh" fixture >"$run_dir/console.log" 2>&1
  code=$?
  set -e
  [ "$code" -ne 0 ] || die "probe cleanup-trap: forced die exited 0"
  grep -q 'forced mid-run die after rig up' "$run_dir/console.log" \
    || die "probe cleanup-trap: forced die message missing from child log"
  # Rig must not remain bound after the child's EXIT trap.
  if QA_HOME="$home_after" "$RIG" down >"$run_dir/down-after.txt" 2>&1; then
    log "probe cleanup-trap: second down clean (trap already cleared bindings)"
  else
    cat "$run_dir/down-after.txt" >&2 || true
    die "probe cleanup-trap: processes still bound after forced die"
  fi
  "$RESET" check >"$run_dir/check-after.txt" 2>&1 \
    || die "probe cleanup-trap: project not restored after forced die"
  log "probe cleanup-trap: RED die path cleaned as required"
}

probe_workspace_ui() {
  # The workspace-ui rows must each be able to fail, and the two that assert the
  # shell's end state must also be able to pass — a row that is red today cannot
  # show by redness alone that it is not simply broken. These four controls need
  # no rig; sandbox-blind does, so it is run through workspace-ui.sh with the
  # coordinates of a live one.
  local control
  for control in forged-healthy forged-counters end-state-reachable corpus-gap; do
    log "probe workspace-ui: $control"
    "$WORKSPACE_UI" probe "$control" \
      || die "probe workspace-ui: $control did not bite"
  done
  log "probe workspace-ui: every control bit as required"
}

case "$mode" in
  fixture|all)
    run_fixture
    ;;
  probe)
    sub="${1:-}"
    case "$sub" in
      missing-row) probe_missing_row ;;
      forged-tier) probe_forged_tier ;;
      teardown-leak) probe_teardown_leak ;;
      schema) probe_schema ;;
      broken-exit) probe_broken_exit ;;
      shared-home) probe_shared_home ;;
      cleanup-trap) probe_cleanup_trap ;;
      raw-d) probe_raw_d ;;
      green-needs) probe_green_needs ;;
      tour-calibration) probe_tour_calibration ;;
      tour-interaction-row) probe_tour_interaction_row ;;
      declared-screens) probe_declared_screens ;;
      declared-catalog) probe_declared_catalog ;;
      screen-id-binding) probe_screen_id_binding ;;
      queen-leg) probe_queen_leg ;;
      workspace-ui) probe_workspace_ui ;;
      *) usage ;;
    esac
    ;;
  *)
    usage
    ;;
esac
