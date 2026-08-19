// The Hive QA runner's testable core. run-qa.ts is the thin entrypoint that
// wires real dependencies; everything here takes its environment, process
// execution, oracle clients and sleep as parameters so the suite can construct
// each failing condition itself — no QA rig required.
//
// The reporting contract is the whole interface: one line per row,
// `PASS|FAIL|NO MEASUREMENT <row-id> <reason>`, and a process exit of 0 when
// every row passed, 1 when any row measured a product failure, 2 when any row
// could not be measured. A bound expiring is a fact about the rig, never a
// product failure, so it always lands on NO MEASUREMENT.
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Exec = (argv: readonly string[]) => Promise<ExecResult>;

export type RowStatus = "PASS" | "FAIL" | "NO MEASUREMENT";

export interface RowResult {
  id: string;
  status: RowStatus;
  reason: string;
}

/** The rig locations the runner cannot derive from the QA pins themselves; `make qa-run` passes them from the Makefile's own variables so runner and lifecycle can never disagree. */
export interface RigRoots {
  repoRoot: string;
  stagingRoot: string;
  devHome: string;
  userHive: string;
  project: string;
}

// The QA_ENV pin set from the Makefile, mirrored here so the preflight can
// refuse a rig that was brought up with any of them missing. Path pins must be
// absolute and none may resolve into the real ~/.hive; value pins must simply
// be present, with HIVE_QA pinned on.
const PATH_PINS = [
  "HIVE_HOME",
  "HIVE_DEFAULT_HOME",
  "HIVE_EMBEDDINGS_SOURCE",
  "HIVE_INSTALL_ROOT",
  "HIVE_BIN_LINK",
  "HIVE_BIN_DIR",
  "HIVE_GRAPHIFY_MANIFEST",
  "HIVE_SESSIOND_ROOT",
  "OTUI_ASSET_ROOT",
  "TMPDIR",
] as const;

const VALUE_PINS = ["HIVE_QA", "HIVE_DISABLE_UPDATES", "HIVE_PORT"] as const;

/** Canonicalize through symlinks like validate-isolation.sh does; a pin that does not exist yet (TMPDIR is created by the lifecycle) falls back to lexical resolution. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export interface PreflightDeps {
  env: Record<string, string | undefined>;
  exec: Exec;
  rig: RigRoots;
  validateIsolation: string;
}

export type PreflightOutcome =
  | { ok: true; qaBin: string; treeCommit: string; appVersion: string }
  | { ok: false; fence: string; reason: string };

function fail(fence: string, reason: string): PreflightOutcome {
  return { ok: false, fence, reason };
}

function checkPinSet(
  env: Record<string, string | undefined>,
  userHive: string,
): PreflightOutcome | null {
  for (const name of VALUE_PINS) {
    const value = env[name];
    if (value === undefined || value.length === 0) {
      return fail("pin-set", `${name} is not set`);
    }
  }
  if (env.HIVE_QA !== "1") {
    return fail("pin-set", `HIVE_QA must be 1, got '${env.HIVE_QA}'`);
  }
  const home = canonical(userHive);
  for (const name of PATH_PINS) {
    const value = env[name];
    if (value === undefined || value.length === 0) {
      return fail("pin-set", `${name} is not set`);
    }
    if (!isAbsolute(value)) {
      return fail("pin-set", `${name} is not absolute: ${value}`);
    }
    const resolved = canonical(value);
    if (resolved === home || resolved.startsWith(`${home}/`)) {
      return fail(
        "pin-set",
        `${name} resolves into the real user Hive home: ${resolved}`,
      );
    }
  }
  const hiveHome = env.HIVE_HOME as string;
  const defaultHome = env.HIVE_DEFAULT_HOME as string;
  if (canonical(hiveHome) !== canonical(defaultHome)) {
    return fail(
      "pin-set",
      `HIVE_HOME (${hiveHome}) and HIVE_DEFAULT_HOME (${defaultHome}) resolve to different homes`,
    );
  }
  return null;
}

async function checkIsolation(
  deps: PreflightDeps,
): Promise<PreflightOutcome | null> {
  const home = deps.env.HOME;
  if (home === undefined || home.length === 0) {
    return fail("isolation", "HOME is not set");
  }
  const result = await deps.exec([
    "sh",
    deps.validateIsolation,
    "qa",
    deps.rig.repoRoot,
    deps.rig.stagingRoot,
    join(home, ".hive"),
    deps.env.HIVE_HOME as string,
    deps.rig.devHome,
    deps.rig.userHive,
    deps.rig.project,
  ]);
  if (result.exitCode !== 0) {
    return fail(
      "isolation",
      result.stderr.trim() || `validate-isolation exited ${result.exitCode}`,
    );
  }
  return null;
}

function checkSessiondRoot(
  env: Record<string, string | undefined>,
  stagingRoot: string,
): PreflightOutcome | null {
  const root = canonical(env.HIVE_SESSIOND_ROOT as string);
  const staging = canonical(stagingRoot);
  if (root !== staging && !root.startsWith(`${staging}/`)) {
    return fail(
      "sessiond-root",
      `HIVE_SESSIOND_ROOT resolves outside the QA staging root: ${root}`,
    );
  }
  return null;
}

/** Fence: the binary under test must be the build of the tree under test. The QA build compiles `git rev-parse --short HEAD` into the CLI, and install.sh stages the Workspace app from the same tarball into the same version dir, so a `current/hive --version` that names this tree's commit shows the whole install corresponds. */
async function checkBuildIdentity(
  deps: PreflightDeps,
): Promise<PreflightOutcome> {
  const git = await deps.exec([
    "git",
    "-C",
    deps.rig.repoRoot,
    "rev-parse",
    "--short",
    "HEAD",
  ]);
  if (git.exitCode !== 0) {
    return fail(
      "build-identity",
      `git rev-parse HEAD failed: ${git.stderr.trim()}`,
    );
  }
  const treeCommit = git.stdout.trim();
  const installRoot = deps.env.HIVE_INSTALL_ROOT as string;
  const qaBin = join(installRoot, "current", "hive");
  const version = await deps.exec([qaBin, "--version"]);
  const match = /\(([0-9a-f]{7,40}),/.exec(version.stdout);
  if (version.exitCode !== 0 || match === null) {
    return fail(
      "build-identity",
      `could not read the QA build identity from ${qaBin} --version: ${version.stdout.trim()} ${version.stderr.trim()}`.trim(),
    );
  }
  if (match[1] !== treeCommit) {
    return fail(
      "build-identity",
      `QA binary was built from ${match[1]} but the tree under test is ${treeCommit}; rebuild the rig with make build-qa && make qa`,
    );
  }
  const plist = join(
    installRoot,
    "current",
    "HiveWorkspace.app",
    "Contents",
    "Info.plist",
  );
  const app = await deps.exec([
    "/usr/libexec/PlistBuddy",
    "-c",
    "Print :CFBundleShortVersionString",
    plist,
  ]);
  if (app.exitCode !== 0) {
    return fail(
      "build-identity",
      `no Workspace app beside the QA binary at ${plist}`,
    );
  }
  return {
    ok: true,
    qaBin,
    treeCommit,
    appVersion: app.stdout.trim(),
  };
}

/** The fence preflight. Runs before any row; any violation exits 2 naming the fence. */
export async function preflight(
  deps: PreflightDeps,
): Promise<PreflightOutcome> {
  const pins = checkPinSet(deps.env, deps.rig.userHive);
  if (pins !== null) return pins;
  const isolation = await checkIsolation(deps);
  if (isolation !== null) return isolation;
  const sessiond = checkSessiondRoot(deps.env, deps.rig.stagingRoot);
  if (sessiond !== null) return sessiond;
  return await checkBuildIdentity(deps);
}

/** The one bounded-wait primitive: poll until the predicate holds or the bound expires. A throwing probe (an oracle that refuses) counts as not-yet; only the bound decides, and expiry is always NO MEASUREMENT for the row. */
export async function waitFor<T>(
  probe: () => Promise<T | null>,
  boundMs: number,
  sleep: (ms: number) => Promise<void>,
  intervalMs = 100,
): Promise<{ state: "met"; value: T } | { state: "expired" }> {
  const deadline = Date.now() + boundMs;
  for (;;) {
    try {
      const value = await probe();
      if (value !== null) return { state: "met", value };
    } catch {
      // Not yet.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: "expired" };
    await sleep(Math.min(intervalMs, remaining));
  }
}

export function runnerExitCode(results: readonly RowResult[]): 0 | 1 | 2 {
  if (results.some((row) => row.status === "NO MEASUREMENT")) return 2;
  if (results.some((row) => row.status === "FAIL")) return 1;
  return 0;
}

export function formatRow(row: RowResult): string {
  return `${row.status} ${row.id} ${row.reason}`;
}

/** Parse the `hive credential --agent user` contract: a JSON object of headers on stdout. A raw header line is not JSON and must fail here, never reach a request. */
export function parseCredentialHeaders(stdout: string): Record<string, string> {
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("credential helper did not print a JSON header object");
  }
  for (const header of Object.values(value)) {
    if (typeof header !== "string") {
      throw new Error("credential helper printed a non-string header value");
    }
  }
  return value as Record<string, string>;
}

/** The oracle side: reads the daemon through the product's own MCP session and user HTTP client. Built by the entrypoint; rows receive null when the rig offers no port or credential, which they report as NO MEASUREMENT. */
export interface ObserveClients {
  httpStatus(path: string): Promise<number>;
  mcpCall(
    name: string,
    args: Record<string, unknown>,
    key: string,
  ): Promise<unknown>;
  close(): Promise<void>;
}

interface GateResponse {
  route?: string;
  reason?: string;
}

type GateAnswer =
  | { outcome: "answered"; exitCode: number; response: GateResponse }
  | { outcome: "no-measurement"; reason: string };

async function gate(
  exec: Exec,
  qaBin: string,
  verb: "enumerate" | "invoke",
  identifier?: string,
): Promise<GateAnswer> {
  const argv =
    identifier === undefined
      ? [qaBin, "qa-control", verb]
      : [qaBin, "qa-control", verb, identifier];
  const result = await exec(argv);
  if (result.exitCode === 2) {
    return {
      outcome: "no-measurement",
      reason:
        result.stderr.trim() || `qa-control ${verb} reported NO MEASUREMENT`,
    };
  }
  try {
    return {
      outcome: "answered",
      exitCode: result.exitCode,
      response: JSON.parse(result.stdout) as GateResponse,
    };
  } catch {
    return {
      outcome: "no-measurement",
      reason: `qa-control ${verb} printed no parseable response`,
    };
  }
}

/** The proof row: enumerate, invoke shell-nav-models, then assert on a SECOND enumerate that the route moved. The invoke response snapshots the pre-action route, so it is never consulted for post-state. */
export async function rowRouteTransition(
  exec: Exec,
  qaBin: string,
  sleep: (ms: number) => Promise<void>,
  boundMs = 5_000,
): Promise<RowResult> {
  const id = "QA1-01-route-transition";
  const first = await gate(exec, qaBin, "enumerate");
  if (first.outcome === "no-measurement") {
    return { id, status: "NO MEASUREMENT", reason: first.reason };
  }
  if (first.exitCode !== 0) {
    return {
      id,
      status: "FAIL",
      reason: first.response.reason ?? "enumerate reported a failure",
    };
  }
  const routeBefore = first.response.route;
  if (typeof routeBefore !== "string" || routeBefore.length === 0) {
    return {
      id,
      status: "FAIL",
      reason: "enumerate answered without a route",
    };
  }
  const invoke = await gate(exec, qaBin, "invoke", "shell-nav-models");
  if (invoke.outcome === "no-measurement") {
    return { id, status: "NO MEASUREMENT", reason: invoke.reason };
  }
  if (invoke.exitCode !== 0) {
    return {
      id,
      status: "FAIL",
      reason:
        invoke.response.reason ?? "invoke shell-nav-models reported a failure",
    };
  }
  let gateAlive = true;
  const moved = await waitFor(
    async () => {
      const again = await gate(exec, qaBin, "enumerate");
      if (again.outcome === "no-measurement") {
        gateAlive = false;
        return null;
      }
      gateAlive = true;
      const route = again.response.route;
      return typeof route === "string" && route !== routeBefore ? route : null;
    },
    boundMs,
    sleep,
  );
  if (moved.state === "met") {
    return {
      id,
      status: "PASS",
      reason: `route moved ${routeBefore} -> ${moved.value} on the second enumerate`,
    };
  }
  if (!gateAlive) {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: "the gate stopped answering after invoke",
    };
  }
  return {
    id,
    status: "FAIL",
    reason: `invoke shell-nav-models reported ok but the route stayed ${routeBefore}`,
  };
}

/** The observe-stack proof row: the daemon answers on the product's own HTTP client and MCP session with the user credential. */
export async function rowObserveClients(
  observe: ObserveClients | null,
  sleep: (ms: number) => Promise<void>,
  boundMs = 5_000,
): Promise<RowResult> {
  const id = "QA1-02-observe-clients";
  if (observe === null) {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: "no daemon port or user credential readable",
    };
  }
  const health = await waitFor(
    async () => await observe.httpStatus("/health"),
    boundMs,
    sleep,
  );
  if (health.state === "expired") {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: "daemon did not answer /health within the bound",
    };
  }
  if (health.value !== 200) {
    return {
      id,
      status: "FAIL",
      reason: `daemon /health answered ${health.value}`,
    };
  }
  try {
    await observe.mcpCall("hive_status", {}, "agents");
  } catch (error) {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: `hive_status over MCP refused: ${(error as Error).message}`,
    };
  }
  return {
    id,
    status: "PASS",
    reason: "daemon answered /health and hive_status with the user credential",
  };
}

export interface RunDeps extends PreflightDeps {
  buildObserve: (qaBin: string) => Promise<ObserveClients | null>;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Preflight, then the rows, then the 0/1/2 exit. The build identity the preflight proved is recorded on stderr so the row lines on stdout stay the whole reporting contract. */
export async function runQA(deps: RunDeps): Promise<number> {
  const fence = await preflight(deps);
  if (!fence.ok) {
    deps.err(`NO MEASUREMENT preflight fence ${fence.fence}: ${fence.reason}`);
    return 2;
  }
  deps.err(
    `qa-runner: build identity tree=${fence.treeCommit} app=${fence.appVersion} (cli and app proved to correspond)`,
  );
  const observe = await deps.buildObserve(fence.qaBin);
  const rows = [
    await rowRouteTransition(deps.exec, fence.qaBin, deps.sleep),
    await rowObserveClients(observe, deps.sleep),
  ];
  if (observe !== null) {
    await observe.close().catch(() => undefined);
  }
  for (const row of rows) {
    deps.out(formatRow(row));
  }
  return runnerExitCode(rows);
}
