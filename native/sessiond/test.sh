#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CACHE=${HIVE_NATIVE_CACHE:-"$ROOT/.cache/native"}
LOCK="$ROOT/native/toolchain-lock.json"
VERSION=$(/usr/bin/plutil -extract zig.version raw -o - "$LOCK")

"$ROOT/scripts/preflight-native-toolchain.sh"

case "$(uname -m)" in
  arm64)
    ZIG="$CACHE/zig/toolchains/zig-aarch64-macos-$VERSION/zig"
    TARGET=aarch64-macos.14.0
    ;;
  x86_64)
    ZIG="$CACHE/zig/toolchains/zig-x86_64-macos-$VERSION/zig"
    TARGET=x86_64-macos.14.0
    ;;
  *)
    echo "unsupported build host architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

OVERLAY=$("$ROOT/scripts/prepare-zig-xcode-overlay.sh")
PATH="$ROOT/scripts/zig-runner-tools:$PATH"
export PATH

# Liam's HVTCP001 C fixture + Zig shared binary must agree (F5 dual-source lock).
ABI_TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-sessiond-abi.XXXXXX")
trap 'rm -rf "$ABI_TMP"' EXIT HUP INT TERM
/usr/bin/clang -std=c11 -Wall -Wextra -Werror -o "$ABI_TMP/checkpoint-envelope" \
  "$ROOT/native/tests/abi/checkpoint-envelope.c"
HVTCP001_FIXTURE_PATH="$ROOT/native/tests/abi/hvtcp001-header.bin" \
  "$ABI_TMP/checkpoint-envelope"
# header-standalone needs Ghostty headers (syntax-only ABI check).
if [ -f "$ROOT/vendor/ghostty/include/ghostty.h" ]; then
  env -u CPATH -u C_INCLUDE_PATH -u CPLUS_INCLUDE_PATH \
    /usr/bin/clang -std=c11 -Weverything -Werror -Wno-poison-system-directories -Wno-padded \
    -fsyntax-only \
    -I "$ROOT/native/include" -isystem "$ROOT/vendor/ghostty/include" \
    "$ROOT/native/tests/abi/header-standalone.c"
fi

cd "$ROOT/native/sessiond"
"$ZIG" build --global-cache-dir "$CACHE/zig-global" \
  test identity-probe install -Dtarget="$TARGET" --sysroot "$OVERLAY"
MIN_OS=$(xcrun vtool -show-build zig-out/bin/hive-sessiond |
  /usr/bin/awk '$1 == "minos" { print $2 }')
if [ "$MIN_OS" != "14.0" ]; then
  echo "hive-sessiond minimum macOS: expected 14.0, found $MIN_OS" >&2
  exit 1
fi
cd "$ROOT"
bun test ./native/sessiond/test/identity-parity.ts
