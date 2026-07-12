#!/usr/bin/env bash
# Build Hive's graphify bundles: the per-platform standalone artifacts
# `hive graphify enable` downloads (docs/architecture/graphify-bundling.md).
#
#   scripts/graphify/build.sh [--build-number N]
#
# From the repo's graphify.lock (the freeze input, regenerated only from
# scripts/graphify/graphify.in), this produces for each platform slice:
#   dist/graphify/graphify-<pin>-darwin-{arm64,x64}.tar.zst        the artifact
#   dist/graphify/graphify-<pin>-darwin-{arm64,x64}.tar.zst.sha256 its hash
# plus dist/graphify/registry.snippet.ts — the exact GRAPHIFY_ARTIFACTS
# entries to land in src/adapters/graphify-artifacts.ts as a reviewable diff.
# The snippet's hashes are of the FINAL bytes (signed, then packed), so only
# the run that produced the published assets may produce the landed hashes —
# in practice that is CI (.github/workflows/graphify-artifacts.yml).
#
# Signing rides the same environment contract as src/release/build.ts:
#   MACOS_SIGN_IDENTITY   set → every Mach-O in each bundle is signed with the
#                         hardened runtime and scripts/graphify/entitlements.plist
#   MACOS_NOTARY_KEY_PATH/_KEY_ID/_ISSUER_ID
#                         set (with the identity) → each signed bundle is
#                         zipped and submitted to notarytool; a rejection
#                         fails the build. Bare Mach-Os cannot staple; the
#                         ticket is server-side (same posture as the CLI
#                         slices, docs/versioning-and-release.md).
# With neither set the bundles are ad-hoc-signed by PyInstaller and the build
# says so — same graceful degradation as an unsigned Hive release.
#
# Requires: uv, zstd, /usr/bin/tar; Rosetta 2 for the darwin-x64 slice on an
# arm64 host. The interpreter and PyInstaller pins below are part of the
# reproducibility contract — bump them deliberately, like the graphify pin.
set -euo pipefail

PYTHON_KEY_ARM64="cpython-3.12.8-macos-aarch64-none"
PYTHON_KEY_X64="cpython-3.12.8-macos-x86_64-none"
PYINSTALLER_PIN="pyinstaller==6.21.0"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
LOCK="$REPO_ROOT/graphify.lock"
OUT="$REPO_ROOT/dist/graphify"
ENTITLEMENTS="$HERE/entitlements.plist"

BUILD_NUMBER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --build-number) BUILD_NUMBER="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f "$LOCK" ] || { echo "graphify.lock not found at $LOCK" >&2; exit 1; }
PIN="$(grep -m1 '^graphifyy==' "$LOCK" | sed 's/graphifyy==//; s/ .*//; s/\\//')"
[ -n "$PIN" ] || { echo "graphify.lock does not pin graphifyy" >&2; exit 1; }
TAG="graphify-v${PIN}-hive.${BUILD_NUMBER}"
mkdir -p "$OUT"

sign_bundle() { # sign_bundle <bundle-dir>  — Developer ID + hardened runtime
  local dist="$1"
  if [ -z "${MACOS_SIGN_IDENTITY:-}" ]; then
    echo "  (no MACOS_SIGN_IDENTITY: bundle keeps PyInstaller's ad-hoc signature, UNSIGNED for distribution)"
    return 0
  fi
  echo "  signing every Mach-O with '$MACOS_SIGN_IDENTITY' (hardened runtime)"
  # Libraries first, main executable last, so the outer signature seals a
  # bundle whose members are already valid.
  find "$dist" -type f \( -name '*.so' -o -name '*.dylib' \) -print0 |
    xargs -0 -n 16 codesign --force --timestamp --options runtime \
      --sign "$MACOS_SIGN_IDENTITY"
  codesign --force --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" \
    --sign "$MACOS_SIGN_IDENTITY" "$dist/graphify"
  codesign --verify --strict "$dist/graphify"
}

notarize_bundle() { # notarize_bundle <bundle-dir> <arch>
  local dist="$1" arch="$2"
  if [ -z "${MACOS_SIGN_IDENTITY:-}" ] || [ -z "${MACOS_NOTARY_KEY_PATH:-}" ]; then
    echo "  (no notary credentials: skipping notarization)"
    return 0
  fi
  echo "  notarizing (this uploads the bundle to Apple and waits)"
  local zip="$OUT/notarize-$arch.zip"
  ditto -c -k "$dist" "$zip"
  xcrun notarytool submit "$zip" --wait \
    --key "$MACOS_NOTARY_KEY_PATH" \
    --key-id "$MACOS_NOTARY_KEY_ID" \
    --issuer "$MACOS_NOTARY_ISSUER_ID" |
    tee "$OUT/notarize-$arch.log"
  grep -q 'status: Accepted' "$OUT/notarize-$arch.log" ||
    { echo "notarization was not accepted for $arch" >&2; exit 1; }
  rm -f "$zip"
}

smoke() { # smoke <bundle-dir>  — extract, query, and MCP-serve a fixture
  local dist="$1" fix port=8973
  fix="$(mktemp -d)/fixture"
  mkdir -p "$fix/src"
  printf 'def helper():\n    return 1\n\ndef caller():\n    return helper()\n' > "$fix/src/a.py"
  printf 'export function load(): number { return 0 }\n' > "$fix/src/b.ts"
  (cd "$fix" && env -i PATH=/usr/bin:/bin HOME="$HOME" "$dist/graphify" update . >/dev/null 2>&1)
  (cd "$fix" && env -i PATH=/usr/bin:/bin HOME="$HOME" "$dist/graphify" query "who calls helper" 2>/dev/null | grep -q "helper")
  (cd "$fix" && env -i PATH=/usr/bin:/bin HOME="$HOME" "$dist/graphify-mcp" --transport http --host 127.0.0.1 --port "$port" \
      --stateless --json-response graphify-out/graph.json >/dev/null 2>&1) &
  local pid=$!
  sleep 3
  local ok=1
  curl -sf -X POST "http://127.0.0.1:$port/mcp" \
      -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_graph","arguments":{"question":"who calls helper"}}}' \
      | grep -q '"isError":false' && ok=0
  kill "$pid" 2>/dev/null || true
  return "$ok"
}

build_one() { # build_one <arch> <python-key>
  local arch="$1" py_key="$2"
  local work="$OUT/work-$arch" venv dist
  venv="$work/venv"
  echo "== darwin-$arch: venv + hash-verified install =="
  rm -rf "$work" && mkdir -p "$work"
  uv python install "$py_key"
  uv venv --python "$py_key" "$venv" >/dev/null
  VIRTUAL_ENV="$venv" uv pip install --require-hashes -r "$LOCK" >/dev/null
  VIRTUAL_ENV="$venv" uv pip install "$PYINSTALLER_PIN" >/dev/null

  echo "== darwin-$arch: freeze =="
  (cd "$HERE" && "$venv/bin/pyinstaller" --noconfirm --clean \
      --distpath "$work/dist" --workpath "$work/build" graphify.spec >/dev/null)
  dist="$work/dist/graphify-dist"
  ln -sf graphify "$dist/graphify-mcp"

  echo "== darwin-$arch: sign =="
  sign_bundle "$dist"

  echo "== darwin-$arch: smoke test (CLI extract + query, MCP query_graph) =="
  smoke "$dist" || { echo "darwin-$arch: SMOKE TEST FAILED" >&2; exit 1; }

  notarize_bundle "$dist" "$arch"

  echo "== darwin-$arch: package =="
  local asset="graphify-${PIN}-darwin-${arch}.tar.zst"
  tar -C "$work/dist" -cf - graphify-dist | zstd -19 -T0 -q -f -o "$OUT/$asset"
  (cd "$OUT" && shasum -a 256 "$asset" | tee "$asset.sha256")
  rm -rf "$work"
}

build_one arm64 "$PYTHON_KEY_ARM64"
if arch -x86_64 /usr/bin/true 2>/dev/null; then
  build_one x64 "$PYTHON_KEY_X64"
else
  echo "SKIPPED darwin-x64: Rosetta 2 not available on this machine" >&2
  exit 1
fi

# The registry snippet: what a bump PR pastes into graphify-artifacts.ts.
{
  for arch in arm64 x64; do
    asset="graphify-${PIN}-darwin-${arch}.tar.zst"
    sha="$(cut -d' ' -f1 "$OUT/$asset.sha256")"
    printf '  "darwin-%s": {\n    tag: "%s",\n    asset: "%s",\n    sha256: "%s",\n  },\n' \
      "$arch" "$TAG" "$asset" "$sha"
  done
} > "$OUT/registry.snippet.ts"

echo
echo "artifacts in $OUT (release tag: $TAG):"
ls -lh "$OUT"/*.tar.zst
echo
echo "GRAPHIFY_ARTIFACTS entries (dist/graphify/registry.snippet.ts):"
cat "$OUT/registry.snippet.ts"
