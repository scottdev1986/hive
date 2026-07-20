#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$HOME/.cache/hive/native"}
EVIDENCE=${1:-"$ROOT/raw/qualification/ghostty-reproducibility"}
RUNS=${2:-3}

if [[ "$RUNS" -lt 3 ]]; then
  echo "at least three clean builds are required" >&2
  exit 2
fi

lock_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK"
}

commit=$(lock_value ghostty.commit)
ARTIFACT="$CACHE/artifacts/ghostty-$commit-zig-$(lock_value zig.version)"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-repro.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$EVIDENCE"

hash_shipped() {
  local output=$1
  {
    printf '%s\n' 'set=GhosttyKit.xcframework lib-vt notices sbom.cdx.json'
    (
      cd "$ARTIFACT"
      find GhosttyKit.xcframework lib-vt notices -type f -print \
        | LC_ALL=C /usr/bin/sort
    ) | while IFS= read -r relative; do
      (cd "$ARTIFACT" && /usr/bin/shasum -a 256 "$relative")
    done
    (cd "$ARTIFACT" && /usr/bin/shasum -a 256 sbom.cdx.json)
  } >"$output"
}

capture_run() {
  local label=$1
  echo "clean build $label/$RUNS"
  "$ROOT/scripts/build-ghosttykit.sh" \
    >"$EVIDENCE/clean-build-$label.txt" 2>&1
  /bin/cp "$ARTIFACT/artifact-manifest.json" \
    "$EVIDENCE/repro-build-$label-manifest.json"
  hash_shipped "$EVIDENCE/shipped-runtime-$label.sha256"
  /usr/bin/rsync -a "$ARTIFACT/checkpoint-fixtures/" \
    "$TMP/checkpoint-$label/"
}

capture_run a
capture_run b
capture_run c

/usr/bin/grep -E 'headless checkpoint harness: all checks passed|checkpoint engine build id' \
  "$EVIDENCE/clean-build-c.txt" >"$EVIDENCE/native-build-id-harness.txt"

if ! /usr/bin/cmp -s "$EVIDENCE/shipped-runtime-a.sha256" \
  "$EVIDENCE/shipped-runtime-b.sha256" || \
   ! /usr/bin/cmp -s "$EVIDENCE/shipped-runtime-b.sha256" \
  "$EVIDENCE/shipped-runtime-c.sha256"; then
  echo "shipped runtime artifacts are not reproducible" >&2
  exit 1
fi

jq -r '.files[] | [.path, .sha256, .size, .type] | @tsv' \
  "$EVIDENCE/repro-build-b-manifest.json" >"$TMP/manifest-b.tsv"
jq -r '.files[] | [.path, .sha256, .size, .type] | @tsv' \
  "$EVIDENCE/repro-build-c-manifest.json" >"$TMP/manifest-c.tsv"
diff -u --label build-b-files --label build-c-files \
  "$TMP/manifest-b.tsv" "$TMP/manifest-c.tsv" \
  >"$EVIDENCE/reproducibility-file-hash.diff" || test $? -eq 1

fixture_paths="$TMP/fixture-paths.txt"
: >"$fixture_paths"
while IFS= read -r relative_fixture; do
  if ! /usr/bin/cmp -s "$TMP/checkpoint-a/$relative_fixture" \
    "$TMP/checkpoint-b/$relative_fixture" || \
     ! /usr/bin/cmp -s "$TMP/checkpoint-b/$relative_fixture" \
    "$TMP/checkpoint-c/$relative_fixture"; then
    printf '%s\n' "$relative_fixture" >>"$fixture_paths"
  fi
done < <(
  cd "$TMP/checkpoint-a"
  find . -type f -print | sed 's#^\./##' | LC_ALL=C sort
)

byte_at() {
  local file=$1
  local offset=$2
  /usr/bin/od -An -tu1 -j "$offset" -N 1 "$file" | tr -d '[:space:]'
}

archive_path_refs=0
while IFS= read -r archive; do
  refs=$(/usr/bin/strings "$archive" | /usr/bin/grep -F -o "$ROOT" | wc -l || true)
  archive_path_refs=$((archive_path_refs + refs))
done < <(find "$ARTIFACT/GhosttyKit.xcframework" "$ARTIFACT/lib-vt" \
  -type f -name '*.a' -print | LC_ALL=C sort)

{
  printf 'status=qualified_shipped_runtime_artifacts_byte_identical\n'
  printf 'build_count=%s\n' "$RUNS"
  printf 'shipped_runtime_set=GhosttyKit.xcframework,lib-vt,notices,sbom.cdx.json\n'
  printf 'gate6_fixture_handoff=B1.4_gate6_checkpoint_serialization\n'
  printf 'fixture_difference_count=%s\n' "$(wc -l <"$fixture_paths" | tr -d ' ')"
  printf 'fixture_differences_zero_based=\n'
  while IFS= read -r relative_fixture; do
    old="$TMP/checkpoint-a/$relative_fixture"
    middle="$TMP/checkpoint-b/$relative_fixture"
    new="$TMP/checkpoint-c/$relative_fixture"
    difference=$(cmp -l "$old" "$middle" 2>/dev/null | head -n 1 || true)
    if [[ -z "$difference" ]]; then
      difference=$(cmp -l "$middle" "$new" 2>/dev/null | head -n 1 || true)
    fi
    if [[ -z "$difference" ]]; then
      difference=$(cmp -l "$old" "$new" 2>/dev/null | head -n 1 || true)
    fi
    read -r one_based old_byte new_byte <<<"$difference"
    # cmp reports byte values in octal; decode them before validating the
    # decimal bytes read from each of the three snapshots.
    old_decimal=$((8#$old_byte))
    new_decimal=$((8#$new_byte))
    offset=$((one_based - 1))
    if [[ "$(byte_at "$old" "$offset")" -ne "$old_decimal" &&
      "$(byte_at "$middle" "$offset")" -ne "$old_decimal" ]]; then
      echo "cmp byte conversion mismatch for $relative_fixture" >&2
      exit 1
    fi
    if [[ "$(byte_at "$middle" "$offset")" -ne "$new_decimal" &&
      "$(byte_at "$new" "$offset")" -ne "$new_decimal" ]]; then
      echo "cmp byte conversion mismatch for $relative_fixture" >&2
      exit 1
    fi
    printf 'checkpoint-fixtures/%s offset=%s a=0x%02X b=0x%02X c=0x%02X nondeterministic=true\n' \
      "$relative_fixture" "$offset" \
      "$(byte_at "$old" "$offset")" \
      "$(byte_at "$middle" "$offset")" \
      "$(byte_at "$new" "$offset")"
  done <"$fixture_paths"
  printf 'path_independence=known_limitation\n'
  printf 'static_archive_absolute_build_path_references=%s\n' "$archive_path_refs"
  printf 'path_independence_scope=Gate4_follow_up; runtime artifacts reproduce at the fixed content-addressed build path\n'
} >"$EVIDENCE/reproducibility-gap.txt"

echo "shipped runtime reproducibility qualified; evidence: $EVIDENCE"
