#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
PRODUCTION=0

if [ "${1:-}" = "--production" ]; then
  PRODUCTION=1
  shift
fi
if [ "$#" -ne 0 ]; then
  echo "usage: $0 [--production]" >&2
  exit 2
fi

lock_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK"
}

assert_equal() {
  key=$1
  expected=$2
  actual=$(lock_value "$key") || {
    echo "toolchain lock is missing $key" >&2
    exit 1
  }
  if [ "$actual" != "$expected" ]; then
    echo "toolchain lock $key: expected '$expected', found '$actual'" >&2
    exit 1
  fi
}

/usr/bin/plutil -convert json -o /dev/null "$LOCK"
assert_equal schemaVersion 1
assert_equal ghostty.commit 73534c4680a809398b396c94ac7f12fcccb7963d
assert_equal ghostty.upstreamTree 0aeaa44eda9efaf41523c3c0d4f6851eb81e536e
assert_equal ghostty.patchedTree a27fc0e76555552cf7202c98fb1a31b2021bcf26
assert_equal ghostty.declaredVersion 1.3.2-dev
assert_equal zig.version 0.15.2
assert_equal zig.arm64Url https://ziglang.org/download/0.15.2/zig-aarch64-macos-0.15.2.tar.xz
assert_equal zig.arm64Sha256 3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b
assert_equal zig.x86_64Url https://ziglang.org/download/0.15.2/zig-x86_64-macos-0.15.2.tar.xz
assert_equal zig.x86_64Sha256 375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f
assert_equal apple.xcode 26.6
assert_equal apple.build 17F113
assert_equal apple.swift 6.3.3
assert_equal apple.swiftTools 5.10
assert_equal bun 1.3.14
assert_equal deploymentTarget 14.0
assert_equal architectures.0 arm64
assert_equal architectures.1 x86_64

recorded_commit=$(/usr/bin/awk '$1 == "commit" { print $2 }' "$ROOT/native/ghostty-upstream-tree.txt")
recorded_tree=$(/usr/bin/awk '$1 == "tree" { print $2 }' "$ROOT/native/ghostty-upstream-tree.txt")
recorded_patched_tree=$(/usr/bin/awk '$1 == "patched-tree" { print $2 }' "$ROOT/native/ghostty-upstream-tree.txt")
if [ "$recorded_commit" != "$(lock_value ghostty.commit)" ] || \
   [ "$recorded_tree" != "$(lock_value ghostty.upstreamTree)" ] || \
   [ "$recorded_patched_tree" != "$(lock_value ghostty.patchedTree)" ]; then
  echo "Ghostty tree provenance record differs from the toolchain lock" >&2
  exit 1
fi

for key in patchSeriesSha256 upstreamPublicHeaderSha256 bridgeHeaderSha256 symbolListSha256; do
  value=$(lock_value "ghostty.$key") || {
    echo "toolchain lock is missing ghostty.$key" >&2
    exit 1
  }
  if [ "$value" = "REQUIRED_BEFORE_TG1_PRODUCTION" ]; then
    if [ "$PRODUCTION" -eq 1 ]; then
      echo "production build refuses placeholder ghostty.$key" >&2
      exit 1
    fi
    continue
  fi
  if ! printf '%s\n' "$value" | /usr/bin/grep -Eq '^[0-9a-f]{64}$'; then
    echo "toolchain lock ghostty.$key must be a lowercase SHA-256" >&2
    exit 1
  fi
done

echo "native toolchain lock validated"
