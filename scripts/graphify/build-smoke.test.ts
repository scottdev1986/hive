// Runs build.sh's actual smoke function against scratch bundle binaries. The
// fake MCP server records its own PID and fixture directory so the test can
// prove cleanup removed both after success and after a measured smoke failure.

import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const buildScriptPath = join(import.meta.dir, "build.sh");
const buildScript = readFileSync(buildScriptPath, "utf8");
const smokeStart = buildScript.indexOf("smoke() (");
const smokeEnd = buildScript.indexOf("\n\nbuild_one()", smokeStart);
if (smokeStart < 0 || smokeEnd < 0)
  throw new Error("could not locate build.sh smoke function");
const smokeFunction = buildScript.slice(smokeStart, smokeEnd);

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function processListing(pid: number): string {
  return Bun.spawnSync(["ps", "-p", String(pid), "-o", "pid=,ppid=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  })
    .stdout.toString()
    .trim();
}

async function stopFixtureProcess(pidPath: string): Promise<void> {
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processIsLive(pid)) return;
  process.kill(pid, "SIGKILL");
  for (let attempt = 0; attempt < 50 && processIsLive(pid); attempt += 1) {
    await Bun.sleep(20);
  }
}

function createScratchBundle(
  root: string,
  smokePasses: boolean,
): {
  dist: string;
  pidPath: string;
  fixturePathRecord: string;
} {
  const dist = join(root, "dist");
  const pidPath = join(root, "server.pid");
  const fixturePathRecord = join(root, "fixture-path");
  const serverPath = join(root, "server.py");
  mkdirSync(dist, { recursive: true });
  writeExecutable(
    join(dist, "graphify"),
    [
      "#!/bin/bash",
      "set -eu",
      'case "$1" in',
      '  update) mkdir -p graphify-out; printf "{}\\n" > graphify-out/graph.json ;;',
      '  query) printf "helper\\n" ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeFileSync(
    serverPath,
    [
      "from http.server import BaseHTTPRequestHandler, HTTPServer",
      "import sys",
      "class Handler(BaseHTTPRequestHandler):",
      "    def do_POST(self):",
      `        body = b'{"isError":${smokePasses ? "false" : "true"}}'`,
      "        self.send_response(200)",
      '        self.send_header("Content-Type", "application/json")',
      '        self.send_header("Content-Length", str(len(body)))',
      "        self.end_headers()",
      "        self.wfile.write(body)",
      "    def log_message(self, format, *args):",
      "        pass",
      'port = int(sys.argv[sys.argv.index("--port") + 1])',
      'HTTPServer(("127.0.0.1", port), Handler).serve_forever()',
      "",
    ].join("\n"),
  );
  writeExecutable(
    join(dist, "graphify-mcp"),
    [
      "#!/bin/bash",
      `printf '%s\\n' "$$" > ${JSON.stringify(pidPath)}`,
      `pwd > ${JSON.stringify(fixturePathRecord)}`,
      `exec /usr/bin/python3 ${JSON.stringify(serverPath)} "$@"`,
      "",
    ].join("\n"),
  );
  return { dist, pidPath, fixturePathRecord };
}

function writeSmokeHarness(root: string, functionBody = smokeFunction): string {
  const harness = join(root, "run-smoke.sh");
  writeExecutable(
    harness,
    ["#!/bin/bash", "set -euo pipefail", functionBody, 'smoke "$1"', ""].join(
      "\n",
    ),
  );
  return harness;
}

function runSmoke(
  root: string,
  dist: string,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([writeSmokeHarness(root), dist], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
}

for (const smokePasses of [true, false]) {
  test(`the bundle smoke owns its server through ${smokePasses ? "success" : "failure"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "hive-graphify-smoke-"));
    const fixture = createScratchBundle(root, smokePasses);
    try {
      const result = runSmoke(root, fixture.dist);
      expect(result.exitCode).toBe(smokePasses ? 0 : 1);
      const serverPid = Number(readFileSync(fixture.pidPath, "utf8").trim());
      expect(processIsLive(serverPid)).toBe(false);
      expect(processListing(serverPid)).toBe("");
      const fixturePath = readFileSync(
        fixture.fixturePathRecord,
        "utf8",
      ).trim();
      expect(existsSync(fixturePath)).toBe(false);
    } finally {
      await stopFixtureProcess(fixture.pidPath);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
}

test("the bundle smoke owns its server through interrupt", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-graphify-smoke-"));
  const fixture = createScratchBundle(root, false);
  const smokePidPath = join(root, "smoke.pid");
  const instrumentedSmoke = smokeFunction.replace(
    '  local dist="$1" tmp fix port pid=""',
    [
      '  local dist="$1" tmp fix port pid=""',
      `  /bin/sh -c 'printf "%s\\n" "$PPID"' > ${JSON.stringify(smokePidPath)}`,
    ].join("\n"),
  );
  const child = Bun.spawn(
    [writeSmokeHarness(root, instrumentedSmoke), fixture.dist],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    for (
      let attempt = 0;
      attempt < 250 &&
      (!existsSync(fixture.pidPath) || !existsSync(smokePidPath));
      attempt += 1
    ) {
      await Bun.sleep(20);
    }
    if (!existsSync(smokePidPath)) {
      child.kill("SIGKILL");
      throw new Error(
        `smoke pid was not recorded: ${await new Response(child.stderr).text()}`,
      );
    }
    const smokePid = Number(readFileSync(smokePidPath, "utf8").trim());
    const serverPid = Number(readFileSync(fixture.pidPath, "utf8").trim());
    process.kill(smokePid, "SIGTERM");
    expect(await child.exited).toBe(130);
    expect(processIsLive(serverPid)).toBe(false);
    expect(processListing(serverPid)).toBe("");
    const fixturePath = readFileSync(fixture.fixturePathRecord, "utf8").trim();
    expect(existsSync(fixturePath)).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await stopFixtureProcess(fixture.pidPath);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("the background PID is bound to graphify-mcp by exec", () => {
  expect(smokeFunction).toContain('(cd "$fix" && exec env -i');
});
