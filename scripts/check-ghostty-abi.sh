#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HEADER="$ROOT/native/include/hive_ghostty_bridge.h"
EXPORTS="$ROOT/native/abi/ghostty-bridge.exports"
TEST_SOURCE="$ROOT/native/tests/abi/header-standalone.c"
GHOSTTY_INCLUDE="$ROOT/vendor/ghostty/include"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-abi.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

if [ ! -f "$GHOSTTY_INCLUDE/ghostty.h" ]; then
  echo "vendored Ghostty headers are missing; run scripts/vendor-ghostty.sh fetch" >&2
  exit 1
fi

env -u CPATH -u C_INCLUDE_PATH -u CPLUS_INCLUDE_PATH \
  /usr/bin/clang -std=c11 -Weverything -Werror -Wno-poison-system-directories -Wno-padded -fsyntax-only \
  -I "$ROOT/native/include" -isystem "$GHOSTTY_INCLUDE" "$TEST_SOURCE"

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
    | /usr/bin/grep '^hive_ghostty_.*_v1$' \
    | LC_ALL=C /usr/bin/sort -u >"$TMP/library.exports" || true
  if ! /usr/bin/cmp -s "$TMP/library.exports" "$TMP/expected.exports"; then
    echo "bridge library exports differ from exported-symbol scaffold" >&2
    /usr/bin/diff -u "$TMP/expected.exports" "$TMP/library.exports" >&2 || true
    exit 1
  fi
fi

echo "Ghostty bridge ABI skeleton validated"
