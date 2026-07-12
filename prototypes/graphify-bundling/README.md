# graphify-bundling spike

Feasibility artifacts for shipping graphify as a Hive-built standalone bundle
(no uv, no Python on the user's machine). The measured findings and the chosen
design live in `docs/architecture/graphify-bundling.md` — read that first;
this directory is the build recipe that produced them.

- `build.sh` — one command: hash-verified install from `graphify.lock`,
  PyInstaller freeze, smoke test (CLI extract + query, MCP `query_graph` over
  HTTP), tar.zst + sha256, for darwin-arm64 and (via Rosetta) darwin-x64.
- `graphify.spec` — the PyInstaller spec; collects the 26 tree-sitter grammar
  packages that graphify loads via dynamic `importlib.import_module`.
- `entry.py` — busybox-style dispatcher so one EXE serves both console
  scripts (`graphify`, `graphify-mcp` as a symlink).
- `graphify.in` — the lock-compile input, carrying the `cryptography<49`
  constraint the darwin-x64 slice requires.

Not wired into Hive's runtime or CI. Verified 2026-07-12 on macOS arm64
(Darwin 25.3.0), CPython 3.12.8, PyInstaller 6.21.0, graphifyy 0.9.12.
