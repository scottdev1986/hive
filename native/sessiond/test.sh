#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CACHE=${HIVE_NATIVE_CACHE:-"$HOME/.cache/hive/native"}
# Local zig caches are per-checkout: concurrent worktrees sharing one local cache land on the same content-addressed manifest files and serialize on zig's blocking flock, which has no timeout — runs hang silently instead of failing. The global cache below stays shared; fetched packages are immutable and sharing them is what keeps a fresh worktree warm.
CHECKOUT_KEY=$(printf '%s' "$ROOT" | /usr/bin/shasum | /usr/bin/cut -c1-12)
LOCAL_CACHE="$CACHE/zig-local/checkout-$CHECKOUT_KEY"
LOCK="$ROOT/native/toolchain-lock.json"
VERSION=$(/usr/bin/plutil -extract zig.version raw -o - "$LOCK")

"$ROOT/scripts/native/preflight-native-toolchain.sh"

ZIG=zig
case "$(uname -m)" in
  arm64) TARGET=aarch64-macos.14.0 ;;
  x86_64) TARGET=x86_64-macos.14.0 ;;
  *)
    echo "unsupported build host architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

OVERLAY=$("$ROOT/scripts/native/prepare-zig-xcode-overlay.sh")
PATH="$ROOT/scripts/native/zig-runner-tools:$PATH"
export PATH

ABI_TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-sessiond-abi.XXXXXX")
trap 'rm -rf "$ABI_TMP"' EXIT HUP INT TERM
/usr/bin/clang -std=c11 -Wall -Wextra -Werror -o "$ABI_TMP/checkpoint-envelope" \
  "$ROOT/native/tests/abi/checkpoint-envelope.c"
HVTCP001_FIXTURE_PATH="$ROOT/native/tests/abi/hvtcp001-header.bin" \
  "$ABI_TMP/checkpoint-envelope"
if [ ! -f "$ROOT/vendor/ghostty/include/ghostty.h" ]; then
  echo "missing required Ghostty header for header-standalone ABI check: $ROOT/vendor/ghostty/include/ghostty.h" >&2
  exit 1
fi
env -u CPATH -u C_INCLUDE_PATH -u CPLUS_INCLUDE_PATH \
  /usr/bin/clang -std=c11 -Weverything -Werror -Wno-poison-system-directories -Wno-padded \
  -fsyntax-only \
  -I "$ROOT/native/include" -isystem "$ROOT/vendor/ghostty/include" \
  "$ROOT/native/tests/abi/header-standalone.c"
echo "header-standalone ABI check passed"

# Recovery compatibility is build-configuration-sensitive. The production ReleaseFast C ABI must read the immediately preceding on-disk checkpoint, while Debug/non-C-ABI layouts must reject that ID. Keep both assertions in this standard gate so deleting the acceptsBuildId configuration fence is a measured failure rather than a green Ghostty-only unit-test mutation.
cd "$ROOT/vendor/ghostty"
if ! checkpoint_debug_summary=$("$ZIG" build --cache-dir "$LOCAL_CACHE/ghostty-checkpoint-debug" \
  --global-cache-dir "$CACHE/zig-global" \
  test-lib-vt -Dtarget="$TARGET" --sysroot "$OVERLAY" \
  -Dtest-filter="legacy build id is rejected outside its exact production configuration" \
  --summary all 2>&1); then
  printf '%s\n' "$checkpoint_debug_summary" >&2
  exit 1
fi
printf '%s\n' "$checkpoint_debug_summary"
case "$checkpoint_debug_summary" in
  *"Build Summary: 21/21 steps succeeded; 53/53 tests passed"*) ;;
  *) echo "Debug checkpoint test count drifted; the filtered assertion may not have executed" >&2; exit 1 ;;
esac
if ! checkpoint_release_summary=$("$ZIG" build --cache-dir "$LOCAL_CACHE/ghostty-checkpoint-release" \
  --global-cache-dir "$CACHE/zig-global" \
  test-lib-vt -Dtarget="$TARGET" --sysroot "$OVERLAY" -Doptimize=ReleaseFast \
  -Dtest-filter="legacy" --summary all 2>&1); then
  printf '%s\n' "$checkpoint_release_summary" >&2
  exit 1
fi
printf '%s\n' "$checkpoint_release_summary"
case "$checkpoint_release_summary" in
  *"Build Summary: 21/21 steps succeeded; 138/139 tests passed; 1 skipped"*) ;;
  *) echo "ReleaseFast checkpoint test count drifted; the filtered assertions may not have executed" >&2; exit 1 ;;
esac

# real-host-golden overrides HIVE_HOME to a private /tmp root; agent shells that inherit a live HIVE_HOME must not skip that override (see real-host-golden.zig).
cd "$ROOT/native/sessiond"
"$ZIG" build --cache-dir "$LOCAL_CACHE/sessiond" \
  --global-cache-dir "$CACHE/zig-global" \
  test identity-probe install -Dtarget="$TARGET" --sysroot "$OVERLAY"
MIN_OS=$(xcrun vtool -show-build zig-out/bin/hive-sessiond |
  /usr/bin/awk '$1 == "minos" { print $2 }')
if [ "$MIN_OS" != "14.0" ]; then
  echo "hive-sessiond minimum macOS: expected 14.0, found $MIN_OS" >&2
  exit 1
fi
cd "$ROOT"
bun run "$ROOT/scripts/test-sandbox.ts" -- \
  bun test ./native/sessiond/test/identity-parity.ts ./native/sessiond/test/ts-live-create.ts \
  ./native/tests/vendor-ghostty-verify.ts
