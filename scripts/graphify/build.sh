#!/usr/bin/env bash
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
ARCH=all
while [ $# -gt 0 ]; do
  case "$1" in
    --build-number) BUILD_NUMBER="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$ARCH" in arm64|x64|all) ;; *) echo "invalid --arch $ARCH" >&2; exit 2;; esac

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

smoke() ( # smoke <bundle-dir>  — extract, query, and MCP-serve a fixture
  local dist="$1" tmp fix port pid=""
  tmp="$(mktemp -d)"
  fix="$tmp/fixture"
  cleanup() {
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -rf "$tmp"
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  mkdir -p "$fix/src"
  printf 'def helper():\n    return 1\n\ndef caller():\n    return helper()\n' > "$fix/src/a.py"
  printf 'export function load(): number { return 0 }\n' > "$fix/src/b.ts"
  (cd "$fix" && env -i PATH=/usr/bin:/bin HOME="$HOME" "$dist/graphify" update . >/dev/null 2>&1)
  (cd "$fix" && env -i PATH=/usr/bin:/bin HOME="$HOME" "$dist/graphify" query "who calls helper" 2>/dev/null | grep -q "helper")
  port="$(/usr/bin/python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
  (cd "$fix" && env -i PATH=/usr/bin:/bin HOME="$HOME" "$dist/graphify-mcp" --transport http --host 127.0.0.1 --port "$port" \
      --stateless --json-response graphify-out/graph.json >/dev/null 2>&1) &
  pid=$!
  for _ in {1..50}; do
    kill -0 "$pid" 2>/dev/null || return 1
    if curl -sf --max-time 1 -X POST "http://127.0.0.1:$port/mcp" \
        -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_graph","arguments":{"question":"who calls helper"}}}' \
        | grep -q '"isError":false'; then
      return 0
    fi
    sleep 0.1
  done
  return 1
)

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

if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "all" ]; then
  build_one arm64 "$PYTHON_KEY_ARM64"
fi
if [ "$ARCH" = "x64" ] || [ "$ARCH" = "all" ]; then
  if arch -x86_64 /usr/bin/true 2>/dev/null; then
    build_one x64 "$PYTHON_KEY_X64"
  else
    echo "darwin-x64 requires Rosetta 2" >&2
    exit 1
  fi
fi

echo
echo "artifacts in $OUT (release tag: $TAG):"
ls -lh "$OUT"/*.tar.zst
