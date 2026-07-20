#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$HOME/.cache/hive/native"}
VERSION=$(/usr/bin/plutil -extract zig.version raw -o - "$LOCK")
XCODE_BUILD=$(/usr/bin/plutil -extract apple.build raw -o - "$LOCK")

# The system `zig` on PATH supplies the bundled Darwin stub; the lock pins
# its version (preflight enforces it).
ZIG=$(command -v zig) || {
  echo "zig is not on PATH; install Zig $VERSION (brew install zig@0.15 && brew link --force zig@0.15)" >&2
  exit 1
}
ZIG_LIB_DIR=$("$ZIG" env | /usr/bin/sed -n 's/^ *\.lib_dir = "\(.*\)",$/\1/p')
if [ -z "$ZIG_LIB_DIR" ]; then
  echo "could not read lib_dir from 'zig env'" >&2
  exit 1
fi

BUNDLED_STUB="$ZIG_LIB_DIR/libc/darwin/libSystem.tbd"
if [ ! -f "$BUNDLED_STUB" ]; then
  echo "Zig bundled Darwin stub is missing: $BUNDLED_STUB" >&2
  exit 1
fi

# The overlay is a symlink farm over the locked Zig's bundled Darwin stub and
# the active Xcode SDKs. It is keyed by (zig version, locked Xcode build) and
# created ONCE, atomically — the previous delete-and-rebuild on every call
# yanked the overlay out from under concurrent builds in sibling worktrees
# (#46). The lock pins the Xcode build (preflight asserts it), so a locked
# toolchain change renames the key and naturally invalidates the overlay.
OVERLAY="$CACHE/zig-xcode-overlay/$VERSION-xcode-$XCODE_BUILD"
if [ -e "$OVERLAY/.complete" ]; then
  printf '%s\n' "$OVERLAY"
  exit 0
fi

mkdir -p "$CACHE/zig-xcode-overlay"
TMP=$(mktemp -d "$CACHE/zig-xcode-overlay/.build.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

mkdir -p "$TMP/usr/lib"
ln -s "$BUNDLED_STUB" "$TMP/usr/lib/libSystem.tbd"

for sdk_name in macosx iphoneos iphonesimulator; do
  sdk=$(xcrun --sdk "$sdk_name" --show-sdk-path)
  destination="$TMP$sdk"
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

touch "$TMP/.complete"
# Atomic publish: rename into place; if a concurrent builder won the race the
# rename lands INSIDE its overlay (mv-into-directory semantics) — detect that,
# remove the misplaced copy, and use the winner's complete overlay.
if [ ! -e "$OVERLAY" ] && mv "$TMP" "$OVERLAY" 2>/dev/null; then
  trap - EXIT HUP INT TERM
else
  rm -rf "$OVERLAY/${TMP##*/}" "$TMP"
  trap - EXIT HUP INT TERM
  if [ ! -e "$OVERLAY/.complete" ]; then
    echo "zig xcode overlay exists but is incomplete: $OVERLAY (delete it and rerun)" >&2
    exit 1
  fi
fi

printf '%s\n' "$OVERLAY"
