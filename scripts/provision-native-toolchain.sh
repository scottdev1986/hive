#!/bin/sh
set -eu

# Provisions the shared native build prerequisites that are NOT the compiler:
# the Metal toolchain check and the hash-verified Ghostty dependency cache
# (which lets the GhosttyKit artifact build run fully offline). The Zig
# compiler itself is the system `zig` on PATH, pinned by the lock and
# enforced by scripts/preflight-native-toolchain.sh and by
# native/sessiond/build.zig's version gate.

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$HOME/.cache/hive/native"}

"$ROOT/scripts/validate-native-toolchain-lock.sh"
mkdir -p "$CACHE"

lock_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK"
}

ZIG=$(command -v zig) || {
  echo "zig is not on PATH; install Zig $(lock_value zig.version) (brew install zig@0.15 && brew link --force zig@0.15)" >&2
  exit 1
}
if [ "$("$ZIG" version)" != "$(lock_value zig.version)" ]; then
  echo "zig on PATH is $("$ZIG" version); the lock requires $(lock_value zig.version) (brew install zig@0.15 && brew link --force zig@0.15)" >&2
  exit 1
fi

component=$(mktemp "${TMPDIR:-/tmp}/hive-metal-component.XXXXXX")
trap 'rm -f "$component"' EXIT HUP INT TERM
if ! xcodebuild -showComponent MetalToolchain -json >"$component" 2>/dev/null; then
  echo "Metal Toolchain is not installed. Run, but do not run from automation:" >&2
  echo "  xcodebuild -downloadComponent MetalToolchain" >&2
  exit 1
fi
status=$(/usr/bin/plutil -extract status raw -o - "$component")
identifier=$(/usr/bin/plutil -extract toolchainIdentifier raw -o - "$component")
if [ "$status" != "installed" ] || ! xcrun --toolchain "$identifier" metal --version >/dev/null 2>&1; then
  echo "Metal Toolchain is installed but unusable. Run, but do not run from automation:" >&2
  echo "  xcodebuild -downloadComponent MetalToolchain" >&2
  exit 1
fi
echo "verified installed Metal Toolchain: $identifier"

bun "$ROOT/scripts/ghostty-dependency-cache.ts" fetch "$ZIG" \
  "$CACHE/zig-global" "$ROOT/vendor/ghostty/build.zig.zon.json"

echo "native prerequisites provisioned in $CACHE"
