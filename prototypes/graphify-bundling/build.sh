#!/usr/bin/env bash
# SPIKE: reproducible freeze of graphify into standalone per-platform bundles.
# Feasibility artifact for docs/architecture/graphify-bundling.md — not wired
# into Hive's runtime or CI. Run from anywhere; builds into ./out beside this
# script.
#
# Requires: uv, zstd. For the darwin-x64 slice on an arm64 Mac: Rosetta 2.
# The Python interpreter and PyInstaller versions below are part of the
# reproducibility contract — bump them deliberately, like the graphify pin.
set -euo pipefail

PYTHON_KEY_ARM64="cpython-3.12.8-macos-aarch64-none"
PYTHON_KEY_X64="cpython-3.12.8-macos-x86_64-none"
PYINSTALLER_PIN="pyinstaller==6.21.0"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
LOCK="$REPO_ROOT/graphify.lock"
OUT="$HERE/out"

[ -f "$LOCK" ] || { echo "graphify.lock not found at $LOCK" >&2; exit 1; }
mkdir -p "$OUT"

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
  echo "== $arch: venv + hash-verified install =="
  rm -rf "$work" && mkdir -p "$work"
  uv python install "$py_key"
  uv venv --python "$py_key" "$venv" >/dev/null
  VIRTUAL_ENV="$venv" uv pip install --require-hashes -r "$LOCK" >/dev/null
  VIRTUAL_ENV="$venv" uv pip install "$PYINSTALLER_PIN" >/dev/null

  echo "== $arch: freeze =="
  (cd "$HERE" && "$venv/bin/pyinstaller" --noconfirm --clean \
      --distpath "$work/dist" --workpath "$work/build" graphify.spec >/dev/null)
  dist="$work/dist/graphify-dist"
  ln -sf graphify "$dist/graphify-mcp"

  echo "== $arch: smoke test (CLI extract + query, MCP query_graph) =="
  smoke "$dist" || { echo "$arch: SMOKE TEST FAILED" >&2; exit 1; }

  echo "== $arch: package =="
  local tarball="$OUT/graphify-$(grep -m1 '^graphifyy==' "$LOCK" | sed 's/graphifyy==//; s/ .*//')-darwin-$arch.tar.zst"
  tar -C "$work/dist" -cf - graphify-dist | zstd -19 -T0 -q -f -o "$tarball"
  shasum -a 256 "$tarball" | tee "$tarball.sha256"
}

build_one arm64 "$PYTHON_KEY_ARM64"
if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  echo "SKIPPED darwin-x64: Rosetta 2 not available on this machine" >&2
elif grep -qE '^cryptography==(49|[5-9][0-9])\.' "$LOCK"; then
  # Measured 2026-07-12: cryptography 49.0.0 publishes no macOS x86_64 wheel
  # (arm64 only) and its sdist build needs an x86_64 OpenSSL to link against.
  # Recompile the lock from graphify.in (which constrains cryptography<49,
  # universal2 wheels) before the x64 slice can build.
  echo "SKIPPED darwin-x64: lock pins cryptography>=49 (no x86_64 macOS wheel); recompile from graphify.in" >&2
  exit 1
else
  build_one x64 "$PYTHON_KEY_X64"
fi

echo "artifacts in $OUT:"
ls -lh "$OUT"/*.tar.zst
