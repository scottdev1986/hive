#!/bin/sh
# Runs INSIDE a python:3.12-slim container. Mirrors the darwin measurement:
# hash-verified install, PyInstaller freeze, then smoke with the venv hidden.
#
# From this directory, with a cryptography<49 lock (see graphify.in) copied
# in as graphify-crypt48.lock:
#   docker run --rm --platform linux/arm64 -v "$PWD:/w" python:3.12-slim sh /w/linux-measure.sh
#   docker run --rm --platform linux/amd64 -v "$PWD:/w" python:3.12-slim sh /w/linux-measure.sh
# Note python:3.12-slim is Debian 13 (glibc 2.41): fine for measuring, too
# new as a compatibility floor for a shipping build.
set -eu

cd /w
# PyInstaller on Linux requires objdump (binutils) — measured: the freeze
# aborts without it on python:3.12-slim.
apt-get update -qq >/dev/null && apt-get install -y -qq binutils zstd >/dev/null
python -m venv /venv
/venv/bin/pip install -q --require-hashes -r graphify-crypt48.lock
/venv/bin/pip install -q pyinstaller==6.21.0

mkdir -p /build && cp entry.py graphify.spec /build/ && cd /build
/venv/bin/pyinstaller --noconfirm --clean graphify.spec >/pyi.log 2>&1 || { tail -30 /pyi.log; exit 1; }
DIST=/build/dist/graphify-dist
ln -sf graphify "$DIST/graphify-mcp"

# fixture: same nine languages as the darwin measurement
FIX=/fixture/src; mkdir -p "$FIX"; cd /fixture
cat > "$FIX/greeter.py" <<'EOF'
class Greeter:
    def __init__(self, name):
        self.name = name
    def greet(self):
        return format_greeting(self.name)
def format_greeting(name):
    return f"Hello, {name}!"
EOF
printf 'export function loadConfig(p: string) { return { p } }\nexport class App { run() { return loadConfig("x") } }\n' > "$FIX/main.ts"
printf 'package util\n\nfunc Add(a int, b int) int {\n\treturn a + b\n}\n' > "$FIX/util.go"
printf 'pub fn parse(input: &str) -> usize { input.len() }\npub struct Lexer { pos: usize }\n' > "$FIX/lexer.rs"
printf 'public class Server {\n  public void start() { init(); }\n  private void init() {}\n}\n' > "$FIX/Server.java"
printf 'class Worker\n  def perform\n    log("run")\n  end\n  def log(msg); end\nend\n' > "$FIX/worker.rb"
printf 'class Cache(val size: Int) {\n  fun get(key: String): String? = null\n}\n' > "$FIX/Cache.kt"
printf 'struct Point { var x: Double\n  func norm() -> Double { return x }\n}\n' > "$FIX/point.swift"
printf '#include <string>\nclass Engine {\npublic:\n  void run();\n};\nvoid Engine::run() {}\n' > "$FIX/engine.cpp"

mv /venv /venv-hidden

echo "=== linux frozen version ==="
env -i PATH=/usr/bin:/bin HOME=/root "$DIST/graphify" --version
echo "=== linux frozen extract ==="
env -i PATH=/usr/bin:/bin HOME=/root "$DIST/graphify" update . 2>&1 | grep Rebuilt
echo "=== linux frozen query ==="
env -i PATH=/usr/bin:/bin HOME=/root "$DIST/graphify" query "who calls format_greeting" 2>&1 | head -3
echo "=== linux frozen MCP ==="
env -i PATH=/usr/bin:/bin HOME=/root "$DIST/graphify-mcp" --transport http --host 127.0.0.1 --port 8974 --stateless --json-response graphify-out/graph.json >/mcp.log 2>&1 &
MP=$!
sleep 4
python3 - <<'EOF'
import json, urllib.request
req = urllib.request.Request(
    "http://127.0.0.1:8974/mcp",
    data=json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                     "params": {"name": "query_graph",
                                "arguments": {"question": "who calls format_greeting"}}}).encode(),
    headers={"Content-Type": "application/json",
             "Accept": "application/json, text/event-stream"})
print(urllib.request.urlopen(req, timeout=10).read().decode()[:300])
EOF
kill $MP 2>/dev/null || true
echo "=== languages extracted ==="
python3 -c "
import json
from collections import Counter
g = json.load(open('/fixture/graphify-out/graph.json'))
exts = Counter((n.get('source_file') or '').rsplit('.',1)[-1] for n in g['nodes'] if n.get('source_file'))
print(dict(sorted(exts.items())))
"
echo "=== sizes ==="
du -sm "$DIST"
tar -C /build/dist -czf /tmp/g.tar.gz graphify-dist && ls -l /tmp/g.tar.gz | awk '{print $5" bytes tar.gz"}'
tar -C /build/dist -cf - graphify-dist | zstd -19 -T0 -q -o /tmp/g.tar.zst -f && ls -l /tmp/g.tar.zst | awk '{print $5" bytes tar.zst"}'
echo "=== glibc of build base ==="
ldd --version | head -1
echo "LINUX MEASUREMENT COMPLETE arch=$(uname -m)"
