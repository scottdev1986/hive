#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$HOME/.cache/hive/native"}

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

# The build uses the system `zig` on PATH; the lock pins the exact version.
ZIG=$(command -v zig) || {
  echo "zig is not on PATH; install Zig $(lock_value zig.version) (brew install zig@0.15 && brew link --force zig@0.15)" >&2
  exit 1
}
assert_equal "Zig version" "$(lock_value zig.version)" "$("$ZIG" version)"

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
