#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$ROOT/.cache/native"}
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
case "$(uname -m)" in
  arm64) zig_sha=$(lock_value zig.arm64Sha256) ;;
  x86_64) zig_sha=$(lock_value zig.x86_64Sha256) ;;
  *) echo "unsupported reproducibility host: $(uname -m)" >&2; exit 2 ;;
esac
ARTIFACT="$CACHE/artifacts/ghostty-$commit-zig-$zig_sha"
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
      /usr/bin/shasum -a 256 "$ARTIFACT/$relative"
    done
    /usr/bin/shasum -a 256 "$ARTIFACT/sbom.cdx.json"
  } >"$output"
}

capture_run() {
  local label=$1
  echo "clean build $label/$RUNS"
  "$ROOT/scripts/build-ghosttykit.sh" \
    >"$EVIDENCE/clean-build-$label.log" 2>&1
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
  "$EVIDENCE/clean-build-c.log" >"$EVIDENCE/native-build-id-harness.txt"

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

{
  printf 'status=qualified_shipped_runtime_artifacts_byte_identical\n'
  printf 'build_count=%s\n' "$RUNS"
  printf 'shipped_runtime_set=GhosttyKit.xcframework,lib-vt,notices,sbom.cdx.json\n'
  printf 'gate6_fixture_handoff=B1.4_gate6_checkpoint_serialization\n'
  printf 'fixture_differences_zero_based=\n'
  while IFS= read -r fixture; do
    relative_fixture=${fixture#checkpoint-fixtures/}
    old="$TMP/checkpoint-b/$relative_fixture"
    new="$TMP/checkpoint-c/$relative_fixture"
    if ! /usr/bin/cmp -s "$old" "$new"; then
      /usr/bin/cmp -l "$old" "$new" | while read -r offset old_byte new_byte; do
        printf '%s offset=%s old=0x%02X new=0x%02X\n' \
          "$fixture" "$((offset - 1))" "$old_byte" "$new_byte"
      done
    fi
  done < <(
    /usr/bin/awk -F '\t' '$1 ~ /^checkpoint-fixtures\// { print $1 }' \
      "$TMP/manifest-b.tsv" \
      | while IFS= read -r fixture; do
          relative_fixture=${fixture#checkpoint-fixtures/}
          if ! /usr/bin/cmp -s "$TMP/checkpoint-b/$relative_fixture" \
            "$TMP/checkpoint-c/$relative_fixture"; then
            printf '%s\n' "$fixture"
          fi
        done
  )
} >"$EVIDENCE/reproducibility-gap.txt"

echo "shipped runtime reproducibility qualified; evidence: $EVIDENCE"
