#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HEADER="$ROOT/native/include/hive_ghostty_bridge.h"
EXPORTS="$ROOT/native/abi/ghostty-bridge.exports"
TEST_SOURCE="$ROOT/native/tests/abi/header-standalone.c"
RUNTIME_SOURCE="$ROOT/native/tests/abi/bridge-runtime.c"
GHOSTTY_INCLUDE="$ROOT/vendor/ghostty/include"
CACHE=${HIVE_NATIVE_CACHE:-"$HOME/.cache/hive/native"}
LOCK="$ROOT/native/toolchain-lock.json"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-abi.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

lock_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK"
}

if [ ! -f "$GHOSTTY_INCLUDE/ghostty.h" ]; then
  echo "vendored Ghostty headers are missing; run scripts/vendor-ghostty.sh fetch" >&2
  exit 1
fi

deployment_target=$(lock_value deploymentTarget)
for arch in arm64 x86_64; do
  env -u CPATH -u C_INCLUDE_PATH -u CPLUS_INCLUDE_PATH \
    /usr/bin/clang -arch "$arch" -mmacosx-version-min="$deployment_target" \
    -std=c11 -Weverything -Werror -Wno-poison-system-directories -Wno-padded \
    -Wno-pre-c11-compat -fsyntax-only \
    -I "$ROOT/native/include" -isystem "$GHOSTTY_INCLUDE" "$TEST_SOURCE"
  env -u CPATH -u C_INCLUDE_PATH -u CPLUS_INCLUDE_PATH \
    /usr/bin/clang -arch "$arch" -mmacosx-version-min="$deployment_target" \
    -std=c11 -Wall -Wextra -Werror -Wno-poison-system-directories \
    -I "$ROOT/native/include" -isystem "$GHOSTTY_INCLUDE" "$RUNTIME_SOURCE" \
    -o "$TMP/bridge-runtime-$arch"
  /usr/bin/arch "-$arch" "$TMP/bridge-runtime-$arch"
done

case "$(uname -m)" in
  arm64|x86_64) ;;
  *) echo "unsupported ABI qualification host: $(uname -m)" >&2; exit 1 ;;
esac
# System zig from PATH, version pinned by the lock (preflight enforces it).
ZIG=$(command -v zig) || {
  echo "zig is not on PATH; install Zig $(lock_value zig.version) (brew install zig@0.15 && brew link --force zig@0.15)" >&2
  exit 1
}
for target in aarch64:arm64 x86_64:x86_64; do
  zig_arch=${target%%:*}
  hive_arch=${target#*:}
  "$ZIG" test "$ROOT/native/tests/abi/bridge-abi.zig" \
    -target "$zig_arch-macos.$deployment_target" \
    -I "$ROOT/native/include" -I "$GHOSTTY_INCLUDE" -lc \
    --global-cache-dir "$CACHE/zig-global" --cache-dir "$TMP/zig-$hive_arch"
done

/usr/bin/sed -n 's/.*\(hive_ghostty_[a-z0-9_]*_v1\)(.*/\1/p' "$HEADER" \
  | LC_ALL=C /usr/bin/sort -u >"$TMP/header.exports"
LC_ALL=C /usr/bin/sort -u "$EXPORTS" >"$TMP/expected.exports"
if ! /usr/bin/cmp -s "$TMP/header.exports" "$TMP/expected.exports"; then
  echo "bridge header declarations differ from exported-symbol scaffold" >&2
  /usr/bin/diff -u "$TMP/expected.exports" "$TMP/header.exports" >&2 || true
  exit 1
fi

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [library]" >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  /usr/bin/nm -gUj "$1" \
    | /usr/bin/sed 's/^_//' \
    | /usr/bin/grep '^hive_ghostty_' \
    | LC_ALL=C /usr/bin/sort -u >"$TMP/library.exports" || true
  if ! /usr/bin/cmp -s "$TMP/library.exports" "$TMP/expected.exports"; then
    echo "bridge library exports differ from exported-symbol scaffold" >&2
    /usr/bin/diff -u "$TMP/expected.exports" "$TMP/library.exports" >&2 || true
    exit 1
  fi
fi

echo "Ghostty bridge ABI skeleton validated"
