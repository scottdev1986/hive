#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$HOME/.cache/hive/native"}

if [[ "${1:-}" == "--verify" ]]; then
  verify_only=1
  shift
else
  verify_only=0
fi
if [[ $# -ne 0 ]]; then
  echo "usage: $0 [--verify]" >&2
  exit 2
fi

lock_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK"
}

host_arch=$(uname -m)
case "$host_arch" in
  arm64|x86_64) ;;
  *) echo "unsupported host architecture: $host_arch" >&2; exit 1 ;;
esac

artifact="$CACHE/artifacts/ghostty-$(lock_value ghostty.commit)-zig-$(lock_value zig.version)"
framework_source="$artifact/GhosttyKit.xcframework"
fixtures_source="$artifact/checkpoint-fixtures"
vendor="$ROOT/workspace/Vendor"
framework_destination="$vendor/GhosttyKit.xcframework"
fixtures_destination="$vendor/checkpoint-fixtures"

mac_archive() {
  local framework=$1 plist index identifier binary
  plist="$framework/Info.plist"
  [[ -f "$plist" ]] || return 1
  index=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries" "$plist" \
    | /usr/bin/awk '/Dict {/ { idx++ } /SupportedPlatform = macos/ { print idx - 1; found=1 } END { if (!found) exit 1 }') || return 1
  identifier=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$index:LibraryIdentifier" "$plist") || return 1
  binary=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$index:BinaryPath" "$plist") || return 1
  printf '%s/%s/%s\n' "$framework" "$identifier" "$binary"
}

validate_manifest_files() {
  local expected relative actual
  while IFS=$'\t' read -r expected relative; do
    [[ -n "$relative" && -f "$artifact/$relative" ]] || return 1
    actual=$(/usr/bin/shasum -a 256 "$artifact/$relative" | /usr/bin/awk '{ print $1 }')
    [[ "$actual" == "$expected" ]] || return 1
  done < <(
    /usr/bin/plutil -convert json -o - "$artifact/artifact-manifest.json" \
      | /usr/bin/jq -r '.files[] | select(.path | startswith("GhosttyKit.xcframework/") or startswith("checkpoint-fixtures/")) | "\(.sha256)\t\(.path)"'
  )
}

validate_artifact() {
  local archive
  "$ROOT/scripts/native/ghostty-artifact-lock-check.sh" "$artifact" "$LOCK" || return 1
  validate_manifest_files || return 1
  archive=$(mac_archive "$framework_source") || return 1
  [[ -f "$archive" ]] || return 1
  /usr/bin/file "$archive" | /usr/bin/grep -q 'ar archive' || return 1
  /usr/bin/lipo "$archive" -verify_arch "$host_arch" || return 1
  [[ $(/usr/bin/head -c 8 "$fixtures_source/$host_arch/corpus.hvg6") == "HVG6C001" ]] || return 1
  [[ $(/usr/bin/head -c 8 "$fixtures_source/$host_arch/case-00-split-000.hvgcp") == "HVGCP001" ]] || return 1
}

validate_stage() {
  local source_archive destination_archive
  source_archive=$(mac_archive "$framework_source") || return 1
  destination_archive=$(mac_archive "$framework_destination") || return 1
  [[ -f "$destination_archive" ]] || return 1
  /usr/bin/file "$destination_archive" | /usr/bin/grep -q 'ar archive' || return 1
  /usr/bin/lipo "$destination_archive" -verify_arch "$host_arch" || return 1
  /usr/bin/cmp -s "$source_archive" "$destination_archive" || return 1
  /usr/bin/diff -qr "$fixtures_source" "$fixtures_destination" >/dev/null 2>&1
}

if ! validate_artifact; then
  if [[ $verify_only -eq 1 ]]; then
    echo "GhosttyKit cache artifact is missing or invalid: $artifact; run scripts/native/build-ghosttykit.sh" >&2
    exit 1
  fi
  "$ROOT/scripts/native/build-ghosttykit.sh"
  if ! validate_artifact; then
    echo "GhosttyKit build did not produce a host-usable framework and Gate 6 fixtures: $artifact" >&2
    exit 1
  fi
fi

if validate_stage; then
  echo "GhosttyKit and checkpoint fixtures are staged for SwiftPM"
  exit 0
fi
if [[ $verify_only -eq 1 ]]; then
  echo "GhosttyKit staging is missing or differs from the validated cache; run scripts/native/stage-ghosttykit.sh" >&2
  exit 1
fi

mkdir -p "$vendor"
staging=$(mktemp -d "$vendor/.ghostty-stage.XXXXXX")
trap '/bin/rm -rf "$staging"' EXIT HUP INT TERM
/usr/bin/ditto "$framework_source" "$staging/GhosttyKit.xcframework"
/usr/bin/ditto "$fixtures_source" "$staging/checkpoint-fixtures"
framework_destination="$staging/GhosttyKit.xcframework"
fixtures_destination="$staging/checkpoint-fixtures"
if ! validate_stage; then
  echo "GhosttyKit staging content verification failed: $staging" >&2
  exit 1
fi
framework_destination="$vendor/GhosttyKit.xcframework"
fixtures_destination="$vendor/checkpoint-fixtures"
/bin/rm -rf "$framework_destination" "$fixtures_destination"
/bin/mv "$staging/GhosttyKit.xcframework" "$framework_destination"
/bin/mv "$staging/checkpoint-fixtures" "$fixtures_destination"
trap - EXIT HUP INT TERM
echo "staged GhosttyKit and checkpoint fixtures for SwiftPM"
