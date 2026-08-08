#!/bin/sh
set -eu

DIST="${1:?usage: verify.sh <dist-dir> [--require-notarization]}"
REQUIRE_NOTARIZATION=0
[ "${2:-}" = "--require-notarization" ] && REQUIRE_NOTARIZATION=1

fail() { printf 'verify: %s\n' "$1" >&2; exit 1; }
note() { printf 'verify: %s\n' "$1"; }

verify_signature() {
  path="$1"
  note "codesign --verify --strict $path"
  codesign --verify --strict --verbose=2 "$path" \
    || fail "$path failed strict signature verification"
  # Notarization requires hardened runtime; plain Developer ID would pass --verify and fail notarization.
  codesign --display --verbose=2 "$path" 2>&1 | grep -q "flags=.*runtime" \
    || fail "$path is not signed with the hardened runtime"
}

assess_gatekeeper() {
  path="$1"
  note "spctl --assess --type execute $path"
  out="$(spctl --assess --type execute --verbose=4 "$path" 2>&1)" || true
  if printf '%s' "$out" | grep -q "accepted"; then
    note "$path accepted by Gatekeeper"
  else
    printf '%s\n' "$out" >&2
    fail "$path was not accepted by Gatekeeper (spctl --assess rejected it)"
  fi
}

check_notarized_binary() {
  path="$1"
  note "codesign --check-notarization $path"
  codesign --verify --check-notarization -R="notarized" --verbose=2 "$path" \
    || fail "$path has no notarization ticket (codesign --check-notarization rejected it)"
}

for arch in arm64 x64; do
  bin="$DIST/hive-darwin-$arch"
  [ -f "$bin" ] || fail "missing $bin"
  verify_signature "$bin"
  [ "$REQUIRE_NOTARIZATION" = 1 ] && check_notarized_binary "$bin"

  sessiond="$DIST/hive-sessiond-darwin-$arch"
  [ -f "$sessiond" ] || fail "missing $sessiond"
  verify_signature "$sessiond"
  [ "$REQUIRE_NOTARIZATION" = 1 ] && check_notarized_binary "$sessiond"
done

note "running hive-darwin-arm64 --version"
chmod +x "$DIST/hive-darwin-arm64"
"$DIST/hive-darwin-arm64" --version >/dev/null || fail "signed hive-darwin-arm64 did not run"

TARBALL="$DIST/HiveWorkspace.tar.gz"
if [ -f "$TARBALL" ]; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  tar -xzf "$TARBALL" -C "$WORK"
  APP="$WORK/HiveWorkspace.app"
  [ -d "$APP" ] || fail "$TARBALL did not contain HiveWorkspace.app"
  verify_signature "$APP"
  if [ "$REQUIRE_NOTARIZATION" = 1 ]; then
    note "stapler validate HiveWorkspace.app"
    xcrun stapler validate "$APP" || fail "HiveWorkspace.app has no stapled notarization ticket"
    assess_gatekeeper "$APP"
  fi
fi

# Embedding runtime is not Developer-ID-signed (upstream napi binaries). Trust anchors: manifest SHA-256 at download, plus HIVE_EMBEDDINGS_DIGEST of the loaded surface (dist/ + bin/; not node_modules or INSTALL.json) compiled into the CLI. The daemon refuses a mismatched runtime. Builds with no release key embed no digest and skip verification — those hosts are themselves unsigned. Never add a switch to turn verification off. This gate checks layout only: bundled ESM, INSTALL.json, and onnxruntime natives for both darwin slices.
RUNTIME_TARBALL="$DIST/embeddings-runtime.tar.gz"
if [ -f "$RUNTIME_TARBALL" ]; then
  RUNTIME_WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK" "$RUNTIME_WORK"' EXIT
  tar -xzf "$RUNTIME_TARBALL" -C "$RUNTIME_WORK"
  RUNTIME="$RUNTIME_WORK/embeddings-runtime"
  [ -f "$RUNTIME/dist/entry.js" ] || fail "$RUNTIME_TARBALL did not contain dist/entry.js"
  [ -f "$RUNTIME/INSTALL.json" ] || fail "$RUNTIME_TARBALL did not contain INSTALL.json"
  for arch in arm64 x64; do
    [ -f "$RUNTIME/bin/napi-v3/darwin/$arch/onnxruntime_binding.node" ] \
      || fail "$RUNTIME_TARBALL has no darwin/$arch onnxruntime napi binding"
    ls "$RUNTIME/bin/napi-v3/darwin/$arch/"libonnxruntime.*.dylib >/dev/null 2>&1 \
      || fail "$RUNTIME_TARBALL has no darwin/$arch libonnxruntime dylib"
  done
  note "embeddings-runtime.tar.gz layout verified (bundle + INSTALL.json + darwin arm64/x64 natives)"
fi

note "all artifacts passed"
