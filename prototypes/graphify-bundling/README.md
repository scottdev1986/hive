# graphify-bundling spike

Feasibility record for shipping graphify as a Hive-built standalone bundle
(no uv, no Python on the user's machine). The measured findings and the chosen
design live in `docs/graphify/bundling.md`.

The build recipe that started here graduated to `scripts/graphify/`
(`build.sh`, `graphify.spec`, `entry.py`, `graphify.in`, `entitlements.plist`)
and is published by `.github/workflows/graphify-artifacts.yml`; this directory
keeps only what remains a measurement, not a release step:

- `linux-measure.sh` — the same freeze + smoke suite (CLI extract + query,
  MCP `query_graph` over HTTP, venv hidden) inside `python:3.12-slim`
  containers (linux-arm64 native, linux-x64 under emulation); invocation in
  its header. Hive ships no Linux binary today — this proves the future row.

Verified 2026-07-12 on macOS arm64 (Darwin 25.3.0), CPython 3.12.8,
PyInstaller 6.21.0, graphifyy 0.9.12.
