#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$ROOT/.cache/native"}
PRODUCTION=0

if [[ "${1:-}" == "--production" ]]; then
  PRODUCTION=1
  shift
fi
if [[ $# -ne 0 ]]; then
  echo "usage: $0 [--production]" >&2
  exit 2
fi

lock_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK"
}

if [[ $PRODUCTION -eq 1 ]]; then
  "$ROOT/scripts/preflight-native-toolchain.sh" --production
else
  "$ROOT/scripts/preflight-native-toolchain.sh"
fi
"$ROOT/scripts/vendor-ghostty.sh" verify
"$ROOT/scripts/check-ghostty-abi.sh"

version=$(lock_value zig.version)
case "$(uname -m)" in
  arm64)
    ZIG="$CACHE/zig/toolchains/zig-aarch64-macos-$version/zig"
    ZIG_SHA=$(lock_value zig.arm64Sha256)
    ;;
  x86_64)
    ZIG="$CACHE/zig/toolchains/zig-x86_64-macos-$version/zig"
    ZIG_SHA=$(lock_value zig.x86_64Sha256)
    ;;
esac
commit=$(lock_value ghostty.commit)
declared_version=$(lock_value ghostty.declaredVersion)
actual_version=$(/usr/bin/sed -n 's/.*\.version = "\([^"]*\)".*/\1/p' "$ROOT/vendor/ghostty/build.zig.zon" | /usr/bin/head -1)
if [[ "$actual_version" != "$declared_version" ]]; then
  echo "vendored Ghostty version: expected $declared_version, found $actual_version" >&2
  exit 1
fi

PATCH_SHA=$("$ROOT/scripts/vendor-ghostty.sh" patch-series-sha256)
HEADER_SHA=$(/usr/bin/shasum -a 256 "$ROOT/native/include/hive_ghostty_bridge.h" | /usr/bin/awk '{ print $1 }')
SYMBOL_SHA=$(/usr/bin/shasum -a 256 "$ROOT/native/abi/ghostty-bridge.exports" | /usr/bin/awk '{ print $1 }')
for pair in "patchSeriesSha256:$PATCH_SHA" "publicHeaderSha256:$HEADER_SHA" "symbolListSha256:$SYMBOL_SHA"; do
  key=${pair%%:*}
  actual=${pair#*:}
  expected=$(lock_value "ghostty.$key")
  if [[ "$expected" != "REQUIRED_BEFORE_TG1_PRODUCTION" && "$actual" != "$expected" ]]; then
    echo "ghostty.$key: expected $expected, found $actual" >&2
    exit 1
  fi
done

component=$(mktemp "${TMPDIR:-/tmp}/hive-metal-component.XXXXXX")
trap '/bin/rm -f "$component"' EXIT HUP INT TERM
xcodebuild -showComponent MetalToolchain -json >"$component"
METAL_TOOLCHAIN=$(/usr/bin/plutil -extract toolchainIdentifier raw -o - "$component")
METAL_BUILD=$(/usr/bin/plutil -extract buildVersion raw -o - "$component")

OVERLAY=$("$ROOT/scripts/prepare-zig-xcode-overlay.sh")
BUNDLED_STUB="${ZIG%/zig}/lib/libc/darwin/libSystem.tbd"
MACOS_SDK=$(xcrun --sdk macosx --show-sdk-path)
XCODE_STUB="$MACOS_SDK/usr/lib/libSystem.tbd"
WORK="$CACHE/build/ghostty-$commit"
OUT="$CACHE/artifacts/ghostty-$commit-zig-$ZIG_SHA"
LOCAL_CACHE="$CACHE/zig-local/ghostty-$commit-zig-$ZIG_SHA"

find "$WORK" "$OUT" -depth -delete 2>/dev/null || true
mkdir -p "$WORK" "$OUT" "$LOCAL_CACHE"
/usr/bin/rsync -a "$ROOT/vendor/ghostty/" "$WORK/"

export PATH="$ROOT/scripts/zig-runner-tools:$PATH"
export TOOLCHAINS="$METAL_TOOLCHAIN"
export HTTP_PROXY=http://127.0.0.1:9
export HTTPS_PROXY=http://127.0.0.1:9
export http_proxy=$HTTP_PROXY
export https_proxy=$HTTPS_PROXY
export NO_PROXY=
export no_proxy=

echo "building universal GhosttyKit.xcframework"
(
  cd "$WORK"
  "$ZIG" build -Demit-xcframework=true -Demit-macos-app=false \
    -Dxcframework-target=universal -Doptimize=ReleaseFast \
    --sysroot "$OVERLAY" --prefix "$WORK/zig-out-ghosttykit" \
    --global-cache-dir "$CACHE/zig-global" --cache-dir "$LOCAL_CACHE/ghosttykit"
)
/usr/bin/ditto "$WORK/macos/GhosttyKit.xcframework" "$OUT/GhosttyKit.xcframework"

# Ghostty's own xcframework build names the macOS static library without a
# "lib" prefix (the iOS slices already use "libghostty-internal-fat.a").
# swift-package-manager's binaryTarget requires the "lib" prefix to link the
# archive into a final product (executable/xctest bundle) — SwiftPM accepts
# the unprefixed name for building a single library target, then fails only
# at the final test-bundle link with "unexpected binary name ... Static
# libraries should be prefixed with lib". Rename in place and repoint the
# xcframework's own manifest so every consumer sees a valid archive name.
#
# The slice directory name and archive filename are read from the plist's
# own macOS entry rather than hardcoded, so this survives Ghostty renaming
# its LibraryIdentifier (e.g. arch-list changes) or BinaryPath convention.
mac_plist="$OUT/GhosttyKit.xcframework/Info.plist"
mac_index=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries" "$mac_plist" \
  | /usr/bin/awk '
      /Dict {/ { idx++ }
      /SupportedPlatform = macos/ { print idx - 1; found=1 }
      END { if (!found) exit 1 }
    ')
mac_identifier=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$mac_index:LibraryIdentifier" "$mac_plist")
mac_binary_path=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$mac_index:BinaryPath" "$mac_plist")
mac_slice="$OUT/GhosttyKit.xcframework/$mac_identifier"
mac_lib="$mac_slice/$mac_binary_path"
if [[ -f "$mac_lib" && "$mac_binary_path" != lib* ]]; then
  mac_binary_path="lib$mac_binary_path"
  /bin/mv "$mac_lib" "$mac_slice/$mac_binary_path"
  /usr/libexec/PlistBuddy -c "Set :AvailableLibraries:$mac_index:BinaryPath $mac_binary_path" "$mac_plist"
  /usr/libexec/PlistBuddy -c "Set :AvailableLibraries:$mac_index:LibraryPath $mac_binary_path" "$mac_plist"
fi

for target in aarch64:arm64 x86_64:x86_64; do
  zig_arch=${target%%:*}
  hive_arch=${target#*:}
  prefix="$WORK/zig-out-vt-$hive_arch"
  echo "building libghostty-vt slice: $hive_arch"
  (
    cd "$WORK"
    "$ZIG" build -Demit-lib-vt=true -Demit-xcframework=false -Demit-macos-app=false \
      -Dtarget="$zig_arch-macos" -Doptimize=ReleaseFast \
      --sysroot "$OVERLAY" --prefix "$prefix" \
      --global-cache-dir "$CACHE/zig-global" --cache-dir "$LOCAL_CACHE/vt-$hive_arch"
  )
  mkdir -p "$OUT/lib-vt/$hive_arch"
  /bin/cp "$prefix/lib/libghostty-vt.a" "$OUT/lib-vt/$hive_arch/libghostty-vt.a"
done

mkdir -p "$OUT/include" "$OUT/symbols" "$OUT/notices/ghostty" "$OUT/provenance/patches"
/bin/cp "$ROOT/native/include/hive_ghostty_bridge.h" "$OUT/include/"
/usr/bin/ditto "$WORK/zig-out-vt-arm64/include" "$OUT/include/ghostty-vt"
/bin/cp "$ROOT/native/abi/ghostty-bridge.exports" "$OUT/symbols/"
/bin/cp "$LOCK" "$OUT/provenance/"
/bin/cp "$ROOT/native/ghostty-upstream-tree.txt" "$OUT/provenance/"
/bin/cp "$ROOT/native/ghostty-patches/series" "$OUT/provenance/patches/"
while IFS= read -r patch; do
  [[ -z "$patch" || "$patch" == \#* ]] && continue
  /bin/cp "$ROOT/native/ghostty-patches/$patch" "$OUT/provenance/patches/"
done <"$ROOT/native/ghostty-patches/series"

find "$WORK" -type f \( -iname 'license*' -o -iname 'copying*' -o -iname 'notice*' -o -iname 'copyright*' \) -print \
  | while IFS= read -r notice; do
      relative=${notice#"$WORK/"}
      destination="$OUT/notices/ghostty/$relative"
      mkdir -p "${destination%/*}"
      /bin/cp "$notice" "$destination"
    done
if [[ ! -f "$OUT/notices/ghostty/LICENSE" ]]; then
  echo "Ghostty MIT license was not collected" >&2
  exit 1
fi

# Gate 4 (M1-B1): the shipped artifact must contain only static archives —
# an accidental dynamic library would silently change linking, codesign,
# and notarization behavior.
if /usr/bin/find "$OUT" \( -name '*.dylib' -o -name '*.so' \) -print | /usr/bin/grep -q .; then
  echo "unexpected dynamic library in GhosttyKit artifact:" >&2
  /usr/bin/find "$OUT" \( -name '*.dylib' -o -name '*.so' \) -print >&2
  exit 1
fi

mac_library="$mac_slice/$mac_binary_path"
if ! /usr/bin/file "$mac_library" | /usr/bin/grep -q 'ar archive'; then
  echo "macOS GhosttyKit slice is not a static archive: $(/usr/bin/file "$mac_library")" >&2
  exit 1
fi
/usr/bin/nm -gUj "$mac_library" | /usr/bin/sed 's/^_//' | LC_ALL=C /usr/bin/sort -u >"$OUT/symbols/ghostty-all.exports"
if [[ "$(lock_value ghostty.symbolListSha256)" != "REQUIRED_BEFORE_TG1_PRODUCTION" ]]; then
  "$ROOT/scripts/check-ghostty-abi.sh" "$mac_library"
fi

export HIVE_MAC_XCFRAMEWORK_ARCHIVE="GhosttyKit.xcframework/$mac_identifier/$mac_binary_path"
export HIVE_PATCH_SERIES_SHA256="$PATCH_SHA"
export HIVE_PUBLIC_HEADER_SHA256="$HEADER_SHA"
export HIVE_SYMBOL_LIST_SHA256="$SYMBOL_SHA"
export HIVE_METAL_TOOLCHAIN="$METAL_TOOLCHAIN"
export HIVE_METAL_BUILD="$METAL_BUILD"
export HIVE_ZIG_ARCHIVE_SHA256="$ZIG_SHA"
export HIVE_ZIG_BUNDLED_STUB="$BUNDLED_STUB"
export HIVE_XCODE_LIBSYSTEM_STUB="$XCODE_STUB"
export HIVE_ZIG_GLOBAL_CACHE="$CACHE/zig-global"
bun "$ROOT/scripts/write-ghostty-artifact-metadata.ts" "$OUT"

echo "Ghostty native artifacts: $OUT"
