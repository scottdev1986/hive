#!/usr/bin/env bun
/**
 * Acceptance proof: a wide concurrent spawn keeps every agent alive past the
 * first visibility-lease window with renewals actually landing.
 *
 * Restarts the staged dev daemon, spawns WIDTH agents RUNS times, prints a
 * per-run tally. Pass only if all agents survive first lease expiry AND every
 * binding lease is still in the future at check time (renewal measured, not
 * inferred from "agents alive").
 *
 * Load-bearing because a large concurrent spawn saturates both the daemon's
 * single-threaded loop and sessiond's serialized broker accept loop; each
 * slows the other (every broker HELLO fetches /handshake). Fixed budgets do
 * not scale with in-flight spawns — agents die VISIBILITY_EXPIRED when
 * renewals never land. This is the regression gate for that mode.
 *
 * Usage:
 *   bun run scripts/spawn-31-proof.ts [--build] [--runs 5] [--width 31] [--no-restart]
 *
 *   --build       run `make build` first to stage a fresh dev binary
 *   --no-restart  skip the daemon restart (proof against the running daemon)
 *
 * Environment matches `make run`. Workspace + queen must be up; a one-agent
 * canary aborts with diagnostics if renewal cannot land.
 *
 * Exit 0 = all runs at full width. Any dropped agent FAILs with failureReason.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const DEV = join(REPO_ROOT, ".dev");
const INSTALL_ROOT = join(DEV, "root");
const HIVE_BIN = join(INSTALL_ROOT, "current", "hive");
const DEV_HOME_TAG = createHash("sha256")
  .update(REPO_ROOT)
  .digest("hex")
  .slice(0, 10);
const HIVE_HOME = process.env.HIVE_HOME ?? `/tmp/hv-${DEV_HOME_TAG}`;
const DAEMON_STARTUP_LOG = join(DEV, "daemon-startup.log");

const args = new Set(process.argv.slice(2));
const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1] || 5);
const WIDTH = Number(process.argv[process.argv.indexOf("--width") + 1] || 31);
const DO_RESTART = !args.has("--no-restart");

// first 15s lease + renewal cadence + margin; canary and runs share it.
const RUN_SETTLE_MS = 40_000;
const ADMIT_TIMEOUT_MS = 180_000;

function fail(message: string): never {
  console.error(`PROOF ABORT: ${message}`);
  process.exit(1);
}

function sh(command: string, argv: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, argv, {
    env: env ?? process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(
      `${command} ${argv.join(" ")} exited ${result.status}: ${result.stderr?.slice(0, 400)}`,
    );
  }
  return result.stdout;
}

const devEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HIVE_HOME,
  HIVE_EMBEDDINGS_SOURCE: REPO_ROOT,
  HIVE_INSTALL_ROOT: INSTALL_ROOT,
  HIVE_BIN_LINK: join(DEV, "bin", "hive"),
  HIVE_DISABLE_UPDATES: "1",
  HIVE_GRAPHIFY_MANIFEST: join(DEV, "graphify", "graphify-runtime.json"),
  HIVE_PORT: "0",
  TMPDIR: join(DEV, "tmp"),
};

function daemonPort(): number {
  const port = Number(
    readFileSync(join(HIVE_HOME, "daemon.port"), "utf8").trim(),
  );
  if (!Number.isInteger(port) || port <= 0)
    fail(`bad daemon.port in ${HIVE_HOME}`);
  return port;
}

function operatorToken(): string {
  // `hive credential` prints the header map the MCP transport authenticates
  // with; stateless transport, one bearer per request.
  const out = sh(
    HIVE_BIN,
    ["credential", "--agent", "operator"],
    devEnv,
  ).trim();
  const headers = JSON.parse(out) as Record<string, string>;
  const auth = headers.Authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    fail(`hive credential returned no bearer: ${out.slice(0, 120)}`);
  }
  return auth.slice("Bearer ".length);
}

let rpcId = 0;
async function mcpCall(
  token: string,
  name: string,
  args_: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${daemonPort()}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name, arguments: args_ },
    }),
  });
  const body = (await response.json()) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (body.error) fail(`MCP ${name} rejected: ${body.error.message}`);
  const text = body.result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type AgentRow = {
  name: string;
  status: string;
  failureReason: string | null;
};

function runAgents(db: Database, prefix: string): AgentRow[] {
  return db
    .query(
      `SELECT name, status, failureReason FROM agents WHERE name LIKE ? ORDER BY name`,
    )
    .all(`${prefix}-%`) as AgentRow[];
}

/** Renewal measured on the wire: the daemon writes each landed lease into
 * the binding's create evidence. A lease expiring in the future at check
 * time means a renewal landed inside the last 15 s. */
function renewedSessions(db: Database): Map<string, number> {
  const rows = db
    .query(
      `SELECT locatorSessionId, createEvidenceJson FROM terminal_host_bindings`,
    )
    .all() as Array<{
    locatorSessionId: string;
    createEvidenceJson: string | null;
  }>;
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.createEvidenceJson === null) continue;
    const evidence = JSON.parse(row.createEvidenceJson) as {
      visibility?: { expiresAt?: string };
    };
    const expiresAt = Date.parse(evidence.visibility?.expiresAt ?? "");
    if (!Number.isNaN(expiresAt)) out.set(row.locatorSessionId, expiresAt);
  }
  return out;
}

function agentSessionId(db: Database, name: string): string | null {
  const row = db
    .query(`SELECT sessionLocator FROM agents WHERE name = ?`)
    .get(name) as { sessionLocator: string } | null;
  if (row === null) return null;
  return (JSON.parse(row.sessionLocator) as { sessionId: string }).sessionId;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stopDaemon(): void {
  const pidPath = join(HIVE_HOME, "daemon.pid");
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 1) return;
  console.log(`stopping daemon pid ${pid} (SIGTERM)…`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    spawnSync("sleep", ["1"]);
  }
  console.log("daemon did not stop in 30s; SIGKILL");
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function startDaemon(): number {
  console.log("provisioning (hive init)…");
  sh(HIVE_BIN, ["init"], devEnv);
  console.log("starting daemon…");
  const child = Bun.spawn([HIVE_BIN, "daemon"], {
    cwd: REPO_ROOT,
    env: devEnv,
    stdout: Bun.file(DAEMON_STARTUP_LOG),
    stderr: Bun.file(DAEMON_STARTUP_LOG),
    stdin: "ignore",
  });
  console.log("verifying the daemon is ready (scripts/verify-dev-run.ts)…");
  const verify = spawnSync(
    "bun",
    [
      "run",
      join(REPO_ROOT, "scripts/verify-dev-run.ts"),
      DAEMON_STARTUP_LOG,
      HIVE_BIN,
      REPO_ROOT,
      String(child.pid),
      HIVE_HOME,
    ],
    { env: devEnv, encoding: "utf8" },
  );
  if (verify.status !== 0) {
    try {
      child.kill();
    } catch {}
    fail(`verify-dev-run failed:\n${verify.stdout}\n${verify.stderr}`);
  }
  return child.pid;
}

type SpawnOutcome = { ok: boolean; agent?: { name?: string }; error?: string };

async function spawnWidth(token: string, prefix: string, width: number) {
  const requests = Array.from({ length: width }, (_, i) => ({
    name: `${prefix}-${String(i + 1).padStart(2, "0")}`,
    task:
      "Spawn-collapse acceptance canary. Do not edit any files. " +
      "Immediately report your status complete; this task has no other content.",
    category: "light_research",
    readOnly: true,
  }));
  const result = (await mcpCall(token, "hive_spawn_many", { requests })) as
    | { results?: SpawnOutcome[] }
    | SpawnOutcome[];
  const list = Array.isArray(result) ? result : (result.results ?? []);
  return list;
}

async function killPrefix(token: string, db: Database, prefix: string) {
  for (const agent of runAgents(db, prefix)) {
    if (agent.status === "dead" || agent.status === "failed") continue;
    await mcpCall(token, "hive_kill", {
      name: agent.name,
      removeWorktree: true,
      discardWork: true,
    }).catch(() => undefined);
  }
}

interface RunReport {
  run: number;
  admitted: number;
  aliveAtSettle: number;
  renewedAtSettle: number;
  failures: string[];
}

async function oneRun(token: string, run: number): Promise<RunReport> {
  const prefix = `proof-r${run}`;
  const db = new Database(join(HIVE_HOME, "hive.db"), { readonly: true });
  try {
    const outcomes = await spawnWidth(token, prefix, WIDTH);
    const admitted = outcomes.filter((outcome) => outcome.ok).length;
    const refused = outcomes
      .filter((outcome) => !outcome.ok)
      .map((outcome) => outcome.error ?? "refused");
    const started = Date.now();

    // Wait for admissions to settle into working or a terminal state.
    const deadline = started + ADMIT_TIMEOUT_MS;
    for (;;) {
      const rows = runAgents(db, prefix);
      const working = rows.filter((row) => row.status === "working").length;
      const terminal = rows.filter((row) =>
        ["failed", "stuck", "dead", "lost"].includes(row.status),
      ).length;
      if (working + terminal >= admitted || Date.now() > deadline) break;
      await sleep(2_000);
    }

    // Settle past the first 15 s lease, then measure liveness AND renewal.
    const settleAt = started + RUN_SETTLE_MS;
    if (Date.now() < settleAt) await sleep(settleAt - Date.now());
    const rows = runAgents(db, prefix);
    const leases = renewedSessions(db);
    const now = Date.now();
    const failures: string[] = [...refused];
    let alive = 0;
    let renewed = 0;
    for (const row of rows) {
      if (row.status !== "working") {
        failures.push(
          `${row.name}: status=${row.status} reason=${row.failureReason ?? "-"}`,
        );
        continue;
      }
      alive += 1;
      const sessionId = agentSessionId(db, row.name);
      const expiresAt = sessionId === null ? undefined : leases.get(sessionId);
      if (expiresAt !== undefined && expiresAt > now + 3_000) renewed += 1;
      else failures.push(`${row.name}: alive but lease not renewing`);
    }
    await killPrefix(token, db, prefix);
    return {
      run,
      admitted,
      aliveAtSettle: alive,
      renewedAtSettle: renewed,
      failures,
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  if (!existsSync(HIVE_BIN))
    fail(`no dev build at ${HIVE_BIN}; run 'make build' first (or --build)`);
  if (args.has("--build")) {
    console.log("make build…");
    sh("make", ["build"], { ...process.env });
  }
  if (DO_RESTART) {
    stopDaemon();
    startDaemon();
  }
  const token = operatorToken();

  // Canary: one agent must come up and renew before 31 are asked for. This
  // is also the proof that the Workspace is attached and the rig can renew
  // at all — the positive control for every absent-signal check below.
  console.log("canary: one agent, settling 40s past the first lease…");
  const canary = await oneRun(token, 0);
  if (
    canary.admitted !== 1 ||
    canary.aliveAtSettle !== 1 ||
    canary.renewedAtSettle !== 1
  ) {
    fail(
      `canary failed (admitted=${canary.admitted} alive=${canary.aliveAtSettle} renewed=${canary.renewedAtSettle}): ` +
        canary.failures.join("; "),
    );
  }
  console.log("canary OK: alive and renewing past the first lease.");

  const reports: RunReport[] = [];
  for (let run = 1; run <= RUNS; run += 1) {
    console.log(`run ${run}/${RUNS}: spawning ${WIDTH}…`);
    const report = await oneRun(token, run);
    reports.push(report);
    console.log(
      `run ${run}: admitted=${report.admitted}/${WIDTH} alive=${report.aliveAtSettle}/${WIDTH} renewing=${report.renewedAtSettle}/${WIDTH}` +
        (report.failures.length > 0
          ? `\n  ${report.failures.join("\n  ")}`
          : ""),
    );
  }

  const passed = reports.filter(
    (report) =>
      report.admitted === WIDTH &&
      report.aliveAtSettle === WIDTH &&
      report.renewedAtSettle === WIDTH,
  ).length;
  console.log(
    passed === RUNS
      ? `PROOF PASS: ${passed}/${RUNS} runs at ${WIDTH}/${WIDTH} alive and renewing`
      : `PROOF FAIL: ${passed}/${RUNS} runs passed`,
  );
  process.exit(passed === RUNS ? 0 : 1);
}

await main();
