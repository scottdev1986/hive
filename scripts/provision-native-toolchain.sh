#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$ROOT/.cache/native"}
ARCHIVES="$CACHE/zig/archives"
TOOLCHAINS="$CACHE/zig/toolchains"

"$ROOT/scripts/validate-native-toolchain-lock.sh"
mkdir -p "$ARCHIVES" "$TOOLCHAINS"

lock_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK"
}

fetch_zig() {
  lock_arch=$1
  url=$(lock_value "zig.${lock_arch}Url")
  expected=$(lock_value "zig.${lock_arch}Sha256")
  name=${url##*/}
  archive="$ARCHIVES/$name"
  destination="$TOOLCHAINS/${name%.tar.xz}"

  if [ ! -f "$archive" ]; then
    tmp="$archive.partial"
    /bin/rm -f "$tmp"
    echo "fetching $url"
    /usr/bin/curl --fail --location --retry 3 --output "$tmp" "$url"
    /bin/mv "$tmp" "$archive"
  fi
  actual=$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{ print $1 }')
  if [ "$actual" != "$expected" ]; then
    echo "Zig $lock_arch archive hash mismatch: expected $expected, found $actual" >&2
    exit 1
  fi
  echo "verified $name sha256=$actual"

  if [ ! -x "$destination/zig" ]; then
    tmp=$(mktemp -d "$TOOLCHAINS/.extract.XXXXXX")
    /usr/bin/tar -xJf "$archive" -C "$tmp"
    extracted="$tmp/${name%.tar.xz}"
    if [ ! -x "$extracted/zig" ]; then
      echo "Zig archive did not contain ${name%.tar.xz}/zig" >&2
      exit 1
    fi
    /bin/rm -rf "$destination"
    /bin/mv "$extracted" "$destination"
    /bin/rm -rf "$tmp"
  fi
  if [ "$("$destination/zig" version)" != "$(lock_value zig.version)" ]; then
    echo "extracted Zig $lock_arch version does not match the lock" >&2
    exit 1
  fi
}

fetch_zig arm64
fetch_zig x86_64

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

case "$(uname -m)" in
  arm64) host_zig="$TOOLCHAINS/zig-aarch64-macos-$(lock_value zig.version)/zig" ;;
  x86_64) host_zig="$TOOLCHAINS/zig-x86_64-macos-$(lock_value zig.version)/zig" ;;
esac
bun "$ROOT/scripts/ghostty-dependency-cache.ts" fetch "$host_zig" \
  "$CACHE/zig-global" "$ROOT/vendor/ghostty/build.zig.zon.json"

echo "native toolchains provisioned in $CACHE"
