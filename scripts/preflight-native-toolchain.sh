#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$ROOT/.cache/native"}

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--production" ]; }; then
  echo "usage: $0 [--production]" >&2
  exit 2
fi
"$ROOT/scripts/validate-native-toolchain-lock.sh" "$@"

lock_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK"
}

assert_equal() {
  label=$1
  expected=$2
  actual=$3
  if [ "$actual" != "$expected" ]; then
    echo "$label: expected '$expected', found '$actual'" >&2
    exit 1
  fi
}

assert_equal "Xcode version" "$(lock_value apple.xcode)" "$(xcodebuild -version | /usr/bin/awk 'NR == 1 { print $2 }')"
assert_equal "Xcode build" "$(lock_value apple.build)" "$(xcodebuild -version | /usr/bin/awk 'NR == 2 { print $3 }')"
assert_equal "Swift version" "$(lock_value apple.swift)" "$(swift --version 2>&1 | /usr/bin/sed -n 's/.*Apple Swift version \([^ ]*\).*/\1/p' | /usr/bin/head -1)"
assert_equal "Bun version" "$(lock_value bun)" "$(bun --version)"

case "$(uname -m)" in
  arm64) zig_dir="zig-aarch64-macos-$(lock_value zig.version)" ;;
  x86_64) zig_dir="zig-x86_64-macos-$(lock_value zig.version)" ;;
  *) echo "unsupported build host architecture: $(uname -m)" >&2; exit 1 ;;
esac
ZIG="$CACHE/zig/toolchains/$zig_dir/zig"
if [ ! -x "$ZIG" ]; then
  echo "locked Zig is not provisioned; run scripts/provision-native-toolchain.sh" >&2
  exit 1
fi
assert_equal "Zig version" "$(lock_value zig.version)" "$("$ZIG" version)"

for lock_arch in arm64 x86_64; do
  url=$(lock_value "zig.${lock_arch}Url")
  archive="$CACHE/zig/archives/${url##*/}"
  expected=$(lock_value "zig.${lock_arch}Sha256")
  if [ ! -f "$archive" ]; then
    echo "locked Zig $lock_arch archive is absent from the offline cache" >&2
    exit 1
  fi
  actual=$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{ print $1 }')
  assert_equal "Zig $lock_arch archive SHA-256" "$expected" "$actual"
done

for sdk in macosx iphoneos iphonesimulator; do
  if ! xcrun --sdk "$sdk" --show-sdk-path >/dev/null 2>&1; then
    echo "required Apple SDK is unavailable: $sdk" >&2
    exit 1
  fi
done

component=$(mktemp "${TMPDIR:-/tmp}/hive-metal-component.XXXXXX")
trap 'rm -f "$component"' EXIT HUP INT TERM
if ! xcodebuild -showComponent MetalToolchain -json >"$component" 2>/dev/null; then
  echo "Metal Toolchain is not installed. Exact external provisioning command:" >&2
  echo "  xcodebuild -downloadComponent MetalToolchain" >&2
  exit 1
fi
status=$(/usr/bin/plutil -extract status raw -o - "$component")
identifier=$(/usr/bin/plutil -extract toolchainIdentifier raw -o - "$component")
if [ "$status" != "installed" ] || ! xcrun --toolchain "$identifier" metal --version >/dev/null 2>&1; then
  echo "Metal Toolchain is not usable. Exact external provisioning command:" >&2
  echo "  xcodebuild -downloadComponent MetalToolchain" >&2
  exit 1
fi

bun "$ROOT/scripts/ghostty-dependency-cache.ts" verify "$ZIG" \
  "$CACHE/zig-global" "$ROOT/vendor/ghostty/build.zig.zon.json"

echo "native preflight passed: TOOLCHAINS=$identifier ZIG=$ZIG"
