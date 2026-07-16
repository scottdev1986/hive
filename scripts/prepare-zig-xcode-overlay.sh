#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$ROOT/.cache/native"}
VERSION=$(/usr/bin/plutil -extract zig.version raw -o - "$LOCK")

case "$(uname -m)" in
  arm64) ZIG_DIR="$CACHE/zig/toolchains/zig-aarch64-macos-$VERSION" ;;
  x86_64) ZIG_DIR="$CACHE/zig/toolchains/zig-x86_64-macos-$VERSION" ;;
  *) echo "unsupported build host architecture: $(uname -m)" >&2; exit 1 ;;
esac

BUNDLED_STUB="$ZIG_DIR/lib/libc/darwin/libSystem.tbd"
OVERLAY="$CACHE/zig-xcode-overlay"
if [ ! -f "$BUNDLED_STUB" ]; then
  echo "Zig bundled Darwin stub is missing: $BUNDLED_STUB" >&2
  exit 1
fi

find "$OVERLAY" -depth -delete 2>/dev/null || true
mkdir -p "$OVERLAY/usr/lib"
ln -s "$BUNDLED_STUB" "$OVERLAY/usr/lib/libSystem.tbd"

for sdk_name in macosx iphoneos iphonesimulator; do
  sdk=$(xcrun --sdk "$sdk_name" --show-sdk-path)
  destination="$OVERLAY$sdk"
  mkdir -p "$destination/usr/lib"

  find "$sdk" -mindepth 1 -maxdepth 1 ! -name usr -print | while IFS= read -r entry; do
    ln -s "$entry" "$destination/${entry##*/}"
  done
  find "$sdk/usr" -mindepth 1 -maxdepth 1 ! -name lib -print | while IFS= read -r entry; do
    ln -s "$entry" "$destination/usr/${entry##*/}"
  done
  find "$sdk/usr/lib" -mindepth 1 -maxdepth 1 -print | while IFS= read -r entry; do
    name=${entry##*/}
    if [ "$sdk_name" = macosx ] && { [ "$name" = libSystem.tbd ] || [ "$name" = libSystem.dylib ]; }; then
      continue
    fi
    ln -s "$entry" "$destination/usr/lib/$name"
  done
  if [ "$sdk_name" = macosx ]; then
    ln -s "$BUNDLED_STUB" "$destination/usr/lib/libSystem.tbd"
  fi
done

printf '%s\n' "$OVERLAY"
