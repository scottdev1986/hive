#!/usr/bin/env bash
# qa/rig-checks.sh — exercise the isolation gate and every rig lifecycle mode.
#
# All homes are short, per-run paths. Refusal symlinks live inside this run's
# scope and are unlinked before exit, so a failed check cannot leave a tempting
# QA-looking alias in the shared /tmp namespace.
set -uo pipefail

QA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$QA_DIR/repo-root.sh"
ROOT="$(qa_repo_root "$QA_DIR")" || exit 2
RIG="$QA_DIR/rig.sh"
PRIMARY_CHECKOUT="/Users/scottkellar/Projects/hive"
DEFAULT_PROJECT="/Users/scottkellar/Projects/hive-test-project"

failures=0
test_identities=""
CHECK_HOME=""
TREE_HOME=""
DEFAULT_HOME=""
RACE_HOME=""
CHECK_REPO=""
SYMLINK_SCOPE=""
SYMLINK_FIXTURE=""
RACE_LINK=""
NON_QA_TARGET=""
SIBLING_HOME=""
PLANT_HOME=""
SESSIOND_HOME=""
FAKE_SRC=""

pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }

process_alive() {
  local state
  state="$(ps -p "$1" -o stat= 2>/dev/null | tr -d ' ')"
  case "$state" in ""|Z*) return 1;; esac
  return 0
}

valid_pid() {
  case "${1:-}" in ""|*[!0-9]*) return 1;; esac
  [ "$1" -gt 1 ] 2>/dev/null
}

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

identity_for_pid() {
  local token
  process_alive "$1" || return 1
  token="$(process_start "$1")" || return 1
  printf '%s:%s\n' "$1" "$token"
}

# Every database under the pinned default home must hold only what this rig put
# there. Prints one reason per violation and returns 1; silent and 0 when clean.
#
# This replaces an older proxy — "no hive.db exists there" — which the daemon
# made false without making anything unsafe: it now seeds a provisional routing
# baseline into its own default instance at bring-up. The proxy could not tell
# a database the rig created from one carried in, so it was traded for the
# property it stood for. Three things are asked of every database, and an
# imported one cannot satisfy any of them:
#
#   identity   A database that has ever served as an instance stamps a
#              databaseIdentity into meta, and copying the file copies the
#              stamp. The default home's databases must carry none.
#   provenance Hive records where state came from — quota.db keeps the path of
#              the database it migrated from. Any recorded path naming a Hive
#              home must name THIS rig's, never ~/.hive, a dev instance, or
#              another rig.
#   history    Imported state was written before it was imported. No timestamp
#              stored anywhere may predate this home's own creation.
#
# Emptiness is deliberately NOT asked: the seeded baseline is legitimate, and a
# check that demanded zero rows would fail on a healthy rig and teach the next
# reader to relax it.
default_home_holds_only_this_rig() {
  local home="$1" birth
  birth="$(python3 -c 'import os,sys; s=os.stat(sys.argv[1]); print(getattr(s,"st_birthtime",s.st_ctime))' "$home")" \
    || { echo "cannot read the birth time of $home"; return 1; }
  python3 - "$home" "$birth" <<'PY'
import datetime, glob, os, re, sqlite3, sys

home, birth = sys.argv[1], float(sys.argv[2])
birth_at = datetime.datetime.fromtimestamp(birth, datetime.timezone.utc)
default_dir = os.path.join(home, "default")
reasons = []

INSTANT = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)$")
# A recorded location is a whole cell that is an absolute path, not a mention
# inside prose. Hive stores provenance that way — quota.db keeps the migrated-
# from database as the entire value of its meta row — and matching prose
# instead produces false alarms on real content: a vendor capability snapshot
# legitimately quotes "~/.hive/memory" inside a skill description.
STORED_PATH = re.compile(r"^/[^\s]*$")
NAMES_A_HOME = re.compile(r"\.hive|hvqa-")

databases = sorted(glob.glob(os.path.join(default_dir, "*.db")))
if not databases:
    print(f"no database under {default_dir}: nothing was inspected")
    raise SystemExit(1)

for path in databases:
    name = os.path.basename(path)
    # Read-only, and opened through SQLite so the write-ahead log is replayed:
    # the main file here is one page while the content lives in the -wal, so a
    # reader that only stats the file sees an empty database that is not empty.
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT value FROM meta WHERE key = 'databaseIdentity'"
        ).fetchone() if con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'"
        ).fetchone() else None
        if row:
            reasons.append(f"{name} carries databaseIdentity {row[0]}: it has served as an instance")
        tables = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for table in tables:
            for record in con.execute(f'SELECT * FROM "{table}"'):
                for cell in record:
                    if not isinstance(cell, str):
                        continue
                    value = cell.strip()
                    if (STORED_PATH.match(value) and NAMES_A_HOME.search(value)
                            and not os.path.realpath(value).startswith(
                                os.path.realpath(home))):
                        reasons.append(
                            f"{name}.{table} records a Hive location outside this rig: {value}")
                    if INSTANT.match(cell.strip()):
                        stamped = datetime.datetime.fromisoformat(
                            cell.strip().replace("Z", "+00:00"))
                        if stamped < birth_at:
                            reasons.append(
                                f"{name}.{table} holds {cell.strip()}, "
                                f"written before this home existed ({birth_at.isoformat()})")
    finally:
        con.close()

for reason in sorted(set(reasons)):
    print(reason)
raise SystemExit(1 if reasons else 0)
PY
}

identity_matches() {
  local identity="$1" p token
  p="${identity%%:*}"
  token="${identity#*:}"
  valid_pid "$p" && process_alive "$p" && [ "$(process_start "$p")" = "$token" ]
}

track_test_pid() {
  local identity
  identity="$(identity_for_pid "$1")" || return 1
  test_identities="$test_identities $identity"
}

signal_test_pid() {
  local signal="$1" target="$2" identity p
  for identity in $test_identities; do
    p="${identity%%:*}"
    if [ "$p" = "$target" ] && identity_matches "$identity"; then
      kill -s "$signal" "$p" 2>/dev/null
      return $?
    fi
  done
  return 1
}

# A red check must leave every surviving fixture tracked for EXIT cleanup.
forget_test_pid() {
  local target="$1" identity p remaining=""
  process_alive "$target" && return 1
  for identity in $test_identities; do
    p="${identity%%:*}"
    [ "$p" = "$target" ] || remaining="$remaining $identity"
  done
  test_identities="$remaining"
}

remove_scratch_tree() {
  local path="$1" resolved
  [ -n "$path" ] || return 0
  [ ! -L "$path" ] || return 1
  resolved="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$path")"
  case "$resolved" in
    /tmp/hvqa-*|/private/tmp/hvqa-*|/tmp/hv-nonqa.*|/private/tmp/hv-nonqa.*)
      /bin/rm -rf "$path" ;;
    *) return 1 ;;
  esac
  [ ! -e "$path" ]
}

cleanup() {
  local status=$? p identity home path retained_homes=" "
  trap - EXIT HUP INT TERM
  for identity in $test_identities; do
    if identity_matches "$identity"; then
      p="${identity%%:*}"
      kill -9 "$p" 2>/dev/null || true
    fi
  done
  for identity in $test_identities; do
    p="${identity%%:*}"
    wait "$p" 2>/dev/null || true
  done
  for link in "$SYMLINK_FIXTURE" "$RACE_LINK"; do
    if [ -n "$link" ] && [ -L "$link" ]; then
      unlink "$link" || true
      status=1
    fi
  done
  for home in "$CHECK_HOME" "$TREE_HOME" "$DEFAULT_HOME" "$RACE_HOME"; do
    [ -n "$home" ] || continue
    if ! QA_HOME="$home" "$RIG" down >/dev/null 2>&1; then
      status=1
      retained_homes="$retained_homes$home "
      echo "rig checks: retaining $home because teardown is not clean" >&2
    fi
  done
  for path in "$CHECK_HOME" "$TREE_HOME" "$DEFAULT_HOME" "$RACE_HOME" "$CHECK_REPO" "$SIBLING_HOME" "$SYMLINK_SCOPE" "$NON_QA_TARGET" "$PLANT_HOME" "$SESSIOND_HOME" "$FAKE_SRC"; do
    case "$retained_homes" in *" $path "*) continue;; esac
    remove_scratch_tree "$path" || status=1
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

CHECK_HOME="$(mktemp -d /tmp/hvqa-c.XXXXXX)" || exit 1
TREE_HOME="$(mktemp -d /tmp/hvqa-x.XXXXXX)" || exit 1
DEFAULT_HOME="$(mktemp -d /tmp/hvqa-d.XXXXXX)" || exit 1
RACE_HOME="$(mktemp -d /tmp/hvqa-t.XXXXXX)" || exit 1
CHECK_REPO="$(mktemp -d /tmp/hvqa-r.XXXXXX)" || exit 1
SYMLINK_SCOPE="$(mktemp -d /tmp/hvqa-s.XXXXXX)" || exit 1
NON_QA_TARGET="$(mktemp -d /tmp/hv-nonqa.XXXXXX)" || exit 1
SIBLING_HOME="$TREE_HOME-other"
mkdir "$SIBLING_HOME" || exit 1
SYMLINK_FIXTURE="$SYMLINK_SCOPE/to-non-qa"
ln -s "$NON_QA_TARGET" "$SYMLINK_FIXTURE" || exit 1
MISSING_PROJECT="/tmp/hvqa-missing-$$"
CHECK_RESOLVED="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$CHECK_HOME")"
RACE_RESOLVED="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$RACE_HOME")"
NON_QA_RESOLVED="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NON_QA_TARGET")"
USER_HOME="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$HOME/.hive")"

if ! {
  git -C "$CHECK_REPO" init -q &&
  git -C "$CHECK_REPO" config user.email qa@rig-check &&
  git -C "$CHECK_REPO" config user.name "qa rig check" &&
  printf '# qa rig check target\n' > "$CHECK_REPO/README.md" &&
  git -C "$CHECK_REPO" add -A &&
  git -C "$CHECK_REPO" commit -qm "qa rig check scaffold"
}; then
  echo "rig checks: could not create scratch project" >&2
  exit 1
fi

expect_refusal() {
  local label="$1" home="$2" expected="$3" out code
  out="$(QA_HOME="$home" QA_PROJECT="$MISSING_PROJECT" "$RIG" up 2>&1)"
  code=$?
  if [ "$code" -eq 2 ] && printf '%s' "$out" | grep -Fq "$expected"; then
    pass "$label refused at the home gate"
  else
    fail "$label was not refused at the home gate (exit $code): $out"
  fi
}

echo "[1/7] resolved-home gate: prod, dev, symlink, then a real QA home"
PRIMARY_RESOLVED="$(cd "$PRIMARY_CHECKOUT" && pwd -P)"
DEV_HOME="$HOME/.hive/instances/dev-$(printf '%s' "$PRIMARY_RESOLVED" | /usr/bin/shasum -a 256 | cut -c1-10)"
expect_refusal "user home" "$HOME/.hive" "protected user home"
# The dev home is a named instance inside the user home, so the user-home rule
# reaches it first and is the wording that comes back. The property under test is
# that this path is refused; demanding the dev-home wording would fail for a
# reason unrelated to whether the gate holds.
expect_refusal "primary dev home $DEV_HOME" "$DEV_HOME" "protected user home"

symlink_out="$(QA_HOME="$SYMLINK_FIXTURE" "$RIG" down 2>&1)"
symlink_code=$?
if [ "$symlink_code" -ne 0 ] && printf '%s' "$symlink_out" | grep -Fq "must resolve under"; then
  pass "a QA-looking symlink to a non-QA home made down fail"
else
  fail "QA-looking symlink survived the resolved-home gate (exit $symlink_code): $symlink_out"
fi
if unlink "$SYMLINK_FIXTURE" && [ ! -L "$SYMLINK_FIXTURE" ]; then
  pass "refusal symlink removed inside its test scope"
else
  fail "refusal symlink was not removed"
fi

ln -s "$DEV_HOME" "$SYMLINK_FIXTURE" || exit 1
expect_refusal "QA-named symlink to the primary dev home" "$SYMLINK_FIXTURE" "protected user home"
unlink "$SYMLINK_FIXTURE" || exit 1
ln -s "$HOME/.hive" "$SYMLINK_FIXTURE" || exit 1
expect_refusal "QA-named symlink to the user home" "$SYMLINK_FIXTURE" "protected user home"
unlink "$SYMLINK_FIXTURE" || exit 1

FAKE_BIN="$SYMLINK_SCOPE/bin"
mkdir "$FAKE_BIN" || exit 1
ln -s /usr/bin/false "$FAKE_BIN/lsof" || exit 1
reader_out="$(PATH="$FAKE_BIN:/usr/bin:/bin" QA_HOME="$CHECK_HOME" "$RIG" down 2>&1)"
reader_code=$?
if [ "$reader_code" -ne 0 ] && printf '%s' "$reader_out" | grep -Fq "positive control"; then
  pass "a broken binding reader made down fail closed"
else
  fail "a broken binding reader passed (exit $reader_code): $reader_out"
fi

unfixed_default="$(env -u HIVE_DEFAULT_HOME bun -e \
  'const { defaultHiveHome } = await import(process.argv[1]); console.log(defaultHiveHome())' \
  "$ROOT/src/hive-home/home.ts")"
isolated_default="$(HIVE_DEFAULT_HOME="$CHECK_RESOLVED/default" bun -e \
  'const { defaultHiveHome } = await import(process.argv[1]); console.log(defaultHiveHome())' \
  "$ROOT/src/hive-home/home.ts")"
unfixed_default_resolved="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$unfixed_default")" \
  || exit 1
isolated_default_resolved="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$isolated_default")" \
  || exit 1
if [ "$unfixed_default_resolved" = "$USER_HOME" ] &&
   [ -f "$unfixed_default_resolved/hive.db" ] &&
   [ "$isolated_default_resolved" = "$CHECK_RESOLVED/default" ]; then
  pass "default-home probe sees the live database unfenced and the QA path when fenced"
else
  fail "default-home controls disagree: unfixed=$unfixed_default_resolved isolated=$isolated_default_resolved"
fi

echo "[2/7] up publishes coordinates and full source-hash evidence; down is empty"
up_out="$(QA_HOME="$CHECK_HOME" QA_PROJECT="$CHECK_REPO" QA_SKIP_POLICY=1 "$RIG" up 2>&1)"
up_code=$?
echo "$up_out" | sed 's/^/    /'
if [ "$up_code" -eq 0 ]; then
  pass "conforming QA home accepted and daemon started"
else
  fail "up failed for a conforming QA home (exit $up_code)"
fi

daemon_pid="$(sed -n '1p' "$CHECK_HOME/daemon.pid" 2>/dev/null)"
owner_pid="$(sed -n '1p' "$CHECK_HOME/owner.pid" 2>/dev/null)"
port="$(sed -n 's/^port=//p' "$CHECK_HOME/artifacts/coordinates.txt" 2>/dev/null)"
daemon_ready=0
if valid_pid "$daemon_pid" && valid_pid "$owner_pid" &&
   process_alive "$daemon_pid" && process_alive "$owner_pid" &&
   case "$port" in ""|*[!0-9]*) false;; *) [ "$port" -gt 0 ] 2>/dev/null;; esac; then
  daemon_ready=1
  pass "up published a live numeric daemon identity"
else
  fail "up did not publish live numeric identities: daemon=$daemon_pid owner=$owner_pid port=$port"
fi
hive_bin="$(sed -n 's/^hive_bin=//p' "$CHECK_HOME/artifacts/coordinates.txt" 2>/dev/null)"
if printf '%s\n' "$up_out" | grep -Fxq "rig: up — home=$CHECK_RESOLVED port=$port daemon_pid=$daemon_pid project=$CHECK_REPO" &&
   grep -Fxq "requested_home=$CHECK_HOME" "$CHECK_HOME/artifacts/coordinates.txt" 2>/dev/null &&
   grep -Fxq "home=$CHECK_RESOLVED" "$CHECK_HOME/artifacts/coordinates.txt" 2>/dev/null &&
   grep -Fxq "default_home=$CHECK_RESOLVED/default" "$CHECK_HOME/artifacts/coordinates.txt" 2>/dev/null &&
   grep -Fxq "port=$port" "$CHECK_HOME/artifacts/coordinates.txt" 2>/dev/null &&
   grep -Fxq "project=$CHECK_REPO" "$CHECK_HOME/artifacts/coordinates.txt" 2>/dev/null &&
   grep -Fxq "source=$ROOT" "$CHECK_HOME/artifacts/coordinates.txt" 2>/dev/null &&
   grep -Fxq "hive_bin=$CHECK_RESOLVED/artifacts/hive-bin" "$CHECK_HOME/artifacts/coordinates.txt" 2>/dev/null &&
   [ -x "$hive_bin" ]; then
  pass "up printed and published exact rig coordinates including hive-bin"
else
  fail "published coordinates do not match up output"
fi

# hive-bin must speak the product credential contract against this rig.
if [ -x "$hive_bin" ] &&
   auth_json="$(HIVE_HOME="$CHECK_RESOLVED" "$hive_bin" credential --agent user 2>/dev/null)" &&
   printf '%s\n' "$auth_json" | python3 -c 'import json,sys; h=json.load(sys.stdin); assert h.get("Authorization","").startswith("Bearer ")'; then
  pass "hive-bin credential --agent user returns Authorization JSON"
else
  fail "hive-bin credential --agent user did not return Authorization JSON"
fi

hash_line="$(grep '^source_hash announced=' "$CHECK_HOME/artifacts/rig-record.txt" 2>/dev/null | tail -1)"
announced="$(printf '%s\n' "$hash_line" | sed -n 's/^source_hash announced=\([0-9a-f]*\) computed=.*/\1/p')"
computed="$(printf '%s\n' "$hash_line" | sed -n 's/.* computed=\([0-9a-f]*\)$/\1/p')"
raw_announcement="$(grep -m1 '^Hive daemon ready: ' "$CHECK_HOME/artifacts/rig-record.txt" 2>/dev/null)"
raw_hash="$(printf '%s\n' "$raw_announcement" | python3 -c 'import json,sys
prefix = "Hive daemon ready: "
line = sys.stdin.read().strip()
print(json.loads(line[len(prefix):])["sourceHash"] if line.startswith(prefix) else "")')"
direct_hash="$(bun -e \
  'const { sourceBuildHash } = await import(process.argv[1]); console.log(await sourceBuildHash(process.argv[2]))' \
  "$ROOT/src/daemon/lifecycle/handshake.ts" "$ROOT")"
hash_bytes="$(printf '%s' "$announced" | wc -c | tr -d ' ')"
if [ "$hash_bytes" -eq 64 ] && [ "$announced" = "$computed" ] &&
   [ "$announced" = "$raw_hash" ] && [ "$announced" = "$direct_hash" ]; then
  pass "raw announcement and independent source hash match the recorded full hash"
else
  fail "source hashes differ: record=$hash_line raw=$raw_hash direct=$direct_hash"
fi
if [ -n "$raw_announcement" ]; then
  pass "raw startup announcement recorded"
else
  fail "raw startup announcement missing"
fi
src_sha="$(git -C "$ROOT" rev-parse HEAD)"
if grep -Fq "src=$ROOT sha=$src_sha" "$CHECK_HOME/artifacts/rig-record.txt" 2>/dev/null; then
  pass "source checkout commit recorded"
else
  fail "source checkout commit missing"
fi

bound_before="$(lsof +D "$CHECK_HOME" -t 2>/dev/null | sort -un)"
if [ "$daemon_ready" -eq 1 ] && [ -n "$bound_before" ] &&
   printf '%s\n' "$bound_before" | grep -qx "$daemon_pid" &&
   printf '%s\n' "$bound_before" | grep -qx "$owner_pid"; then
  pass "binding reader saw both live rig roots"
else
  fail "binding reader missed a live rig root: $bound_before"
fi
protected_open=""
fence_env_ok=1
for bound_pid in $bound_before; do
  if lsof -n -P -a -p "$bound_pid" +D "$USER_HOME" -Fp 2>/dev/null | grep -q '^p'; then
    protected_open="$protected_open user:$bound_pid"
  fi
  if lsof -n -P -a -p "$bound_pid" +D "$DEV_HOME" -Fp 2>/dev/null | grep -q '^p'; then
    protected_open="$protected_open dev:$bound_pid"
  fi
  ps eww -p "$bound_pid" -o command= | grep -Fq "HIVE_DEFAULT_HOME=$CHECK_RESOLVED/default" \
    || fence_env_ok=0
done
default_open="$(lsof -n -P -a -p "$daemon_pid" +D "$CHECK_RESOLVED/default" -Fp 2>/dev/null | sed -n 's/^p//p')"
imported="$(default_home_holds_only_this_rig "$CHECK_HOME" 2>&1)"
imported_code=$?
if [ "$daemon_ready" -eq 1 ] && [ "$default_open" = "$daemon_pid" ] &&
   [ -f "$CHECK_HOME/default/quota.db" ] && [ -z "$protected_open" ] &&
   [ "$fence_env_ok" -eq 1 ] &&
   [ "$imported_code" -eq 0 ]; then
  pass "QA daemon is fenced from user/dev homes and imported no live database"
else
  fail "QA process reached protected state or missed its default-home fence:" \
    "protected=[$protected_open] default_open=$default_open fence_env=$fence_env_ok" \
    "imported=[$imported]"
fi

# The fence check above is an isolation control, so it is worth nothing until it
# has been seen to refuse. Each plant below violates exactly one of the three
# properties, and the clean plant proves a green verdict comes from inspecting
# the databases rather than from failing to look at them.
plant_dir="$(mktemp -d /tmp/hvqa-p.XXXXXX)" || exit 1
PLANT_HOME="$plant_dir"
mkdir -p "$plant_dir/default"
python3 - "$CHECK_HOME" "$plant_dir" <<'PY'
import os, shutil, sqlite3, sys

rig_home, plant = sys.argv[1], sys.argv[2]

def copy_database(source, target):
    # The write-ahead log has to come too: the main file of a live Hive database
    # is a single page, so copying it alone would plant an empty database and
    # the control would prove nothing. Opening the source read-only is not an
    # option either — SQLite needs to create shared memory for a WAL database
    # and fails with "unable to open database file" — so the pair is copied and
    # the COPY is checkpointed into one self-contained file.
    shutil.copy(source, target)
    if os.path.exists(source + "-wal"):
        shutil.copy(source + "-wal", target + "-wal")
    con = sqlite3.connect(target)
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    con.execute("PRAGMA journal_mode=DELETE")
    con.close()
    for suffix in ("-wal", "-shm"):
        if os.path.exists(target + suffix):
            os.remove(target + suffix)
    rows = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
    try:
        planted = rows.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
        identity = rows.execute(
            "SELECT COUNT(*) FROM meta WHERE key='databaseIdentity'").fetchone()[0]
    finally:
        rows.close()
    # A control that planted an empty or identity-less file would pass the check
    # it is supposed to break, and would look like the check working.
    if planted == 0 or identity == 0:
        raise SystemExit(
            f"plant is not a real instance database: tables={planted} identity={identity}")

# A genuinely real, populated database: this rig's own instance database, which
# has served an instance and therefore carries its identity.
copy_database(os.path.join(rig_home, "hive.db"),
              os.path.join(plant, "default", "populated.db"))

# A database that records where its state came from — a home that is not ours.
con = sqlite3.connect(os.path.join(plant, "default", "imported.db"))
con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
con.execute("INSERT INTO meta VALUES ('defaultHiveQuotaMigrationV1', ?)",
            (os.path.expanduser("~/.hive/default/hive.db"),))
con.commit()
con.close()

# A database whose history predates this home: state written before the home it
# now sits in could not have been produced here.
con = sqlite3.connect(os.path.join(plant, "default", "stale.db"))
con.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT)")
con.execute("INSERT INTO events VALUES (1, '2019-01-01T00:00:00.000Z')")
con.commit()
con.close()

# The control for the control: schema and rows this rig could have written.
con = sqlite3.connect(os.path.join(plant, "default", "native.db"))
con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
con.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT)")
con.commit()
con.close()
PY

expect_plant_refusal() {
  local label="$1" keep="$2" expected="$3" scratch out code
  scratch="$(mktemp -d /tmp/hvqa-q.XXXXXX)" || return 1
  mkdir -p "$scratch/default"
  cp "$PLANT_HOME/default/$keep" "$scratch/default/$keep"
  out="$(default_home_holds_only_this_rig "$scratch" 2>&1)"
  code=$?
  if [ "$code" -eq 0 ]; then
    fail "planted $label was ACCEPTED by the fence check"
  elif printf '%s' "$out" | grep -Fq "$expected"; then
    pass "planted $label was refused: $(printf '%s' "$out" | head -1)"
  else
    # Refused, but not for the reason under test — a crash and a correct
    # refusal both exit nonzero, and calling that a pass would be the same
    # mistake as calling it an acceptance.
    fail "planted $label was refused for the wrong reason (wanted '$expected'): $out"
  fi
  remove_scratch_tree "$scratch" || fail "could not remove plant scratch $scratch"
}

expect_plant_refusal "a real populated instance database" populated.db "databaseIdentity"
expect_plant_refusal "a database naming another Hive home" imported.db "outside this rig"
expect_plant_refusal "a database with history older than this home" stale.db "before this home existed"

native_scratch="$(mktemp -d /tmp/hvqa-q.XXXXXX)" || exit 1
mkdir -p "$native_scratch/default"
cp "$PLANT_HOME/default/native.db" "$native_scratch/default/native.db"
native_out="$(default_home_holds_only_this_rig "$native_scratch" 2>&1)"
native_code=$?
if [ "$native_code" -eq 0 ] && [ -z "$native_out" ]; then
  pass "a database this rig could have written was accepted"
else
  fail "clean plant was refused (exit $native_code): $native_out"
fi
remove_scratch_tree "$native_scratch" || fail "could not remove clean plant scratch"

empty_scratch="$(mktemp -d /tmp/hvqa-q.XXXXXX)" || exit 1
mkdir -p "$empty_scratch/default"
empty_out="$(default_home_holds_only_this_rig "$empty_scratch" 2>&1)"
empty_code=$?
if [ "$empty_code" -ne 0 ] && printf '%s' "$empty_out" | grep -Fq "nothing was inspected"; then
  pass "a default home with no database is refused rather than silently green"
else
  fail "an uninspectable default home passed (exit $empty_code): $empty_out"
fi
remove_scratch_tree "$empty_scratch" || fail "could not remove empty plant scratch"
remove_scratch_tree "$plant_dir" || fail "could not remove plant home"
if QA_HOME="$CHECK_HOME" "$RIG" down; then
  pass "down completed"
else
  fail "down failed after plain up"
fi
bound_after="$(lsof +D "$CHECK_HOME" -t 2>/dev/null | sort -un)"
if [ -z "$bound_after" ]; then
  pass "binding readback is empty after down"
else
  fail "processes remain bound after down: $bound_after"
fi

echo "[3/7] run preserves command status and always tears down"
run_out="$(QA_HOME="$CHECK_HOME" QA_PROJECT="$CHECK_REPO" QA_SKIP_POLICY=1 "$RIG" run sh -c '[ "$HIVE_QA_HOME" = "$1" ] && [ "$HIVE_QA_PROJECT" = "$2" ] || exit 3
    [ "$HIVE_HOME" = "$1" ] && [ "$HIVE_DEFAULT_HOME" = "$1/default" ] || exit 5
    case "$HIVE_QA_PORT" in ""|*[!0-9]*) exit 4;; esac
    exit 7' sh "$CHECK_RESOLVED" "$CHECK_REPO" 2>&1)"
run_code=$?
if [ "$run_code" -eq 7 ]; then
  pass "run exported coordinates and preserved command exit 7"
else
  fail "run returned $run_code instead of command exit 7: $run_out"
fi
run_bound="$(lsof +D "$CHECK_HOME" -t 2>/dev/null | sort -un)"
if [ -z "$run_bound" ]; then
  pass "run teardown readback is empty"
else
  fail "run left bound processes: $run_bound"
fi

signal_child_file="$CHECK_HOME/signal-child.pid"
rm -f "$signal_child_file"
QA_HOME="$CHECK_HOME" QA_PROJECT="$CHECK_REPO" QA_SKIP_POLICY=1 "$RIG" run \
  sh -c 'trap "exit 0" HUP INT TERM
    printf "%s\n" "$$" > "$1"
    while :; do sleep 1; done' sh "$signal_child_file" \
  > "$CHECK_HOME/signal-run.log" 2>&1 &
signal_rig_pid=$!
track_test_pid "$signal_rig_pid" || { fail "could not record signal fixture identity"; exit 1; }
signal_wait=0
while [ "$signal_wait" -lt 300 ] && [ ! -s "$signal_child_file" ]; do
  sleep 0.05
  signal_wait=$((signal_wait + 1))
done
signal_child_pid="$(sed -n '1p' "$signal_child_file" 2>/dev/null)"
if valid_pid "$signal_rig_pid" && valid_pid "$signal_child_pid" &&
   process_alive "$signal_rig_pid" && process_alive "$signal_child_pid"; then
  pass "signal-forwarding fixture reached a live run command"
else
  fail "signal-forwarding fixture did not become live"
fi
track_test_pid "$signal_child_pid" || { fail "could not record run-child identity"; exit 1; }
signal_test_pid TERM "$signal_rig_pid" \
  || fail "could not signal the recorded run fixture"
wait "$signal_rig_pid"
signal_code=$?
signal_bound="$(lsof +D "$CHECK_HOME" -t 2>/dev/null | sort -un)"
if [ "$signal_code" -eq 143 ] && ! process_alive "$signal_child_pid" &&
   [ -z "$signal_bound" ]; then
  pass "run forwarded TERM and completed teardown with exit 143"
else
  fail "run signal cleanup failed: exit=$signal_code child=$signal_child_pid bound=$signal_bound"
  sed 's/^/    /' "$CHECK_HOME/signal-run.log"
fi
forget_test_pid "$signal_rig_pid" || true
forget_test_pid "$signal_child_pid" || true

RACE_LINK="$SYMLINK_SCOPE/race-home"
ln -s "$RACE_HOME" "$RACE_LINK" || exit 1
if [ "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$RACE_LINK")" != "$RACE_RESOLVED" ]; then
  echo "rig checks: swap probe did not start on its QA target" >&2
  exit 1
fi
QA_HOME="$RACE_LINK" QA_PROJECT="$CHECK_REPO" QA_SKIP_POLICY=1 "$RIG" run \
  sh -c 'while [ ! -f "$1/go" ]; do sleep 0.05; done
    printf "%s\n" "$HIVE_QA_HOME" > "$1/consumer-home.txt"
    python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$HIVE_QA_HOME" > "$1/consumer-resolved.txt"' \
  sh "$RACE_HOME" > "$RACE_HOME/run.log" 2>&1 &
race_pid=$!
track_test_pid "$race_pid" || { fail "could not record swap fixture identity"; exit 1; }
race_wait=0
while [ "$race_wait" -lt 200 ] && [ ! -s "$RACE_HOME/daemon.port" ]; do
  sleep 0.05
  race_wait=$((race_wait + 1))
done
swap_held=0
if [ -s "$RACE_HOME/daemon.port" ]; then
  if unlink "$RACE_LINK" && ln -s "$NON_QA_TARGET" "$RACE_LINK" &&
     [ "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$RACE_LINK")" = "$NON_QA_RESOLVED" ]; then
    swap_held=1
  else
    fail "symlink-swap probe did not reach its replacement target"
  fi
else
  fail "symlink-swap probe never observed the initial QA daemon"
fi
touch "$RACE_HOME/go"
wait "$race_pid"
race_code=$?
forget_test_pid "$race_pid" || true
race_seen="$(sed -n '1p' "$RACE_HOME/consumer-home.txt" 2>/dev/null)"
race_resolved="$(sed -n '1p' "$RACE_HOME/consumer-resolved.txt" 2>/dev/null)"
if [ "$swap_held" -eq 1 ] && [ "$race_code" -eq 0 ] && [ "$race_seen" = "$RACE_RESOLVED" ] &&
   [ "$race_resolved" = "$RACE_RESOLVED" ] &&
   [ -z "$(find "$NON_QA_TARGET" -mindepth 1 -print -quit)" ]; then
  pass "run bound the resolved home across a caller-symlink swap"
else
  fail "downstream observed swapped home: exit=$race_code home=$race_seen resolved=$race_resolved"
  sed 's/^/    /' "$RACE_HOME/run.log"
  find "$NON_QA_TARGET" -mindepth 1 -print | sed 's/^/    non-QA write: /'
fi
if unlink "$RACE_LINK" && [ ! -L "$RACE_LINK" ]; then
  pass "swap-probe symlink removed inside its test scope"
else
  fail "swap-probe symlink was not removed"
fi

echo "[4/7] owned descendants are swept; foreign look-alikes, stale, and sibling processes are untouched"
python3 -c 'import time; time.sleep(600)' "bun test foreign-lookalike" &
foreign_pid=$!
track_test_pid "$foreign_pid" || { fail "could not record foreign look-alike identity"; exit 1; }
foreign_command="$(ps -ww -p "$foreign_pid" -o command= 2>/dev/null)"
if process_alive "$foreign_pid" && printf '%s\n' "$foreign_command" | grep -Fq "bun test"; then
  pass "foreign look-alike is live with the incident pattern in argv"
else
  fail "foreign look-alike positive control failed: pid=$foreign_pid command=$foreign_command"
fi
QA_TREE_HOME="$TREE_HOME" python3 - <<'PY' &
import os
import subprocess
import time

home = os.environ["QA_TREE_HOME"]
anchor = open(os.path.join(home, "anchor.log"), "a")
child = subprocess.Popen(
    ["sleep", "600"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    start_new_session=True,
)
with open(os.path.join(home, "child.pid"), "w") as handle:
    handle.write(str(child.pid))
time.sleep(600)
PY
tree_parent=$!
track_test_pid "$tree_parent" || { fail "could not record tree root identity"; exit 1; }
printf '%s\n' "$tree_parent" > "$TREE_HOME/owner.pid"
process_start "$tree_parent" > "$TREE_HOME/owner.start"
tree_wait=0
while [ "$tree_wait" -lt 50 ] && [ ! -s "$TREE_HOME/child.pid" ]; do
  sleep 0.1
  tree_wait=$((tree_wait + 1))
done
tree_child="$(sed -n '1p' "$TREE_HOME/child.pid" 2>/dev/null)"
track_test_pid "$tree_child" || { fail "could not record tree child identity"; exit 1; }
tree_child_pgid="$(ps -p "$tree_child" -o pgid= 2>/dev/null | tr -d ' ')"
tree_child_sid="$(python3 -c 'import os,sys; print(os.getsid(int(sys.argv[1])))' "$tree_child" 2>/dev/null)"
if valid_pid "$tree_parent" && valid_pid "$tree_child" &&
   [ "$tree_child" != "$tree_parent" ] && process_alive "$tree_parent" &&
   process_alive "$tree_child" && [ "$tree_child_pgid" = "$tree_child" ] &&
   [ "$tree_child_sid" = "$tree_child" ]; then
  pass "descendant fixture held a live child in its own session and process group"
else
  fail "descendant fixture was not session-separated: parent=$tree_parent child=$tree_child pgid=$tree_child_pgid sid=$tree_child_sid"
fi
if QA_HOME="$TREE_HOME" "$RIG" down; then
  wait "$tree_parent" 2>/dev/null || true
  if ! process_alive "$tree_parent" && ! process_alive "$tree_child" &&
     process_alive "$foreign_pid"; then
    pass "owned root and separate-session child were swept; foreign look-alike survived"
  else
    fail "teardown ownership mismatch: parent=$tree_parent child=$tree_child foreign=$foreign_pid"
  fi
else
  fail "down failed while sweeping the owned process tree"
fi
forget_test_pid "$tree_parent" || true
forget_test_pid "$tree_child" || true
signal_test_pid TERM "$foreign_pid" || true
wait "$foreign_pid" 2>/dev/null || true
forget_test_pid "$foreign_pid" || true

python3 - "$TREE_HOME/stale-bound.log" <<'PY' &
import sys
import time

handle = open(sys.argv[1], "a")
time.sleep(600)
PY
stale_bound_pid=$!
track_test_pid "$stale_bound_pid" || { fail "could not record bound stale fixture identity"; exit 1; }
printf '%s\n' "$stale_bound_pid" > "$TREE_HOME/daemon.pid"
printf '0:0\n' > "$TREE_HOME/daemon.start"
sleep 0.2
stale_bound_before="$(lsof +D "$TREE_HOME" -t 2>/dev/null | sort -un)"
stale_bound_out="$(QA_HOME="$TREE_HOME" "$RIG" down 2>&1)"
stale_bound_code=$?
if printf '%s\n' "$stale_bound_before" | grep -qx "$stale_bound_pid" &&
   [ "$stale_bound_code" -ne 0 ] &&
   printf '%s' "$stale_bound_out" | grep -q "$stale_bound_pid" &&
   process_alive "$stale_bound_pid"; then
  pass "a bound PID with the wrong start token was named but not signalled"
else
  fail "start-token guard did not isolate bound PID $stale_bound_pid (exit $stale_bound_code): $stale_bound_out"
fi
signal_test_pid KILL "$stale_bound_pid" || true
wait "$stale_bound_pid" 2>/dev/null || true
forget_test_pid "$stale_bound_pid" || true
if QA_HOME="$TREE_HOME" "$RIG" down >/dev/null 2>&1; then
  pass "stale bound fixture became clean after its process was removed"
else
  fail "stale bound fixture left uncleared rig state"
fi

sleep 600 &
unbound_pid=$!
track_test_pid "$unbound_pid" || { fail "could not record unbound fixture identity"; exit 1; }
printf '%s\n' "$unbound_pid" > "$TREE_HOME/daemon.pid"
process_start "$unbound_pid" > "$TREE_HOME/daemon.start"
unbound_before="$(lsof +D "$TREE_HOME" -t 2>/dev/null | sort -un)"
if ! printf '%s\n' "$unbound_before" | grep -qx "$unbound_pid" &&
   QA_HOME="$TREE_HOME" "$RIG" down >/dev/null 2>&1 &&
   process_alive "$unbound_pid"; then
  pass "a start-matched PID without a QA-home binding was not signalled"
else
  fail "binding guard did not isolate unbound PID $unbound_pid"
fi
signal_test_pid TERM "$unbound_pid" || true
wait "$unbound_pid" 2>/dev/null || true
forget_test_pid "$unbound_pid" || true

sibling_file="$SIBLING_HOME/anchor.log"
python3 - "$sibling_file" <<'PY' &
import sys
import time

handle = open(sys.argv[1], "a")
time.sleep(600)
PY
sibling_pid=$!
track_test_pid "$sibling_pid" || { fail "could not record sibling fixture identity"; exit 1; }
sleep 0.2
if QA_HOME="$TREE_HOME" "$RIG" down >/dev/null 2>&1 && process_alive "$sibling_pid"; then
  pass "one QA home did not signal a process bound to its prefix-named sibling"
else
  fail "sibling QA process was signalled by the wrong home"
fi
signal_test_pid TERM "$sibling_pid" || true
wait "$sibling_pid" 2>/dev/null || true
forget_test_pid "$sibling_pid" || true

python3 - "$RIG" "$TREE_HOME" <<'PY' &
import os
import subprocess
import sys
import time

rig, home = sys.argv[1:]
os.chdir(home)
with open("ancestor.pid", "w") as handle:
    handle.write(str(os.getpid()))
while not os.path.exists("ancestor.ready"):
    time.sleep(0.01)
result = subprocess.run(
    [rig, "down"],
    env={**os.environ, "QA_HOME": home},
    capture_output=True,
    text=True,
)
with open("ancestor.out", "w") as handle:
    handle.write(result.stdout)
    handle.write(result.stderr)
with open("ancestor.code", "w") as handle:
    handle.write(str(result.returncode))
PY
ancestor_fixture_pid=$!
track_test_pid "$ancestor_fixture_pid" || { fail "could not record invoker fixture identity"; exit 1; }
ancestor_wait=0
while [ "$ancestor_wait" -lt 200 ] && [ ! -s "$TREE_HOME/ancestor.pid" ]; do
  sleep 0.05
  ancestor_wait=$((ancestor_wait + 1))
done
ancestor_pid="$(sed -n '1p' "$TREE_HOME/ancestor.pid" 2>/dev/null)"
printf '%s\n' "$ancestor_pid" > "$TREE_HOME/daemon.pid"
process_start "$ancestor_pid" > "$TREE_HOME/daemon.start"
ancestor_bound_before="$(lsof +D "$TREE_HOME" -t 2>/dev/null | sort -un)"
touch "$TREE_HOME/ancestor.ready"
wait "$ancestor_fixture_pid"
ancestor_fixture_code=$?
ancestor_code="$(sed -n '1p' "$TREE_HOME/ancestor.code" 2>/dev/null)"
ancestor_out="$(cat "$TREE_HOME/ancestor.out" 2>/dev/null)"
if valid_pid "$ancestor_pid" && [ "$ancestor_pid" = "$ancestor_fixture_pid" ] &&
   printf '%s\n' "$ancestor_bound_before" | grep -qx "$ancestor_pid" &&
   [ "$ancestor_fixture_code" -eq 0 ] && [ "$ancestor_code" -ne 0 ] &&
   printf '%s' "$ancestor_out" | grep -q "$ancestor_pid"; then
  pass "a fully authorized invoker ancestor stayed visible and made down fail"
else
  fail "invoker ancestor was hidden or signalled (pid=$ancestor_pid fixture=$ancestor_fixture_code down=$ancestor_code): $ancestor_out"
fi
forget_test_pid "$ancestor_fixture_pid" || true

echo "[5/7] an unrecorded TERM-ignoring binding makes down fail"
QA_LEAK_HOME="$CHECK_HOME" python3 - <<'PY' &
import os
import signal
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
handle = open(os.path.join(os.environ["QA_LEAK_HOME"], "daemon.log"))
time.sleep(600)
PY
leak_pid=$!
track_test_pid "$leak_pid" || { fail "could not record leak fixture identity"; exit 1; }
sleep 0.2
leak_bound_before="$(lsof +D "$CHECK_HOME" -t 2>/dev/null | sort -un)"
leak_out="$(QA_HOME="$CHECK_HOME" "$RIG" down 2>&1)"
leak_code=$?
if printf '%s\n' "$leak_bound_before" | grep -qx "$leak_pid" &&
   [ "$leak_code" -ne 0 ] && printf '%s' "$leak_out" | grep -q "$leak_pid" &&
   process_alive "$leak_pid"; then
  pass "down failed, named, and left the deliberate TERM-ignoring leak alive"
else
  fail "down did not expose deliberate leak $leak_pid (exit $leak_code): $leak_out"
fi
signal_test_pid KILL "$leak_pid" || true
wait "$leak_pid" 2>/dev/null || true
forget_test_pid "$leak_pid" || true
if QA_HOME="$CHECK_HOME" "$RIG" down >/dev/null 2>&1; then
  pass "down became clean after the deliberate leak was removed"
else
  fail "down stayed red after leak cleanup"
fi

echo "[6/7] default target is hive-test-project"
before_state="$(git -C "$DEFAULT_PROJECT" status --porcelain)"
# QA_SRC_ROOT is stripped rather than merely left unset: this leg exists to
# exercise the DEFAULT source root, and inheriting an ambient override from the
# caller is how that path went untested while the tree moved under it.
default_out="$(env -u QA_SRC_ROOT QA_HOME="$DEFAULT_HOME" "$RIG" up 2>&1)"
default_code=$?
# The resolved source root is published in the coordinates, not on stdout, and
# the coordinates are what every consumer reads.
default_source="$(sed -n 's/^source=//p' "$DEFAULT_HOME/artifacts/coordinates.txt" 2>/dev/null)"
if [ "$default_code" -eq 0 ] && [ "$default_source" = "$ROOT" ]; then
  pass "up with no QA_SRC_ROOT resolved its own checkout ($ROOT)"
else
  fail "default source root was '${default_source:-none}', expected $ROOT (exit $default_code)"
fi
if [ "$default_code" -eq 0 ] &&
   printf '%s' "$default_out" | grep -Fq "project=$DEFAULT_PROJECT"; then
  pass "default up aimed at hive-test-project and printed its coordinates"
else
  fail "default-target up failed (exit $default_code): $default_out"
fi
if QA_HOME="$DEFAULT_HOME" "$RIG" down >/dev/null 2>&1; then
  pass "default-target down is clean"
else
  fail "default-target down failed"
fi
after_state="$(git -C "$DEFAULT_PROJECT" status --porcelain)"
if [ "$before_state" = "$after_state" ]; then
  pass "hive-test-project working tree unchanged"
else
  fail "hive-test-project working tree changed"
fi

echo "[7/7] the checkout root is derived and validated, never assumed"
# Every script in this tree gets its root from qa_repo_root. A root that is
# merely wrong is the dangerous case: it is passed to the daemon, the CLI and
# the u5 isolation gate, so it must refuse rather than answer. Both directions
# are exercised, because "the resolver said no" and "the resolver never ran"
# look identical from a single failing call.
if resolved="$(qa_repo_root "$QA_DIR")" && [ "$resolved" = "$ROOT" ]; then
  pass "resolver found this checkout from the QA tree ($resolved)"
else
  fail "resolver did not find this checkout from $QA_DIR (got '${resolved:-}')"
fi
WRONG_ROOT="$(mktemp -d /tmp/hvqa-wrongroot.XXXXXX)" || exit 1
mkdir -p "$WRONG_ROOT/docs/qa" || exit 1
# A tree that looks like the QA tree and sits under no checkout at all. This is
# the shape the move created: docs/ has neither package.json nor src/cli.ts.
if wrong="$(qa_repo_root "$WRONG_ROOT/docs/qa" 2>/dev/null)"; then
  fail "resolver accepted a directory under no checkout and returned '$wrong'"
else
  pass "resolver refused a directory under no checkout"
fi
# Captured rather than piped: under `set -o pipefail` the refusal's own nonzero
# status would fail the pipeline even when grep matched, and the check would
# report the opposite of what it measured.
wrong_message="$(qa_repo_root "$WRONG_ROOT/docs/qa" 2>&1 || true)"
case "$wrong_message" in
  *package.json*src/cli.ts*) pass "refusal names the marker it looked for" ;;
  *) fail "refusal did not name the marker: '$wrong_message'" ;;
esac
rm -rf "$WRONG_ROOT"

echo "[8/8] sessiond is resolved from QA_SRC_ROOT; a missing broker is a named refusal"
# The primary checkout has a staged sessiond. If the default still pointed
# there, bring-up would get past this check against last week's broker. The
# inverted control is that that binary exists and is still not used.
SESSIOND_HOME="$(mktemp -d /tmp/hvqa-sd.XXXXXX)" || exit 1
FAKE_SRC="$(mktemp -d /tmp/hvqa-src.XXXXXX)" || exit 1
mkdir -p "$FAKE_SRC/src" || exit 1
PRIMARY_SESSIOND="$PRIMARY_CHECKOUT/native/sessiond/zig-out/bin/hive-sessiond"
SRC_SESSIOND="$FAKE_SRC/native/sessiond/zig-out/bin/hive-sessiond"
if [ ! -x "$PRIMARY_SESSIOND" ]; then
  fail "inverted control missing: primary checkout has no sessiond at $PRIMARY_SESSIOND"
else
  sessiond_out="$(env -u QA_SESSIOND_BIN QA_SRC_ROOT="$FAKE_SRC" \
    QA_HOME="$SESSIOND_HOME" QA_PROJECT="$CHECK_REPO" "$RIG" up 2>&1)"
  sessiond_code=$?
  if [ "$sessiond_code" -eq 2 ] &&
     printf '%s' "$sessiond_out" | grep -Fq "$SRC_SESSIOND" &&
     ! printf '%s' "$sessiond_out" | grep -Fq "$PRIMARY_SESSIOND"; then
    pass "missing source-tree sessiond refused by name ($SRC_SESSIOND)"
  else
    fail "missing source-tree sessiond was not refused by name (exit $sessiond_code): $sessiond_out"
  fi
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "RIG CHECKS OK — all legs held"
  exit 0
fi
echo "RIG CHECKS FAIL — $failures leg(s) failed"
exit 1
