// Runs the canonical provider attempts against one already-running private rig.
// The default requires five live TUIs. The explicit partial scope keeps
// blocked providers typed and non-passing while it measures every live route,
// exact-locator viewer attempt, and cleanup obligation before returning.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { agentFetch, userFetch } from "../../src/cli/credential";
import { macProcessIdentity } from "../../src/daemon/lifecycle/daemon-lifecycle";
import { hostDirectory } from "../../src/daemon/session-host/host-operations";
import {
  mintSessionRequestId,
  sameSessionLocator,
} from "../../src/daemon/session-host/locators";
import { SessiondViewerAttachClient } from "../../src/daemon/session-host/sessiond-viewer-attach";
import { WorkspaceVisibleTerminalSchema } from "../../src/daemon/session-host/workspace-visibility";
import { type AgentRecord, AgentRecordSchema } from "../../src/schemas/agent";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  CapabilityProviderSchema,
} from "../../src/schemas/capability";
import {
  LiveRunControlIntentSchema,
  LiveRunControlProjectionSchema,
  LiveRunControlResultSchema,
  type LiveRunControlIntent,
  type LiveRunControlProjection,
} from "../../src/schemas/live-run-control";
import {
  CandidateEffortSchema,
  RouterModeSchema,
  RoutingCategorySchema,
  type RoutingPolicy,
  RoutingPolicyMutationSchema,
  RoutingPolicySchema,
} from "../../src/schemas/routing-policy";
import {
  AttachGrantSchema,
  CaptureResultSchema,
  type SessionLocator,
} from "../../src/schemas/session-protocol";
import {
  callMcpTool,
  McpToolRefusal,
  requiredQaCoordinates,
} from "./qa-client";
import { qaRepoRoot } from "./repo-root";
import {
  agentStandardsRefusalMessage,
  classifyViewerReadback,
  buildProviderMatrix,
  disclosedMatrixRow,
  explicitRefusalReadbackState,
  finalU5Result,
  headlessRootReapVerdict,
  liveRunControlSubjectReady,
  proofSubjectLiveness,
  reconcileSpawnRequests,
  assertIsolatedQaHiveHome,
  assertQaHomeFitsSocketPath,
  assertSessiondEmbedsTreeSchema,
  isIsolatedQaHomePath,
  requireHeadlessRootRunning,
  requireParsedAgentStandards,
  SESSION_PROTOCOL_SCHEMA_RELATIVE,
  requireU5AccountabilityTaskId,
  requireU5WorkspaceApp,
  resolveU5Scope,
  spawnRefusalProofError,
  stageIsolatedProjectAgentStandards,
  summarizeProviderOutcomes,
  U5_REQUIRED_LIVE_PROVIDERS,
  type U5ProviderOutcome,
  type U5SpawnRequest,
} from "./u5-terminal-workbench-core";

const ProviderAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    count: z.number().int().nonnegative(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.string().min(1),
  }),
]);
const InventoryModelSchema = z.strictObject({
  vendor: CapabilityProviderSchema,
  canonicalId: z.string().min(1),
  variant: z.string().min(1).nullable(),
  displayName: z.string().min(1).nullable(),
  aliases: z.array(z.string().min(1)),
  effortLevels: z.discriminatedUnion("state", [
    z.strictObject({
      state: z.literal("known"),
      values: z.array(z.string().min(1)),
    }),
    z.strictObject({
      state: z.literal("known-none"),
      detail: z.string().min(1),
    }),
    z.strictObject({ state: z.literal("unknown"), reason: z.string().min(1) }),
  ]),
  entitlement: z.enum(["entitled", "not-entitled", "unknown"]),
  hidden: z.enum(["hidden", "visible", "unknown"]),
  plan: z.strictObject({
    status: z.enum(["covered", "unavailable", "would-spend", "unknown"]),
    detail: z.string(),
  }),
  routedCandidate: z.boolean(),
  roles: z.array(
    z.strictObject({
      scope: z.union([RoutingCategorySchema, z.literal("global")]),
      mode: RouterModeSchema,
      weight: z.number().int().min(1).max(100),
      effort: CandidateEffortSchema,
    }),
  ),
  when: z.string(),
  provenance: z.strictObject({
    observedAt: z.iso.datetime({ offset: true }),
    surface: z.string().min(1),
    cliVersion: z.string().min(1),
  }),
});
const ModelInventorySchema = z.strictObject({
  observedAt: z.iso.datetime({ offset: true }),
  complete: z.boolean(),
  discoveredCount: z.number().int().nonnegative(),
  renderedCount: z.number().int().nonnegative(),
  providers: z.strictObject({
    claude: ProviderAvailabilitySchema,
    codex: ProviderAvailabilitySchema,
    grok: ProviderAvailabilitySchema,
    kimi: ProviderAvailabilitySchema,
    opencode: ProviderAvailabilitySchema,
  }),
  models: z.array(InventoryModelSchema),
  warnings: z.array(z.string()),
});
const SpawnSummarySchema = z.object({ id: z.string().min(1) }).loose();
const TerminalObservationSchema = z.strictObject({
  capture: CaptureResultSchema,
  auditEventSeq: z.string().regex(/^[0-9]+$/),
});
const AttachGrantResponseSchema = z.strictObject({
  state: z.literal("granted"),
  grant: AttachGrantSchema,
});
const ReapedProcessSchema = z.strictObject({
  pid: z.number().int().positive(),
  command: z.string().min(1),
});
const HiveKillResultSchema = z
  .object({
    agent: AgentRecordSchema,
    reaped: z.strictObject({
      killed: z.array(ReapedProcessSchema),
      survivors: z.array(ReapedProcessSchema),
    }),
  })
  .loose();
// How the app died, and the proof of it, as one of two named outcomes.
//
// The driver kills a Workspace that /usr/bin/open handed to launchd, so the
// shell that killed it is not its parent and has no wait status to collect for
// it. `wait` answers 127 there, but a child that genuinely exits 127 answers
// 127 too, so a single field cannot carry both meanings honestly.
//
// Each member carries its own proof of death rather than leaving that to a
// field beside them: reaped-as-child proves it with the reaped status plus the
// post-kill readback, confirmed-dead-by-observation proves it with the identity
// probe. waitStatus is a MEASURED value, so it is matched as a number and never
// as an expected constant — pinning it to "137" would throw away the very
// observation the driver takes care to record.
const AppLifecycleTerminationSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("reaped-as-child"),
    waitStatus: z.string().regex(/^[0-9]+$/),
    postKillReadback: z.string().min(1),
  }),
  z.strictObject({
    outcome: z.literal("confirmed-dead-by-observation"),
    identityProbe: z.string().min(1),
  }),
]);
const AppLifecycleReleaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  viewerPid: z.number().int().positive(),
  executablePath: z.string().min(1),
  launchArguments: z.array(z.string().min(1)),
  launchedAt: z.iso.datetime({ offset: true }),
  preKillProcessReadback: z.string().min(1),
  sigkillIssuedAt: z.iso.datetime({ offset: true }),
  termination: AppLifecycleTerminationSchema,
  screenshots: z.array(z.string().min(1)).min(1),
});
const WorkspaceFeedReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.enum(["snapshot-emitted", "visibility-accepted"]),
  emittedAt: z.iso.datetime({ offset: true }),
  sourceReadyPath: z.string().min(1),
  agentCount: z.number().int().nonnegative(),
  agents: z.array(z.record(z.string(), z.unknown())),
  acceptedVisibility: z.array(
    z.strictObject({
      acceptedAt: z.iso.datetime({ offset: true }),
      appInventoryRevision: z.string().regex(/^[1-9][0-9]*$/),
      publishedInventoryRevision: z.string().regex(/^[1-9][0-9]*$/),
      terminalCount: z.number().int().nonnegative(),
      terminals: z.array(WorkspaceVisibleTerminalSchema),
      durationMs: z.number().nonnegative(),
    }),
  ),
});

type InventoryModel = z.infer<typeof InventoryModelSchema>;
type ModelInventory = z.infer<typeof ModelInventorySchema>;
type AppLifecycleRelease = z.infer<typeof AppLifecycleReleaseSchema>;
type ProcessReadback =
  | {
      state: "live";
      pid: number;
      startToken: string;
      executablePath: string;
      psExitCode: number;
      stdout: string;
      stderr: string;
    }
  | {
      state: "absent" | "unknown";
      pid: number;
      psExitCode: number;
      stdout: string;
      stderr: string;
    };

const { scope, scopedPartial, attemptProviders } = resolveU5Scope(
  process.env.HIVE_QA_U5_SCOPE,
);
const requiredLiveProviders = U5_REQUIRED_LIVE_PROVIDERS;
const kimiHardRoute = "kimi-code/k3";
const grokQuotaProbeRoute = "grok-4.5";

interface ProviderOutcomeRecord {
  provider: CapabilityProvider;
  outcome: U5ProviderOutcome;
  attemptOrdinal: 1;
  attemptedAt: string;
  retryAttempted: false;
  [key: string]: unknown;
}

type SpawnRequestRecord = U5SpawnRequest & {
  refusalReadback?: Record<string, unknown>;
};

class ObservedProviderBlock extends Error {
  constructor(
    readonly outcome: "quota-blocked" | "schema-blocked" | "launch-refused",
    readonly cause: string,
    readonly phase: string,
    readonly captureSha256?: string,
  ) {
    super(cause);
    this.name = "ObservedProviderBlock";
  }
}

const coordinates = requiredQaCoordinates();
mkdirSync(coordinates.artifacts, { recursive: true });
const home = realpathSync(coordinates.home);
const project = realpathSync(coordinates.project);
const artifacts = realpathSync(coordinates.artifacts);
const sourceRoot = realpathSync(coordinates.sourceRoot);
const scriptSourceRoot = qaRepoRoot(import.meta.dir);

if (!isIsolatedQaHomePath(home)) {
  throw new Error(`QA home is not an isolated short rig: ${home}`);
}
assertQaHomeFitsSocketPath(home);
if (!project.startsWith("/private/tmp/") && !project.startsWith("/tmp/")) {
  throw new Error(
    `QA project is not isolated under the temporary root: ${project}`,
  );
}
if (project === "/Users/scottkellar/Projects/hive-test-project") {
  throw new Error("refusing the shared hive-test-project");
}
if (!artifacts.startsWith(`${home}/`)) {
  throw new Error(`artifact directory is outside the QA home: ${artifacts}`);
}
if (sourceRoot !== scriptSourceRoot) {
  throw new Error(
    `running daemon source ${sourceRoot} does not match harness source ${scriptSourceRoot}`,
  );
}

const workspaceApp = requireU5WorkspaceApp(process.env);
const isolatedHiveHome = assertIsolatedQaHiveHome(
  process.env.HIVE_HOME ?? "",
  join(homedir(), ".hive"),
);
if (isolatedHiveHome !== home) {
  throw new Error(
    `HIVE_HOME ${isolatedHiveHome} is not the isolated QA home ${home}`,
  );
}
const liveAccountabilityTaskId = requireU5AccountabilityTaskId(process.env);
const appExecutablePath = realpathSync(workspaceApp.executablePath);
if (
  !appExecutablePath.endsWith("/HiveWorkspace.app/Contents/MacOS/HiveWorkspace")
) {
  throw new Error(
    `HIVE_QA_U5_APP_EXECUTABLE is not an exact Workspace binary: ${appExecutablePath}`,
  );
}
const appReadyPath = resolve(workspaceApp.readyPath);
const appReleasePath = resolve(workspaceApp.releasePath);
const appFeedReceiptPath = resolve(workspaceApp.feedReceiptPath);
for (const path of [appReadyPath, appReleasePath, appFeedReceiptPath]) {
  if (!path.startsWith(`${artifacts}/`)) {
    throw new Error(
      `app proof rendezvous is outside the artifact root: ${path}`,
    );
  }
  if (existsSync(path)) {
    throw new Error(`app proof rendezvous already exists: ${path}`);
  }
}

process.env.HIVE_HOME = home;
const rootFetch = agentFetch("queen");
const port = coordinates.port;
const startedAt = new Date().toISOString();
const runId = `u5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const taskMarker = `HIVE_QA_U5_WORKBENCH_${runId}`;
const evidenceRoot = join(artifacts, "u5-terminal-workbench-live", runId);
mkdirSync(evidenceRoot, { recursive: true });

const geometry = {
  columns: 120,
  rows: 40,
  widthPx: 960,
  heightPx: 640,
  cellWidthPx: 8,
  cellHeightPx: 16,
} as const;
const terminalStatuses = new Set(["dead", "done"]);
const ownedIds = new Set<string>();
const ownedNames = new Map<string, string>();
const selectedModels = new Map<CapabilityProvider, InventoryModel>();
const selectedModelOverrides = new Map<CapabilityProvider, string>();
const providerOutcomes = new Map<CapabilityProvider, ProviderOutcomeRecord>();
const spawnRequests: SpawnRequestRecord[] = [];
const survivingSentinel = Bun.spawn(["/bin/sleep", "3600"], {
  stdout: "ignore",
  stderr: "ignore",
});
let interruptedBy: "SIGINT" | "SIGTERM" | null = null;
let initialPolicy: RoutingPolicy | null = null;
let initialAgentIds = new Set<string>();
let initialProjectHead = "";
let initialProjectStatus = "";
let initialProjectWorktrees = "";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interruptedBy = signal;
  });
}

function json(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  )}\n`;
}

function writeEvidence(name: string, value: unknown): void {
  const path = join(evidenceRoot, name);
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, json(value));
  renameSync(temporary, path);
}

function writeRawEvidence(
  name: string,
  value: string,
): {
  artifact: string;
  sha256: string;
} {
  const path = join(evidenceRoot, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`);
  return {
    artifact: name,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function writeProviderOutcome(record: ProviderOutcomeRecord): void {
  providerOutcomes.set(record.provider, record);
  writeEvidence(`providers/${record.provider}.json`, {
    schemaVersion: 1,
    runId,
    sourceSha: git(sourceRoot, "rev-parse", "HEAD"),
    ...record,
  });
}

function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, json(value));
  renameSync(temporary, path);
}

function git(repository: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repository, ...args]);
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function requireLaunchArgument(
  launchArguments: readonly string[],
  flag: string,
  expectedValue: string,
): void {
  const positions = launchArguments.flatMap((argument, index) =>
    argument === flag ? [index] : [],
  );
  const position = positions[0];
  if (
    positions.length !== 1 ||
    position === undefined ||
    launchArguments[position + 1] !== expectedValue
  ) {
    throw new Error(
      `app proof launch identity did not bind ${flag} to ${expectedValue}`,
    );
  }
}

function verifyAppLifecycleRelease(release: AppLifecycleRelease): {
  executableSha256: string;
  expectedInstanceId: string;
  // 137 is still the expected child status; the schema no longer rejects
  // anything else, so an unexpected one is NAMED here rather than normalised
  // away by being accepted silently.
  unexpectedChildWaitStatus: string | null;
  postKillProcessReadback: {
    pid: number;
    state: "absent";
    psExitCode: number;
    stdout: string;
    stderr: string;
  };
} {
  const launchedAt = Date.parse(release.launchedAt);
  const sigkillIssuedAt = Date.parse(release.sigkillIssuedAt);
  if (
    launchedAt < Date.parse(startedAt) ||
    sigkillIssuedAt <= launchedAt ||
    sigkillIssuedAt > Date.now()
  ) {
    throw new Error("app proof lifecycle timestamps are inconsistent");
  }

  const executablePath = realpathSync(release.executablePath);
  if (
    executablePath !== release.executablePath ||
    executablePath !== appExecutablePath ||
    !executablePath.endsWith("/HiveWorkspace.app/Contents/MacOS/HiveWorkspace")
  ) {
    throw new Error(
      `app proof executable is not the exact Workspace binary: ${release.executablePath}`,
    );
  }
  const executableSha256 = createHash("sha256")
    .update(readFileSync(executablePath))
    .digest("hex");
  const publishedInstanceLine = readFileSync(
    join(artifacts, "coordinates.txt"),
    "utf8",
  )
    .split("\n")
    .find((line) => line.startsWith("u5_instance_id="));
  const expectedInstanceId = publishedInstanceLine?.slice(
    "u5_instance_id=".length,
  );
  if (expectedInstanceId === undefined || expectedInstanceId.length === 0) {
    throw new Error("published u5_instance_id is absent from coordinates");
  }
  const liveFlagCount = release.launchArguments.filter(
    (argument) => argument === "--workspace-shell-live",
  ).length;
  if (liveFlagCount !== 1) {
    throw new Error(
      "app proof launch identity omitted the live Workspace flag",
    );
  }
  for (const [flag, value] of [
    ["--port", String(port)],
    ["--instance-home", home],
    ["--hive", join(artifacts, "hive-bin")],
    ["--project", project],
    ["--instance-id", expectedInstanceId],
    ["--feed", join(artifacts, "u5-workspace-feed-bridge")],
  ] as const) {
    requireLaunchArgument(release.launchArguments, flag, value);
  }

  const expectedCommand = `${executablePath} ${release.launchArguments.join(" ")}`;
  if (
    !new RegExp(`^\\s*${release.viewerPid}\\s`).test(
      release.preKillProcessReadback,
    ) ||
    !release.preKillProcessReadback.includes(expectedCommand) ||
    !release.preKillProcessReadback.includes(executableSha256)
  ) {
    throw new Error(
      "app proof pre-kill readback did not bind the exact pid, command, and executable hash",
    );
  }

  const ps = Bun.spawnSync([
    "/bin/ps",
    "-p",
    String(release.viewerPid),
    "-o",
    "pid=",
  ]);
  const stdout = new TextDecoder().decode(ps.stdout).trim();
  const stderr = new TextDecoder().decode(ps.stderr).trim();
  if (ps.exitCode !== 1 || stdout.length !== 0 || stderr.length !== 0) {
    throw new Error(
      `app proof viewer pid ${release.viewerPid} was not independently absent: exit=${ps.exitCode} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  return {
    executableSha256,
    expectedInstanceId,
    unexpectedChildWaitStatus:
      release.termination.outcome === "reaped-as-child" &&
      release.termination.waitStatus !== "137"
        ? release.termination.waitStatus
        : null,
    postKillProcessReadback: {
      pid: release.viewerPid,
      state: "absent",
      psExitCode: ps.exitCode,
      stdout,
      stderr,
    },
  };
}

function uuidV7(now: number): string {
  const timestamp = now.toString(16).padStart(12, "0");
  const random = randomBytes(10).toString("hex");
  const variant = (
    (Number.parseInt(random.charAt(3), 16) & 0x3) |
    0x8
  ).toString(16);
  const body = `${timestamp}7${random.slice(0, 3)}${variant}${random.slice(4, 19)}`;
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20, 32)}`;
}

const RunBootstrapSchema = z
  .object({
    runId: z.string().min(1),
    taskInputs: z.object({
      specRevision: z.object({
        revision: z.string().min(1),
        digest: z.string().min(1),
      }),
      planRevision: z.object({
        revision: z.string().min(1),
        digest: z.string().min(1),
      }),
      baseSha: z.string().min(1),
    }),
  })
  .loose();
const FixtureTaskReceiptSchema = z
  .object({
    taskId: z.string().min(1),
  })
  .loose();
const HeadlessRootSnapshotSchema = z
  .object({
    requestId: z.string().min(1),
    locator: z.object({ sessionId: z.string().min(1) }).passthrough(),
    state: z.enum(["running", "exited", "failed"]),
    exitCode: z.number().int().nullable(),
    diagnostic: z.string().nullable(),
  })
  .loose();
const HeadlessHostRecordSchema = z
  .object({
    hostPid: z.number().int().positive(),
    hostStartToken: z.string().min(1),
  })
  .passthrough();

let openedHeadlessRoot: {
  requestId: string;
  providerRunId: string;
  locatorSessionId: string;
  hostPid: number;
  hostStartToken: string;
} | null = null;

async function readJsonResponse(
  response: Response,
): Promise<{ status: number; body: unknown; raw: string }> {
  const raw = await response.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { status: response.status, body, raw };
}

async function observeHeadlessRootHost(
  sessionId: string,
): Promise<{ hostPid: number; hostStartToken: string }> {
  const recordPath = join(hostDirectory(home, sessionId), "record.json");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(recordPath)) {
      const record = HeadlessHostRecordSchema.parse(
        JSON.parse(readFileSync(recordPath, "utf8")),
      );
      return {
        hostPid: record.hostPid,
        hostStartToken: record.hostStartToken,
      };
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `U5 headless root open refused: host record never appeared at ${recordPath}`,
  );
}

async function openIsolatedHeadlessRoot(): Promise<void> {
  assertIsolatedQaHiveHome(
    process.env.HIVE_HOME ?? "",
    join(homedir(), ".hive"),
  );
  const sessiondBin =
    process.env.HIVE_SESSIOND_BIN ??
    join(sourceRoot, "native/sessiond/zig-out/bin/hive-sessiond");
  const treeSchemaPath = join(sourceRoot, SESSION_PROTOCOL_SCHEMA_RELATIVE);
  if (!existsSync(sessiondBin)) {
    throw new Error(
      `U5 sessiond schema check refused: staged hive-sessiond is absent at ${sessiondBin}`,
    );
  }
  if (!existsSync(treeSchemaPath)) {
    throw new Error(
      `U5 sessiond schema check refused: tree schema is absent at ${treeSchemaPath}`,
    );
  }
  const sessiondBytes = readFileSync(sessiondBin);
  const treeSchema = readFileSync(treeSchemaPath);
  assertSessiondEmbedsTreeSchema(sessiondBytes, treeSchema);
  writeEvidence("00-sessiond-schema.json", {
    schemaVersion: 1,
    sessiondBin,
    treeSchemaPath,
    sessiondBytes: sessiondBytes.byteLength,
    treeSchemaBytes: treeSchema.byteLength,
    treeSchemaSha256: createHash("sha256").update(treeSchema).digest("hex"),
    state: "embedded",
  });
  const requestId = mintSessionRequestId();
  const providerRunId = randomUUID();
  const response = await rootFetch(
    `http://127.0.0.1:${port}/orchestrator-session/headless`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        providerRunId,
        cwd: project,
        environment: { HIVE_HOME: home },
      }),
    },
  );
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `U5 headless root open refused: HTTP ${payload.status}: ${payload.raw}`,
    );
  }
  const snapshot = HeadlessRootSnapshotSchema.parse(payload.body);
  requireHeadlessRootRunning(snapshot.state);
  const host = await observeHeadlessRootHost(snapshot.locator.sessionId);
  const identity = macProcessIdentity(host.hostPid);
  if (identity.startToken !== host.hostStartToken) {
    throw new Error(
      `U5 headless root open refused: host pid ${host.hostPid} start token drifted`,
    );
  }
  openedHeadlessRoot = {
    requestId: snapshot.requestId,
    providerRunId,
    locatorSessionId: snapshot.locator.sessionId,
    hostPid: host.hostPid,
    hostStartToken: host.hostStartToken,
  };
  writeEvidence("00-headless-root.json", {
    schemaVersion: 1,
    requestId: snapshot.requestId,
    providerRunId,
    state: snapshot.state,
    locator: snapshot.locator,
    hostPid: host.hostPid,
    hostStartToken: host.hostStartToken,
    before: processReadback(host.hostPid),
  });
}

function signalRecordedIdentity(
  pid: number,
  startToken: string,
  signal: NodeJS.Signals,
): boolean {
  const live = processReadback(pid);
  if (live.state !== "live" || live.startToken !== startToken) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function reapIsolatedHeadlessRoot(): Promise<Record<string, unknown>> {
  if (openedHeadlessRoot === null) {
    return { state: "not-opened" };
  }
  const { hostPid, hostStartToken, requestId } = openedHeadlessRoot;
  const before = processReadback(hostPid);
  signalRecordedIdentity(hostPid, hostStartToken, "SIGTERM");
  const termDeadline = Date.now() + 2_000;
  while (Date.now() < termDeadline) {
    const current = processReadback(hostPid);
    if (current.state === "absent") break;
    if (current.state === "live" && current.startToken !== hostStartToken)
      break;
    await Bun.sleep(50);
  }
  const afterTerm = processReadback(hostPid);
  if (afterTerm.state === "live" && afterTerm.startToken === hostStartToken) {
    signalRecordedIdentity(hostPid, hostStartToken, "SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline) {
      const current = processReadback(hostPid);
      if (current.state === "absent") break;
      if (current.state === "live" && current.startToken !== hostStartToken)
        break;
      await Bun.sleep(50);
    }
  }
  const after = processReadback(hostPid);
  let snapshot: unknown = null;
  try {
    const response = await rootFetch(
      `http://127.0.0.1:${port}/orchestrator-session?requestId=${encodeURIComponent(requestId)}`,
    );
    const payload = await readJsonResponse(response);
    snapshot = payload.body;
  } catch (error) {
    snapshot = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const state = headlessRootReapVerdict(true, before.state, after.state);
  const evidence = { state, requestId, hostPid, before, after, snapshot };
  writeEvidence("10-headless-root-reap.json", evidence);
  return evidence;
}

async function seedIsolatedFixtureTask(
  provider: CapabilityProvider,
): Promise<string> {
  assertIsolatedQaHiveHome(
    process.env.HIVE_HOME ?? "",
    join(homedir(), ".hive"),
  );
  const bootstrap = await callTool(
    "hive_run_bootstrap",
    {},
    "bootstrap",
    RunBootstrapSchema,
  );
  const fixtureTaskId = `task_${uuidV7(Date.now())}`;
  const receipt = await callTool(
    "hive_task_create",
    {
      taskId: fixtureTaskId,
      revision: "1",
      parentTaskId: null,
      dependsOn: [],
      acceptanceIds: [`u5-isolated-fixture-${provider}`],
      assigneeNodeId: null,
      pathLeases: [{ path: "docs/qa/", mode: "read" }],
      branch: "dev",
      baseSha: bootstrap.taskInputs.baseSha,
      state: "assigned",
      blockers: [],
      evidence: [],
      artifactRefs: [],
      runId: bootstrap.runId,
      delegationSpec: {
        objective: `Isolated U5 fixture task for the ${provider} spawn`,
        parentAcceptanceIds: [`u5-isolated-fixture-${provider}`],
        childOutcome:
          "The isolated spawn is accountable on this ephemeral board",
        terminationCondition: "The U5 live harness finishes or refuses by name",
        inputs: {
          specRevision: bootstrap.taskInputs.specRevision,
          planRevision: bootstrap.taskInputs.planRevision,
          taskRevisions: [],
          interfaceRevisions: [],
          baseSha: bootstrap.taskInputs.baseSha,
          prerequisites: [],
          sourceArtifactRefs: [],
        },
        boundaries: { allowedPaths: ["docs/qa/"] },
        authority: {
          grantId: `grant_${uuidV7(Date.now() + 1)}`,
          permittedOperations: ["read", "test", "message"],
          environment: "local",
          worktree: "per-agent",
          branch: "dev",
          explicitNonAuthority: [
            "never land on main",
            "never write the live board",
          ],
        },
        allowance: {
          sessions: 2,
          tokens: 1_500_000,
          costCents: 8000,
          wallTimeMs: 3_600_000,
          retries: 1,
          blockers: [],
        },
      },
    },
    "task",
    FixtureTaskReceiptSchema,
  );
  if (receipt.taskId.length === 0) {
    throw new Error("isolated fixture task create returned no taskId");
  }
  return receipt.taskId;
}

function throwIfInterrupted(): void {
  if (interruptedBy !== null)
    throw new Error(`interrupted by ${interruptedBy}`);
}

async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>,
): Promise<T> {
  throwIfInterrupted();
  return await callMcpTool(port, rootFetch, name, args, key, schema);
}

async function status(): Promise<AgentRecord[]> {
  return await callTool(
    "hive_status",
    { detail: "full" },
    "agents",
    AgentRecordSchema.array(),
  );
}

async function inventory(): Promise<ModelInventory> {
  return await callTool("hive_models", {}, "inventory", ModelInventorySchema);
}

async function readPolicy(): Promise<RoutingPolicy> {
  const response = await userFetch(`http://127.0.0.1:${port}/routing/policy`);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `GET /routing/policy refused (${response.status}): ${body}`,
    );
  }
  return RoutingPolicySchema.parse(JSON.parse(body));
}

async function mutatePolicy(mutation: unknown): Promise<RoutingPolicy> {
  const validated = RoutingPolicyMutationSchema.parse(mutation);
  const response = await userFetch(`http://127.0.0.1:${port}/routing/policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validated),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `POST /routing/policy refused (${response.status}): ${body}`,
    );
  }
  return RoutingPolicySchema.parse(JSON.parse(body));
}

function processReadback(pid: number): ProcessReadback {
  const ps = Bun.spawnSync([
    "/bin/ps",
    "-p",
    String(pid),
    "-o",
    "pid=,ppid=,lstart=,command=",
  ]);
  const stdout = new TextDecoder().decode(ps.stdout).trim();
  const stderr = new TextDecoder().decode(ps.stderr).trim();
  if (ps.exitCode === 0 && stdout.length > 0) {
    const identity = macProcessIdentity(pid);
    return {
      state: "live",
      pid,
      startToken: identity.startToken,
      executablePath: identity.executablePath,
      psExitCode: ps.exitCode,
      stdout,
      stderr,
    };
  }
  return {
    state: ps.exitCode === 1 && stdout.length === 0 ? "absent" : "unknown",
    pid,
    psExitCode: ps.exitCode,
    stdout,
    stderr,
  };
}

async function readLiveRunControl(
  agentId: string,
): Promise<LiveRunControlProjection> {
  const response = await userFetch(
    `http://127.0.0.1:${port}/live-run-control?agentId=${encodeURIComponent(agentId)}`,
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `GET /live-run-control refused (${response.status}): ${body}`,
    );
  }
  return LiveRunControlProjectionSchema.parse(JSON.parse(body));
}

async function submitLiveRunControl(
  intent: LiveRunControlIntent,
): Promise<ReturnType<typeof LiveRunControlResultSchema.parse>> {
  const response = await userFetch(
    `http://127.0.0.1:${port}/live-run-control`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(intent),
    },
  );
  const body = await response.text();
  if (!response.ok && response.status !== 409) {
    throw new Error(
      `POST /live-run-control refused (${response.status}): ${body}`,
    );
  }
  return LiveRunControlResultSchema.parse(JSON.parse(body));
}

function controlIntent(
  operation: "stop-provider" | "terminate-terminal",
  projection: LiveRunControlProjection,
): LiveRunControlIntent {
  if (projection.shell.state !== "retained") {
    throw new Error(`${projection.agentName} has no verified retained shell`);
  }
  const intentId = randomUUID();
  return LiveRunControlIntentSchema.parse({
    schemaVersion: 1,
    intentId,
    expected: {
      kind: "epoch",
      epoch: String(projection.locator.generation),
    },
    idempotencyKey: intentId,
    body: {
      operation,
      agentId: projection.agentId,
      locator: projection.locator,
      expectedShellRoot: projection.shell.root,
      ...(operation === "stop-provider"
        ? {
            expectedProviderRunId:
              projection.providerRun.state === "running"
                ? projection.providerRun.runId
                : null,
          }
        : {}),
    },
  });
}

function sameProcessRoot(
  left: { pid: number; startToken: string; processGroupId: number },
  right: { pid: number; startToken: string; processGroupId: number },
): boolean {
  return (
    left.pid === right.pid &&
    left.startToken === right.startToken &&
    left.processGroupId === right.processGroupId
  );
}

async function proveLiveRunControls(
  rows: readonly (AgentRecord & { sessionLocator: SessionLocator })[],
) {
  const sentinelBefore = processReadback(survivingSentinel.pid);
  if (sentinelBefore.state !== "live") {
    throw new Error(
      "the unrelated process sentinel was not live before control proof",
    );
  }
  const sentinelStartToken = sentinelBefore.startToken;
  const providers = [];
  for (const row of rows) {
    try {
      const before = await readLiveRunControl(row.id);
      if (
        before.provider !== row.tool ||
        !sameSessionLocator(before.locator, row.sessionLocator)
      ) {
        throw new Error(
          `${row.tool} live-run projection does not bind this agent`,
        );
      }
      const censusMembers =
        before.processCensus.state === "complete"
          ? before.processCensus.members
          : [];
      const liveMemberCount = censusMembers.filter(
        (member) => processReadback(member.pid).state === "live",
      ).length;
      const shellRootLive =
        before.shell.state === "retained" &&
        processReadback(before.shell.root.pid).state === "live";
      const subjectReady = liveRunControlSubjectReady({
        shellState: before.shell.state,
        censusState: before.processCensus.state,
        liveMemberCount,
        shellRootLive,
      });
      const liveness = proofSubjectLiveness({
        agentStatus: row.status,
        tree: subjectReady.ready ? "live" : "absent",
      });
      if (
        !subjectReady.ready ||
        before.shell.state !== "retained" ||
        liveness.state !== "tree-live"
      ) {
        throw new Error(
          `${row.tool} ${liveness.reason}; ${subjectReady.reason}`,
        );
      }
      const shellRoot = before.shell.root;
      const providerProcess =
        before.providerRun.state === "running"
          ? before.providerRun.process
          : null;
      if (
        before.processCensus.state === "complete" &&
        (!censusMembers.some(
          (member) =>
            member.pid === shellRoot.pid &&
            member.startToken === shellRoot.startToken,
        ) ||
          (providerProcess !== null &&
            !censusMembers.some(
              (member) =>
                member.pid === providerProcess.pid &&
                member.startToken === providerProcess.startToken,
            )) ||
          censusMembers.some((member) => member.pid === survivingSentinel.pid))
      ) {
        throw new Error(`${row.tool} returned an invalid process-tree census`);
      }

      const canStopProvider =
        before.providerRun.state === "running" &&
        before.controls.stopProvider.enabled;
      let afterStop = before;
      let stopResult: Awaited<ReturnType<typeof submitLiveRunControl>> | null =
        null;
      let providerProcessAfterStop: ProcessReadback | null = null;
      let shellAfterStop = processReadback(shellRoot.pid);
      let sentinelAfterStop = processReadback(survivingSentinel.pid);
      if (canStopProvider && providerProcess !== null) {
        stopResult = await submitLiveRunControl(
          controlIntent("stop-provider", before),
        );
        afterStop = await readLiveRunControl(row.id);
        if (
          stopResult.outcome.status !== "accepted" ||
          stopResult.observedPostState.providerRun.state !== "absent" ||
          stopResult.observedPostState.shell.state !== "retained" ||
          !sameProcessRoot(
            stopResult.observedPostState.shell.root,
            shellRoot,
          ) ||
          stopResult.observedPostState.shell.foreground !== "shell" ||
          afterStop.providerRun.state !== "absent" ||
          afterStop.shell.state !== "retained" ||
          !sameProcessRoot(afterStop.shell.root, shellRoot) ||
          afterStop.shell.foreground !== "shell"
        ) {
          throw new Error(
            `${row.tool} Stop Provider did not retain the same zsh`,
          );
        }
        providerProcessAfterStop = processReadback(providerProcess.pid);
        shellAfterStop = processReadback(shellRoot.pid);
        sentinelAfterStop = processReadback(survivingSentinel.pid);
        if (
          providerProcessAfterStop.state !== "absent" ||
          shellAfterStop.state !== "live" ||
          shellAfterStop.startToken !== shellRoot.startToken ||
          sentinelAfterStop.state !== "live" ||
          sentinelAfterStop.startToken !== sentinelStartToken
        ) {
          throw new Error(`${row.tool} Stop Provider process readback failed`);
        }
      } else if (
        shellAfterStop.state !== "live" ||
        sentinelAfterStop.state !== "live" ||
        sentinelAfterStop.startToken !== sentinelStartToken
      ) {
        throw new Error(
          `${row.tool} tree was not live before Terminate Terminal`,
        );
      }

      const terminateResult = await submitLiveRunControl(
        controlIntent("terminate-terminal", afterStop),
      );
      const afterTerminate = await readLiveRunControl(row.id);
      const terminalStatus = (await status()).find(
        (candidate) => candidate.id === row.id,
      );
      const shellAfterTerminate = processReadback(shellRoot.pid);
      const sentinelAfterTerminate = processReadback(survivingSentinel.pid);
      if (
        terminateResult.outcome.status !== "accepted" ||
        terminateResult.observedPostState.termination.state !== "terminated" ||
        terminateResult.observedPostState.termination.survivors.length !== 0 ||
        terminateResult.observedPostState.shell.state !== "terminated" ||
        terminateResult.observedPostState.processCensus.state !==
          "terminated" ||
        afterTerminate.termination.state !== "terminated" ||
        afterTerminate.termination.survivors.length !== 0 ||
        afterTerminate.shell.state !== "terminated" ||
        afterTerminate.processCensus.state !== "terminated" ||
        shellAfterTerminate.state !== "absent" ||
        (terminalStatus !== undefined &&
          !terminalStatuses.has(terminalStatus.status)) ||
        sentinelAfterTerminate.state !== "live" ||
        sentinelAfterTerminate.startToken !== sentinelStartToken
      ) {
        throw new Error(`${row.tool} Terminate Terminal final readback failed`);
      }
      providers.push({
        provider: row.tool,
        agentId: row.id,
        locator: row.sessionLocator,
        outcome: "proven",
        before,
        stop: {
          skipped: stopResult === null,
          skipReason:
            stopResult === null
              ? "provider run was not running; Stop Provider is not a mid-turn precondition"
              : null,
          mutation: stopResult,
          independentProjection: afterStop,
          providerProcessReadback: providerProcessAfterStop,
          retainedShellReadback: shellAfterStop,
          sentinelReadback: sentinelAfterStop,
        },
        terminate: {
          mutation: terminateResult,
          independentProjection: afterTerminate,
          shellProcessReadback: shellAfterTerminate,
          agentStatus: terminalStatus ?? null,
          sentinelReadback: sentinelAfterTerminate,
        },
      });
    } catch (error) {
      providers.push({
        provider: row.tool,
        agentId: row.id,
        locator: row.sessionLocator,
        outcome: "blocked",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const sentinelAfter = processReadback(survivingSentinel.pid);
  if (
    sentinelAfter.state !== "live" ||
    sentinelAfter.startToken !== sentinelStartToken
  ) {
    throw new Error(
      "the unrelated process sentinel did not survive control proof",
    );
  }
  const evidence = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    sentinel: { before: sentinelBefore, after: sentinelAfter },
    providers,
  };
  writeEvidence("09-live-run-process-controls.json", evidence);
  return evidence;
}

function modelSafetyRank(model: InventoryModel): readonly (number | string)[] {
  const freeName = /(?:^|[-/])free(?:$|[-/])/.test(model.canonicalId);
  return [
    model.plan.status === "covered" || freeName ? 0 : 1,
    model.entitlement === "entitled" ? 0 : 1,
    model.hidden === "visible" ? 0 : 1,
    model.variant === null ? 0 : 1,
    model.canonicalId,
  ];
}

function compareRanks(left: InventoryModel, right: InventoryModel): number {
  const leftRank = modelSafetyRank(left);
  const rightRank = modelSafetyRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    const a = leftRank[index];
    const b = rightRank[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  }
  return 0;
}

function selectModel(
  liveInventory: ModelInventory,
  provider: CapabilityProvider,
): InventoryModel {
  const providerState = liveInventory.providers[provider];
  if (providerState.status !== "ok") {
    throw new Error(
      `${provider} inventory unavailable: ${providerState.reason}`,
    );
  }
  const admissible = liveInventory.models
    .filter(
      (model) =>
        model.vendor === provider &&
        model.entitlement !== "not-entitled" &&
        model.hidden !== "hidden" &&
        model.plan.status !== "unavailable" &&
        model.plan.status !== "would-spend",
    )
    .sort(compareRanks);
  const candidates =
    provider === "opencode"
      ? admissible.filter((model) =>
          /(?:^|[-/])free(?:$|[-/])/.test(model.canonicalId),
        )
      : admissible;
  const selected = candidates[0];
  if (selected === undefined) {
    throw new Error(
      `${provider} has no live visible entitled model outside a measured unavailable or would-spend state`,
    );
  }
  return selected;
}

function inventoryReadyForScope(liveInventory: ModelInventory): boolean {
  if (!scopedPartial) return liveInventory.complete;
  if (liveInventory.complete) return true;
  const grok = liveInventory.providers.grok;
  const grokReady =
    grok.status === "ok" ||
    (grok.status === "unavailable" && explicitQuotaRefusal(grok.reason));
  return (
    (liveInventory.providers.kimi.status === "unavailable" ||
      grok.status === "unavailable") &&
    grokReady &&
    ["claude", "codex", "opencode"].every(
      (provider) =>
        liveInventory.providers[provider as CapabilityProvider].status === "ok",
    )
  );
}

function selectScopedGrokModel(liveInventory: ModelInventory): InventoryModel {
  const selected = liveInventory.models
    .filter(
      (model) =>
        model.vendor === "grok" &&
        model.entitlement !== "not-entitled" &&
        model.hidden !== "hidden" &&
        model.plan.status !== "would-spend" &&
        (model.plan.status !== "unavailable" ||
          explicitQuotaRefusal(model.plan.detail)),
    )
    .sort(compareRanks)[0];
  if (selected === undefined) {
    throw new Error(
      "grok has no live model or explicit quota-blocked model safe to attempt",
    );
  }
  return selected;
}

function selectedModelId(provider: CapabilityProvider): string {
  if (scopedPartial && provider === "kimi") return kimiHardRoute;
  const override = selectedModelOverrides.get(provider);
  if (override !== undefined) return override;
  const selected = selectedModels.get(provider);
  if (selected === undefined) {
    throw new Error(`selection missing for ${provider}`);
  }
  return selected.canonicalId;
}

function explicitQuotaRefusal(value: string): boolean {
  return (
    /quota pool .{0,80} drained/i.test(value) ||
    /(?:quota|usage limit|weekly limit|rate limit).{0,80}(?:exhausted|exceeded|reached|0%\s+left|no\s+.*remaining)/i.test(
      value,
    ) ||
    /(?:exhausted|exceeded|reached).{0,80}(?:quota|usage limit|weekly limit|rate limit)/i.test(
      value,
    )
  );
}

function classifyExplicitRefusal(
  provider: CapabilityProvider,
  cause: string,
): "quota-blocked" | "schema-blocked" | "launch-refused" {
  if (provider === "grok" && explicitQuotaRefusal(cause)) {
    return "quota-blocked";
  }
  if (
    provider === "kimi" &&
    /(?:schema|catalog.{0,40}unreadable|resolution.{0,80}kimi)/i.test(cause)
  ) {
    return "schema-blocked";
  }
  return "launch-refused";
}

async function readBackExplicitRefusal(
  marker: string,
  positiveControlIds: readonly string[],
): Promise<Record<string, unknown>> {
  const rows = await status();
  const visiblePositiveControls = positiveControlIds.filter((id) =>
    rows.some((row) => row.id === id),
  );
  const matching = rows.filter(
    (row) =>
      !initialAgentIds.has(row.id) && row.taskDescription.includes(marker),
  );
  for (const row of matching) {
    ownedIds.add(row.id);
    ownedNames.set(row.id, row.name);
  }
  const decision = explicitRefusalReadbackState({
    positiveControlIds,
    visiblePositiveControlCount: visiblePositiveControls.length,
    matchingCount: matching.length,
  });
  if (decision.state === "unknown") {
    return {
      state: "unknown",
      observedAt: new Date().toISOString(),
      positiveControlIds,
      visiblePositiveControls,
      diagnosticIds: matching.map((row) => row.id),
      reason: decision.reason,
    };
  }
  return {
    state: "absent",
    observedAt: new Date().toISOString(),
    positiveControlIds,
    visiblePositiveControls,
    matchingRows: [],
  };
}

function requireExactAgent(
  rows: readonly AgentRecord[],
  expected: Pick<AgentRecord, "id" | "name" | "tool" | "model"> & {
    sessionLocator: SessionLocator;
  },
): AgentRecord {
  const row = rows.find((candidate) => candidate.id === expected.id);
  if (row === undefined) throw new Error(`agent ${expected.id} disappeared`);
  if (
    row.name !== expected.name ||
    row.tool !== expected.tool ||
    row.model !== expected.model
  ) {
    throw new Error(`agent identity changed for ${expected.id}`);
  }
  if (
    row.sessionLocator === undefined ||
    !sameSessionLocator(row.sessionLocator, expected.sessionLocator)
  ) {
    throw new Error(`exact terminal generation changed for ${row.name}`);
  }
  return row;
}

async function observe(
  row: AgentRecord,
): Promise<z.infer<typeof CaptureResultSchema>> {
  if (row.sessionLocator === undefined) {
    throw new Error(`${row.name} has no exact terminal locator`);
  }
  const observation = await callTool(
    "hive_terminal_observe",
    {
      sessionId: row.sessionLocator.sessionId,
      generation: row.sessionLocator.generation,
      include: "visible-text",
      maxRows: 200,
    },
    "terminalObservation",
    TerminalObservationSchema,
  );
  if (!sameSessionLocator(observation.capture.locator, row.sessionLocator)) {
    throw new Error(
      `terminal observation returned the wrong generation for ${row.name}`,
    );
  }
  return observation.capture;
}

/**
 * Visual readiness after arbiter reduction (06b3cf7f): capture.composer is
 * always null. A "stable" pane is a painted session with non-empty text and a
 * null composer key (positive control that we are on the reduced wire).
 * Provider identity comes from the agent row, never from a deleted classifier.
 */
function stableComposer(
  capture: z.infer<typeof CaptureResultSchema>,
  _provider: CapabilityProvider,
): boolean {
  return (
    capture.composer === null &&
    capture.text !== null &&
    capture.text.trim().length > 0
  );
}

async function waitForLiveComposer(
  agentId: string,
  provider: CapabilityProvider,
  model: string,
): Promise<{ row: AgentRecord; capture: z.infer<typeof CaptureResultSchema> }> {
  const deadline = Date.now() + 180_000;
  let lastDiagnostic = "no status row";
  for (;;) {
    throwIfInterrupted();
    const row = (await status()).find((candidate) => candidate.id === agentId);
    if (row !== undefined) {
      ownedNames.set(row.id, row.name);
      if (row.tool !== provider || row.model !== model) {
        throw new Error(
          `spawn identity mismatch: wanted ${provider}/${model}, got ${row.tool}/${row.model}`,
        );
      }
      if (row.sessionLocator !== undefined) {
        if (
          row.sessionLocator.subject.kind !== "agent" ||
          row.sessionLocator.subject.agentId !== row.id
        ) {
          throw new Error(`terminal locator subject does not bind ${row.name}`);
        }
        try {
          const capture = await observe(row);
          if (capture.composer != null) {
            throw new Error(
              `capture.composer must be null after arbiter reduction for ${row.name}: ${JSON.stringify(capture.composer)}`,
            );
          }
          if (
            scopedPartial &&
            provider === "grok" &&
            capture.text !== null &&
            explicitQuotaRefusal(capture.text)
          ) {
            throw new ObservedProviderBlock(
              "quota-blocked",
              capture.text,
              "terminal-pane",
              capture.sha256,
            );
          }
          if (stableComposer(capture, provider)) return { row, capture };
          lastDiagnostic = `composer=null textLen=${capture.text?.trim().length ?? 0} sha=${capture.sha256}`;
        } catch (error) {
          if (error instanceof ObservedProviderBlock) throw error;
          lastDiagnostic =
            error instanceof Error ? error.message : String(error);
        }
      } else {
        lastDiagnostic = `status=${row.status}, locator absent`;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${provider}/${model} did not expose a stable painted session: ${lastDiagnostic}`,
      );
    }
    await Bun.sleep(750);
  }
}

async function configureSingletonRoute(
  provider: CapabilityProvider,
  model: string,
): Promise<Record<string, unknown>> {
  const before = await readPolicy();
  let current = before;
  if (current.providers[provider] !== "enabled") {
    current = await mutatePolicy({
      op: "set-provider",
      expectedRevision: current.revision,
      provider,
      state: "enabled",
    });
  }
  current = await mutatePolicy({
    op: "set-route",
    expectedRevision: current.revision,
    scope: "simple_coding",
    route: {
      mode: "user-weighted",
      candidates: [
        {
          provider,
          model,
          effort: { mode: "provider-controlled" },
          weight: 1,
        },
      ],
    },
  });
  const readback = await readPolicy();
  const route = readback.categories.simple_coding;
  const candidate = route?.candidates[0];
  if (
    readback.revision !== current.revision ||
    readback.providers[provider] !== "enabled" ||
    route?.mode !== "user-weighted" ||
    route.candidates.length !== 1 ||
    candidate?.provider !== provider ||
    candidate.model !== model ||
    candidate.effort.mode !== "provider-controlled"
  ) {
    throw new Error(`singleton route readback failed for ${provider}/${model}`);
  }
  return {
    provider,
    model,
    beforeRevision: before.revision,
    writtenRevision: current.revision,
    readbackRevision: readback.revision,
    providerState: readback.providers[provider],
    route,
  };
}

async function issueGrant(
  row: AgentRecord,
  viewerId: string,
  operations: readonly ("view" | "user-input" | "resize")[],
): Promise<z.infer<typeof AttachGrantSchema>> {
  if (row.sessionLocator === undefined) {
    throw new Error(`${row.name} has no locator for an attach grant`);
  }
  const response = await rootFetch(
    `http://127.0.0.1:${port}/agents/${encodeURIComponent(row.name)}/attach-grant`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionLocator: row.sessionLocator,
        viewerId,
        geometry,
        operations,
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `attach grant for ${row.name} refused (${response.status}): ${body}`,
    );
  }
  const grant = AttachGrantResponseSchema.parse(JSON.parse(body)).grant;
  if (!sameSessionLocator(grant.locator, row.sessionLocator)) {
    throw new Error(
      `attach grant returned the wrong generation for ${row.name}`,
    );
  }
  return grant;
}

function safeGrant(
  grant: z.infer<typeof AttachGrantSchema>,
): Record<string, unknown> {
  return {
    locator: grant.locator,
    engineBuildId: grant.engineBuildId,
    expiresAt: grant.expiresAt,
    checkpointSeq: grant.checkpointSeq,
    outputSeq: grant.outputSeq,
    operations: grant.operations,
  };
}

async function runProof(): Promise<Record<string, unknown>> {
  const isolatedFixtureTasks: Partial<Record<CapabilityProvider, string>> = {};
  writeEvidence("00-isolated-fixture-task.json", {
    schemaVersion: 1,
    liveAccountabilityTaskId,
    isolatedHiveHome,
    fixtureTasks: isolatedFixtureTasks,
    note: "one fixture task is seeded per spawn, never one for the run",
  });
  initialProjectHead = git(project, "rev-parse", "HEAD");
  initialProjectStatus = git(project, "status", "--porcelain");
  initialProjectWorktrees = git(project, "worktree", "list", "--porcelain");
  const unexpectedProjectRows = initialProjectStatus
    .split("\n")
    .filter((row) => row !== "")
    .filter((row) => row !== "?? .gitignore" && row !== "?? .hive/");
  // rig.sh creates only these two project-local control paths. Treating its
  // own fresh-daemon metadata as user dirt makes every real rig fail before a
  // vendor launches; any additional row still refuses the proof.
  if (unexpectedProjectRows.length > 0) {
    throw new Error(`QA project is not fresh: ${project}`);
  }
  const absentStandards = await agentStandardsRefusalMessage(project);
  if (!/Cannot spawn: agent standards are unreadable/.test(absentStandards)) {
    throw new Error(
      `isolated project absence control did not name the unreadable refusal: ${absentStandards}`,
    );
  }
  const sourceStandards = readFileSync(
    join(sourceRoot, "AGENT_STANDARDS.md"),
    "utf8",
  );
  const stagedStandards = stageIsolatedProjectAgentStandards(
    project,
    sourceStandards,
  );
  const parsedStandards = await requireParsedAgentStandards(project);
  initialProjectStatus = git(project, "status", "--porcelain");
  writeEvidence("00-isolated-project-standards.json", {
    schemaVersion: 1,
    project,
    stagedPath: stagedStandards.path,
    bytes: stagedStandards.bytes,
    sha256: createHash("sha256").update(sourceStandards).digest("hex"),
    sectionCount: parsedStandards.sectionCount,
    headings: parsedStandards.headings,
    absentRefusal: absentStandards,
  });
  const initialAgents = await status();
  initialAgentIds = new Set(initialAgents.map((agent) => agent.id));
  const preexistingLive = initialAgents.filter(
    (agent) => !terminalStatuses.has(agent.status),
  );
  if (preexistingLive.length > 0) {
    throw new Error(
      `isolated rig already has live agents: ${preexistingLive.map((agent) => agent.name).join(", ")}`,
    );
  }
  initialPolicy = await readPolicy();
  writeEvidence("00-run.json", {
    schemaVersion: 1,
    runId,
    startedAt,
    scope,
    home,
    project,
    sourceRoot,
    sourceSha: git(sourceRoot, "rev-parse", "HEAD"),
    sourceStatus: git(sourceRoot, "status", "--porcelain"),
    daemonPort: port,
    initialPolicyRevision: initialPolicy.revision,
    initialAgentCount: initialAgents.length,
    pendingAssertions: {
      stopProvider: "production endpoint absent in this production proof leg",
      terminateTerminal:
        "production endpoint absent in this production proof leg",
      viewerProcessSigkill: "awaiting the production Workspace rendezvous",
    },
  });

  const firstInventory = await inventory();
  if (!inventoryReadyForScope(firstInventory)) {
    throw new Error(
      `live model inventory is incomplete: ${firstInventory.warnings.join("; ")}`,
    );
  }
  for (const provider of attemptProviders) {
    if (scopedPartial && (provider === "grok" || provider === "kimi")) {
      continue;
    }
    selectedModels.set(provider, selectModel(firstInventory, provider));
  }
  const secondInventory = await inventory();
  if (!inventoryReadyForScope(secondInventory)) {
    throw new Error(
      "model inventory became incomplete on positive-control re-read",
    );
  }
  const discoveryReadback = attemptProviders.map((provider) => {
    if (scopedPartial && provider === "kimi") {
      return {
        provider,
        selection: {
          state: "hard-route-probe",
          canonicalId: kimiHardRoute,
          reason:
            "measure the current daemon response to the resolved Kimi route",
        },
        firstProviderRead: firstInventory.providers.kimi,
        secondProviderRead: secondInventory.providers.kimi,
      };
    }
    if (scopedPartial && provider === "grok") {
      return {
        provider,
        selection: {
          state: "deferred-until-after-required-live-admissions",
          safeCandidates: secondInventory.models
            .filter(
              (model) =>
                model.vendor === "grok" && model.plan.status !== "would-spend",
            )
            .map((model) => ({
              canonicalId: model.canonicalId,
              plan: model.plan,
            })),
        },
        firstProviderRead: firstInventory.providers.grok,
        secondProviderRead: secondInventory.providers.grok,
      };
    }
    const selected = selectedModels.get(provider);
    if (selected === undefined)
      throw new Error(`selection missing for ${provider}`);
    const reread = secondInventory.models.find(
      (model) =>
        model.vendor === provider &&
        model.canonicalId === selected.canonicalId &&
        model.variant === selected.variant,
    );
    const providerReadback = secondInventory.providers[provider];
    const providerStillEligible =
      providerReadback.status === "ok" ||
      (scopedPartial &&
        provider === "grok" &&
        providerReadback.status === "unavailable" &&
        explicitQuotaRefusal(providerReadback.reason));
    if (!providerStillEligible || reread === undefined) {
      throw new Error(
        `${provider}/${selected.canonicalId} vanished on inventory re-read`,
      );
    }
    return { provider, selected, reread };
  });
  writeEvidence("01-live-model-discovery.json", {
    schemaVersion: 1,
    firstRead: {
      observedAt: firstInventory.observedAt,
      complete: firstInventory.complete,
      discoveredCount: firstInventory.discoveredCount,
      renderedCount: firstInventory.renderedCount,
      providers: firstInventory.providers,
      warnings: firstInventory.warnings,
    },
    secondRead: {
      observedAt: secondInventory.observedAt,
      complete: secondInventory.complete,
      discoveredCount: secondInventory.discoveredCount,
      renderedCount: secondInventory.renderedCount,
      providers: secondInventory.providers,
      warnings: secondInventory.warnings,
    },
    selections: discoveryReadback,
  });

  await callTool(
    "hive_run_checkpoint",
    {
      reason: "unknown-context",
      contextUsage: {
        kind: "unknown",
        reason: "headless QA owner has no provider context measurement",
      },
      decision: {
        decision: "replace",
        reason: scopedPartial
          ? "fresh isolated provider proof with bounded blocked outcomes"
          : "fresh isolated five-provider proof",
      },
      written: {
        goal: scopedPartial
          ? "Measure live provider terminals, exact-locator viewer attempts, and two bounded launch outcomes"
          : "Measure five concurrent provider terminals and exact-locator viewer attempts",
        done: ["The private rig and two live catalog reads were verified"],
        failures: [],
        uncertainty: ["Stop and terminate controls are not present yet"],
        nextAction: "Attempt one exact route per provider",
        rollback:
          "Kill only marker-bound agents and restore routing preferences",
      },
      unresolvedQuestions: [],
      model: null,
    },
    "checkpoint",
    z.unknown(),
  );

  const routeEvidence: Record<string, unknown>[] = [];
  const spawned: Array<{
    row: AgentRecord & { sessionLocator: SessionLocator };
    capture: z.infer<typeof CaptureResultSchema>;
  }> = [];
  const writeAdmissions = () =>
    writeEvidence("03-provider-admissions.json", {
      schemaVersion: 1,
      attemptOrder: attemptProviders,
      outcomes: attemptProviders.flatMap((provider) => {
        const record = providerOutcomes.get(provider);
        return record === undefined ? [] : [record];
      }),
      admissions: spawned.map(({ row, capture }) => ({
        agentId: row.id,
        name: row.name,
        provider: row.tool,
        configuredModel: row.model,
        liveModel:
          row.liveModel === undefined
            ? {
                state: "unknown",
                reason: "provider has not reported a live model",
              }
            : { state: "known", value: row.liveModel },
        status: row.status,
        locator: row.sessionLocator,
        composer: capture.composer,
        captureSha256: capture.sha256,
      })),
    });

  await openIsolatedHeadlessRoot();

  for (const provider of attemptProviders) {
    if (scopedPartial && provider === "grok") {
      try {
        selectedModels.set(provider, selectScopedGrokModel(secondInventory));
      } catch (error) {
        const providerState = secondInventory.providers.grok;
        if (
          providerState.status !== "unavailable" ||
          !explicitQuotaRefusal(providerState.reason)
        ) {
          throw error;
        }
        // A quota-drained catalog can omit its model rows. This exact route is
        // attempted once; only the fresh spawn response decides its outcome.
        selectedModelOverrides.set(provider, grokQuotaProbeRoute);
      }
    }
    const model = selectedModelId(provider);
    routeEvidence.push(await configureSingletonRoute(provider, model));
    writeEvidence("02-route-readbacks.json", routeEvidence);

    const attemptedAt = new Date().toISOString();
    const attemptMarker = `${taskMarker}_PROVIDER_${provider}`;
    const task =
      `${attemptMarker} provider=${provider}. Wait quietly for a live terminal proof. ` +
      "Do not call tools, modify files, or report completion. Keep the session open until queen stops it.";
    const request: SpawnRequestRecord = {
      provider,
      marker: attemptMarker,
      state: "pending",
    };
    spawnRequests.push(request);
    const fixtureSpawnTaskId = await seedIsolatedFixtureTask(provider);
    isolatedFixtureTasks[provider] = fixtureSpawnTaskId;
    writeEvidence("00-isolated-fixture-task.json", {
      schemaVersion: 1,
      liveAccountabilityTaskId,
      isolatedHiveHome,
      fixtureTasks: isolatedFixtureTasks,
      note: "one fixture task is seeded per spawn, never one for the run",
    });
    let admission: z.infer<typeof SpawnSummarySchema>;
    try {
      admission = await callTool(
        "hive_spawn",
        {
          task,
          category: "simple_coding",
          readOnly: true,
          taskId: fixtureSpawnTaskId,
        },
        "agent",
        SpawnSummarySchema,
      );
    } catch (error) {
      if (!(error instanceof McpToolRefusal)) {
        request.state = "unknown";
        writeProviderOutcome({
          provider,
          outcome: "unknown",
          attemptOrdinal: 1,
          attemptedAt,
          retryAttempted: false,
          phase: "hive_spawn",
          reason: error instanceof Error ? error.message : String(error),
        });
        writeAdmissions();
        throw error;
      }
      const positiveControlIds = spawned
        .filter(({ row }) =>
          requiredLiveProviders.includes(
            row.tool as (typeof requiredLiveProviders)[number],
          ),
        )
        .map(({ row }) => row.id);
      const refusalReadback = await readBackExplicitRefusal(
        attemptMarker,
        positiveControlIds,
      );
      request.refusalReadback = refusalReadback;
      request.state =
        refusalReadback.state === "absent" ? "refused" : "unknown";
      const exactRefusal = error.detail;
      const raw = writeRawEvidence(
        `raw/${provider}-attempt-1-refusal.txt`,
        exactRefusal,
      );
      const attributed = spawnRefusalProofError(
        provider,
        exactRefusal,
        refusalReadback,
      );
      if (attributed !== null) {
        writeProviderOutcome({
          provider,
          outcome: "unknown",
          attemptOrdinal: 1,
          attemptedAt,
          retryAttempted: false,
          phase: "hive_spawn",
          cause:
            exactRefusal.trim() === ""
              ? "the MCP refusal omitted its cause"
              : exactRefusal,
          wrapperDiagnostic: error.message,
          rawArtifact: raw.artifact,
          rawSha256: raw.sha256,
          terminalAvailability: refusalReadback,
        });
        writeAdmissions();
        throw new Error(attributed);
      }
      const outcome = classifyExplicitRefusal(provider, exactRefusal);
      writeProviderOutcome({
        provider,
        outcome,
        attemptOrdinal: 1,
        attemptedAt,
        retryAttempted: false,
        phase: "hive_spawn",
        spawnRequested: true,
        cause: exactRefusal,
        wrapperDiagnostic: error.message,
        rawArtifact: raw.artifact,
        rawSha256: raw.sha256,
        terminalAvailability: refusalReadback,
      });
      writeAdmissions();
      continue;
    }
    request.state = "admitted";
    request.admissionId = admission.id;
    ownedIds.add(admission.id);
    let live: Awaited<ReturnType<typeof waitForLiveComposer>>;
    try {
      live = await waitForLiveComposer(admission.id, provider, model);
    } catch (error) {
      const namedBlock =
        error instanceof ObservedProviderBlock
          ? error
          : error instanceof Error &&
              /did not expose a stable painted session/.test(error.message)
            ? new ObservedProviderBlock(
                "launch-refused",
                error.message,
                "terminal-startup",
              )
            : null;
      if (namedBlock === null) throw error;
      const raw = writeRawEvidence(
        `raw/${provider}-attempt-1-refusal.txt`,
        namedBlock.cause,
      );
      writeProviderOutcome({
        provider,
        outcome: namedBlock.outcome,
        attemptOrdinal: 1,
        attemptedAt,
        retryAttempted: false,
        phase: namedBlock.phase,
        spawnRequested: true,
        admissionId: admission.id,
        cause: namedBlock.cause,
        captureSha256: namedBlock.captureSha256,
        rawArtifact: raw.artifact,
        rawSha256: raw.sha256,
        terminalAvailability: {
          state: "unknown",
          observedAt: new Date().toISOString(),
          reason:
            "an admission exists but did not reach a stable painted session",
          diagnosticIds: [admission.id],
        },
      });
      writeAdmissions();
      continue;
    }
    if (live.row.sessionLocator === undefined) {
      throw new Error(`${live.row.name} lost its terminal locator`);
    }
    const exact = {
      ...live,
      row: { ...live.row, sessionLocator: live.row.sessionLocator },
    };
    spawned.push(exact);
    writeProviderOutcome({
      provider,
      outcome: "pending-attestation",
      attemptOrdinal: 1,
      attemptedAt,
      retryAttempted: false,
      phase: "stable-composer",
      spawnRequested: true,
      admissionId: live.row.id,
      name: live.row.name,
      configuredModel: live.row.model,
      status: live.row.status,
      locator: live.row.sessionLocator,
      composer: live.capture.composer,
      captureSha256: live.capture.sha256,
    });
    writeAdmissions();
  }

  const concurrentRows = await status();
  const concurrency = [];
  const sessionIds = new Set<string>();
  for (const { row } of spawned) {
    try {
      const live = requireExactAgent(concurrentRows, row);
      const capture = await observe(live);
      if (live.sessionLocator === undefined)
        throw new Error(`${live.name} lost its locator`);
      sessionIds.add(live.sessionLocator.sessionId);
      concurrency.push({
        agentId: live.id,
        name: live.name,
        provider: live.tool,
        model: live.model,
        status: live.status,
        locator: live.sessionLocator,
        composer: capture.composer,
        stableComposerObserved: stableComposer(capture, live.tool),
        captureSha256: capture.sha256,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      writeProviderOutcome({
        provider: row.tool as CapabilityProvider,
        outcome: "launch-refused",
        attemptOrdinal: 1,
        attemptedAt: new Date().toISOString(),
        retryAttempted: false,
        phase: "concurrency-observe",
        admissionId: row.id,
        name: row.name,
        cause,
      });
    }
  }
  writeEvidence("04-provider-concurrency.json", {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    attestedProviderCount: concurrency.filter(
      (session) => session.stableComposerObserved,
    ).length,
    fiveProviderConcurrencyEstablished:
      concurrency.length === CAPABILITY_PROVIDERS.length,
    sessions: concurrency,
  });

  const logicalViewerId = `u5-workbench-surface-${runId}`;
  const viewerAttempts: Record<string, unknown>[] = [];
  let prior: SessionLocator | null = null;
  for (const { row } of spawned) {
    try {
      const grant = await issueGrant(row, logicalViewerId, ["view"]);
      const output = await SessiondViewerAttachClient.observeOutput({
        locator: row.sessionLocator,
        grant,
        geometry,
        viewerId: logicalViewerId,
      });
      const detachedAt = new Date().toISOString();
      // This client attempts the exact locator but drops a compacted session's
      // checkpoint snapshot and does not await attach readiness. Keep its screen
      // readback explicitly unclaimed when the base state is missing; the
      // production pane is the rendering oracle.
      const auxiliaryReadback = classifyViewerReadback(
        output.completeness,
        output.screen,
      );
      const postSwitchRows = await status();
      const after = requireExactAgent(postSwitchRows, row);
      const capture = await observe(after);
      const stableComposerObserved = stableComposer(capture, after.tool);
      viewerAttempts.push({
        ordinal: viewerAttempts.length + 1,
        viewerId: logicalViewerId,
        fromLocator: prior,
        toLocator: row.sessionLocator,
        grant: safeGrant(grant),
        auxiliaryReadback: {
          ...auxiliaryReadback,
          outputThrough: output.outputThrough,
          screenSha256: createHash("sha256")
            .update(output.screen)
            .digest("hex"),
          screen: output.screen,
        },
        detachedAt,
        postAttempt: {
          agentId: after.id,
          status: after.status,
          locator: after.sessionLocator,
          captureSha256: capture.sha256,
          composer: capture.composer,
          stableComposerObserved,
        },
      });
      prior = row.sessionLocator;
      writeEvidence("05-exact-locator-attempts.json", {
        schemaVersion: 1,
        logicalViewerId,
        attemptPolicy: "one locator-fixed attempt at a time",
        attempts: viewerAttempts,
      });
      await Bun.sleep(100);
    } catch (error) {
      viewerAttempts.push({
        ordinal: viewerAttempts.length + 1,
        viewerId: logicalViewerId,
        toLocator: row.sessionLocator,
        error: error instanceof Error ? error.message : String(error),
      });
      writeEvidence("05-exact-locator-attempts.json", {
        schemaVersion: 1,
        logicalViewerId,
        attemptPolicy: "one locator-fixed attempt at a time",
        attempts: viewerAttempts,
      });
    }
  }

  const finalRows = await status();
  for (const { row } of spawned) requireExactAgent(finalRows, row);
  writeEvidence("06-final-live-readback.json", {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    agents: spawned.map(({ row }) => {
      const live = requireExactAgent(finalRows, row);
      return {
        agentId: live.id,
        name: live.name,
        provider: live.tool,
        model: live.model,
        status: live.status,
        locator: live.sessionLocator,
      };
    }),
  });

  let appViewerLifecycle: Record<string, unknown>;
  {
    const ready = {
      schemaVersion: 1,
      state: "ready",
      observedAt: new Date().toISOString(),
      evidenceRoot,
      agents: spawned.map(({ row }) => ({
        agentId: row.id,
        name: row.name,
        provider: row.tool,
        model: row.model,
        status: row.status,
        locator: row.sessionLocator,
      })),
    };
    writeEvidence("07-app-ready.json", ready);
    writeAtomic(appReadyPath, ready);
    if (!existsSync(appReadyPath)) {
      throw new Error("app proof ready marker was not observable after write");
    }

    const deadline = Date.now() + 10 * 60_000;
    let nextHealthRead = 0;
    while (!existsSync(appReleasePath)) {
      throwIfInterrupted();
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the production Workspace proof");
      }
      if (Date.now() >= nextHealthRead) {
        const heldRows = await status();
        for (const { row } of spawned) requireExactAgent(heldRows, row);
        nextHealthRead = Date.now() + 2_000;
      }
      await Bun.sleep(250);
    }

    const release = AppLifecycleReleaseSchema.parse(
      JSON.parse(readFileSync(appReleasePath, "utf8")),
    );
    const releaseVerification = verifyAppLifecycleRelease(release);
    const screenshotBasenames = new Set(
      release.screenshots.map((screenshot) => basename(screenshot)),
    );
    const expectedScreenshotBasenames = spawned.map(
      ({ row }) => `workspace-final-${row.tool}.png`,
    );
    if (
      release.screenshots.length !== expectedScreenshotBasenames.length ||
      screenshotBasenames.size !== expectedScreenshotBasenames.length ||
      expectedScreenshotBasenames.some(
        (expected) => !screenshotBasenames.has(expected),
      )
    ) {
      throw new Error(
        `app proof screenshots did not exactly cover the live provider set: ${[...screenshotBasenames].join(", ")}`,
      );
    }
    for (const screenshot of release.screenshots) {
      if (!existsSync(screenshot)) {
        throw new Error(`app proof screenshot is absent: ${screenshot}`);
      }
      const exactScreenshot = realpathSync(screenshot);
      if (!exactScreenshot.startsWith(`${artifacts}/`)) {
        throw new Error(
          `app proof screenshot is outside the artifact root: ${exactScreenshot}`,
        );
      }
    }

    const feedReceipt = WorkspaceFeedReceiptSchema.parse(
      JSON.parse(readFileSync(appFeedReceiptPath, "utf8")),
    );
    if (
      resolve(feedReceipt.sourceReadyPath) !== appReadyPath ||
      feedReceipt.agentCount !== spawned.length ||
      feedReceipt.acceptedVisibility.length === 0 ||
      feedReceipt.acceptedVisibility.some(
        (entry) =>
          entry.terminalCount !== entry.terminals.length ||
          entry.terminalCount > 1,
      )
    ) {
      throw new Error(
        "production Workspace visibility did not preserve one exact live viewer",
      );
    }
    const exactSelectionTrace = spawned.map(({ row }) => {
      const event = feedReceipt.acceptedVisibility.find((entry) => {
        const terminal = entry.terminals[0];
        return (
          terminal !== undefined &&
          terminal.agentId === row.id &&
          sameSessionLocator(terminal.locator, row.sessionLocator)
        );
      });
      if (event === undefined) {
        throw new Error(
          `production Workspace never selected exact ${row.tool} generation`,
        );
      }
      return {
        provider: row.tool,
        agentId: row.id,
        locator: row.sessionLocator,
        acceptedVisibility: event,
      };
    });

    const postKillRows = await status();
    const postKillAgents = [];
    for (const { row } of spawned) {
      const live = requireExactAgent(postKillRows, row);
      const capture = await observe(live);
      postKillAgents.push({
        agentId: live.id,
        name: live.name,
        provider: live.tool,
        status: live.status,
        locator: live.sessionLocator,
        composer: capture.composer,
        stableComposerObserved: stableComposer(capture, live.tool),
        captureSha256: capture.sha256,
      });
    }
    const allExactGenerationsRetained =
      postKillAgents.length === spawned.length;
    const stableComposerCount = postKillAgents.filter(
      (agent) => agent.stableComposerObserved,
    ).length;
    appViewerLifecycle = {
      state: "measured",
      release,
      releaseVerification,
      allExactGenerationsRetained,
      stableComposerCount,
      oneVisibleTerminalAtAllTimes: true,
      exactSelectionTrace,
      feedReceipt,
      agents: postKillAgents,
    };
    writeEvidence("08-app-sigkill-session-readback.json", {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      ...appViewerLifecycle,
    });
  }

  for (const { row } of spawned) {
    const priorRecord = providerOutcomes.get(row.tool);
    if (priorRecord?.outcome !== "pending-attestation") {
      continue;
    }
    const concurrencyEvidence = concurrency.find(
      (session) => session.provider === row.tool,
    );
    const exactLocatorAttempt = viewerAttempts.find((candidate) => {
      const target = candidate.toLocator as SessionLocator;
      return sameSessionLocator(target, row.sessionLocator);
    });
    const postViewerKill = (
      appViewerLifecycle.agents as Record<string, unknown>[]
    ).find((agent) => agent.provider === row.tool);
    if (
      concurrencyEvidence === undefined ||
      exactLocatorAttempt === undefined ||
      exactLocatorAttempt.error !== undefined ||
      postViewerKill === undefined
    ) {
      writeProviderOutcome({
        ...priorRecord,
        outcome: "launch-refused",
        cause: `${row.tool} is missing a final attestation leg`,
      });
      continue;
    }
    writeProviderOutcome({
      ...priorRecord,
      outcome: "attested",
      attestedAt: new Date().toISOString(),
      attestedSurfaces: {
        terminalGeneration: "attested",
        stableComposer: "attested",
        hiveToolset: {
          state: "unmeasured",
          reason: "this proof does not ask the provider to invoke Hive tools",
        },
      },
      concurrency: concurrencyEvidence,
      exactLocatorAttempt,
      postViewerKill,
    });
  }
  writeAdmissions();
  const liveRunProcessControls = await proveLiveRunControls(
    spawned.map(({ row }) => row),
  );
  for (const providerControl of liveRunProcessControls.providers) {
    const provider = providerControl.provider as CapabilityProvider;
    const record = providerOutcomes.get(provider);
    if (record === undefined) continue;
    if (providerControl.outcome === "proven") {
      writeProviderOutcome({
        ...record,
        outcome:
          record.outcome === "pending-attestation" ||
          record.outcome === "attested"
            ? "attested"
            : record.outcome,
        liveRunProcessControl: providerControl,
      });
      continue;
    }
    writeProviderOutcome({
      ...record,
      outcome: "launch-refused",
      cause:
        typeof providerControl.reason === "string"
          ? providerControl.reason
          : `${provider} live-run process control blocked`,
      liveRunProcessControl: providerControl,
    });
  }
  const outcomeSummary = summarizeProviderOutcomes(
    attemptProviders,
    new Map(
      [...providerOutcomes].map(([provider, record]) => [
        provider,
        record.outcome,
      ]),
    ),
  );

  return {
    result: outcomeSummary.result,
    acceptance: outcomeSummary.acceptance,
    scope,
    liveProofCompletedAt: new Date().toISOString(),
    providerCount: spawned.length,
    exactLocatorAttemptCount: viewerAttempts.length,
    attemptedProviders: attemptProviders,
    attestedProviders: outcomeSummary.attestedProviders,
    blockedProviders: outcomeSummary.blockedProviders.map((provider) => {
      const record = providerOutcomes.get(provider);
      if (record === undefined) {
        throw new Error(`${provider} has no provider outcome record`);
      }
      return {
        ...disclosedMatrixRow({
          provider,
          outcome: record.outcome,
          cause: record.cause ?? record.reason,
        }),
        attemptOrdinal: record.attemptOrdinal,
        artifact: `providers/${provider}.json`,
      };
    }),
    fiveProviderConcurrencyEstablished:
      spawned.length === CAPABILITY_PROVIDERS.length,
    backgroundRows: "typed status only; no background viewer was created",
    backgroundDraftPreserved: "not claimed by this bounded proof",
    appViewerLifecycle,
    liveRunProcessControls,
  };
}

async function cleanupOwnedAgents(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown>[] = [];
  let rows: AgentRecord[] = [];
  const reconciliationDeadline = Date.now() + 5_000;
  for (;;) {
    try {
      rows = await status();
      const reconciled = rows.filter(
        (row) =>
          !initialAgentIds.has(row.id) &&
          (ownedIds.has(row.id) || row.taskDescription.includes(taskMarker)),
      );
      if (
        reconcileSpawnRequests(spawnRequests, reconciled).complete ||
        Date.now() >= reconciliationDeadline
      ) {
        break;
      }
    } catch (error) {
      if (Date.now() >= reconciliationDeadline) {
        return {
          state: "unknown",
          error: error instanceof Error ? error.message : String(error),
          results,
        };
      }
    }
    await Bun.sleep(250);
  }
  const targets = rows.filter(
    (row) =>
      !initialAgentIds.has(row.id) &&
      (ownedIds.has(row.id) || row.taskDescription.includes(taskMarker)),
  );
  const reconciliation = reconcileSpawnRequests(spawnRequests, targets);
  const refusedRequests = spawnRequests.filter(
    (request) => request.state === "refused",
  );
  for (const target of targets) {
    ownedIds.add(target.id);
    ownedNames.set(target.id, target.name);
    const nameOwner = rows.find(
      (row) => row.name === target.name && !terminalStatuses.has(row.status),
    );
    if (nameOwner !== undefined && nameOwner.id !== target.id) {
      results.push({
        agentId: target.id,
        name: target.name,
        state: "refused",
        reason: `name is now held by ${nameOwner.id}`,
      });
      continue;
    }
    try {
      const result = await callTool(
        "hive_kill",
        { name: target.name, removeWorktree: true },
        "result",
        HiveKillResultSchema,
      );
      const exactAgentReturned =
        result.agent.id === target.id &&
        result.agent.name === target.name &&
        result.agent.status === "dead";
      results.push({
        agentId: target.id,
        name: target.name,
        state:
          result.reaped.survivors.length > 0
            ? "survivors"
            : exactAgentReturned
              ? "requested"
              : "unknown",
        result,
      });
    } catch (error) {
      results.push({
        agentId: target.id,
        name: target.name,
        state: "unknown",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const unknown = results.filter((result) => result.state === "unknown");
  const failed = results.filter(
    (result) => result.state !== "requested" && result.state !== "unknown",
  );
  const restorationDeadline = Date.now() + 15_000;
  let projectReadback: Record<string, string> = {};
  let projectRestored = false;
  for (;;) {
    projectReadback = {
      head: git(project, "rev-parse", "HEAD"),
      status: git(project, "status", "--porcelain"),
      worktrees: git(project, "worktree", "list", "--porcelain"),
    };
    projectRestored =
      projectReadback.head === initialProjectHead &&
      projectReadback.status === initialProjectStatus &&
      projectReadback.worktrees === initialProjectWorktrees;
    if (projectRestored || Date.now() >= restorationDeadline) break;
    await Bun.sleep(250);
  }
  let terminalReadback: boolean | { state: "unknown"; error: string } = false;
  try {
    const finalRows = await status();
    terminalReadback = targets.every((target) => {
      const row = finalRows.find((candidate) => candidate.id === target.id);
      return row === undefined || terminalStatuses.has(row.status);
    });
  } catch (error) {
    terminalReadback = {
      state: "unknown",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const cleanupUnknown =
    !reconciliation.complete ||
    unknown.length > 0 ||
    typeof terminalReadback !== "boolean";
  return {
    state: cleanupUnknown
      ? "unknown"
      : failed.length === 0 && projectRestored && terminalReadback
        ? "clean"
        : "failed",
    exactOwnedNames: Object.fromEntries(ownedNames),
    results,
    reconciliationComplete: reconciliation.complete,
    requestCount: reconciliation.requestCount,
    admittedIds: reconciliation.admittedIds,
    missingAdmissionIds: reconciliation.missingAdmissionIds,
    invalidAdmissionProviders: reconciliation.invalidAdmissionProviders,
    refusedRequests: refusedRequests.map((request) => ({
      provider: request.provider,
      marker: request.marker,
      refusalReadback: request.refusalReadback,
    })),
    refusedSideEffectIds: reconciliation.refusedSideEffectIds,
    unknownProviders: reconciliation.unknownProviders,
    projectRestored,
    terminalReadback,
    projectReadback,
  };
}

async function restoreRouting(): Promise<Record<string, unknown>> {
  if (initialPolicy === null) return { state: "not-mutated" };
  let current = await readPolicy();
  current = await mutatePolicy({
    op: "set-route",
    expectedRevision: current.revision,
    scope: "simple_coding",
    route: initialPolicy.categories.simple_coding ?? null,
  });

  const touched = new Map<
    string,
    { provider: CapabilityProvider; model: string }
  >();
  for (const [provider, model] of selectedModels) {
    touched.set(`${provider}\0${model.canonicalId}`, {
      provider,
      model: model.canonicalId,
    });
  }
  for (const [provider, model] of selectedModelOverrides) {
    touched.set(`${provider}\0${model}`, { provider, model });
  }
  if (scopedPartial) {
    touched.set(`kimi\0${kimiHardRoute}`, {
      provider: "kimi",
      model: kimiHardRoute,
    });
  }
  for (const candidate of initialPolicy.categories.simple_coding?.candidates ??
    []) {
    touched.set(`${candidate.provider}\0${candidate.model}`, {
      provider: candidate.provider,
      model: candidate.model,
    });
  }
  for (const target of touched.values()) {
    const original = initialPolicy.models.find(
      (row) => row.provider === target.provider && row.model === target.model,
    );
    current = await mutatePolicy({
      op: "set-model",
      expectedRevision: current.revision,
      provider: target.provider,
      model: target.model,
      state: original?.state ?? "unset",
    });
    current = await mutatePolicy({
      op: "set-effort",
      expectedRevision: current.revision,
      provider: target.provider,
      model: target.model,
      effort: original?.effort ?? "unset",
    });
  }
  for (const provider of CAPABILITY_PROVIDERS) {
    current = await mutatePolicy({
      op: "set-provider",
      expectedRevision: current.revision,
      provider,
      state: initialPolicy.providers[provider] ?? "unset",
    });
  }
  const readback = await readPolicy();
  const routeRestored =
    JSON.stringify(readback.categories.simple_coding ?? null) ===
    JSON.stringify(initialPolicy.categories.simple_coding ?? null);
  const providersRestored = CAPABILITY_PROVIDERS.every(
    (provider) =>
      readback.providers[provider] === initialPolicy?.providers[provider],
  );
  const residualUnconfiguredRows = readback.models.filter(
    (row) =>
      !initialPolicy?.models.some(
        (original) =>
          original.provider === row.provider && original.model === row.model,
      ),
  );
  return {
    state: routeRestored && providersRestored ? "restored" : "failed",
    initialRevision: initialPolicy.revision,
    finalRevision: readback.revision,
    routeRestored,
    providersRestored,
    residualUnconfiguredRows,
  };
}

let proof: Record<string, unknown> = { result: "failed", startedAt };
let proofError: string | null = null;
try {
  proof = await runProof();
} catch (error) {
  proofError = error instanceof Error ? error.message : String(error);
  proof = {
    result: "failed",
    startedAt,
    endedAt: new Date().toISOString(),
    error: proofError,
  };
}

// A signal stops the proof loop, but cleanup still needs authenticated reads
// and exact-name kills. The failure record above preserves which signal won.
interruptedBy = null;
const cleanup = await cleanupOwnedAgents().catch((error) => ({
  state: "unknown",
  error: error instanceof Error ? error.message : String(error),
}));
const routingRestore = await restoreRouting().catch((error) => ({
  state: "failed",
  error: error instanceof Error ? error.message : String(error),
}));
const sentinelBeforeCleanup = processReadback(survivingSentinel.pid);
survivingSentinel.kill();
const sentinelExitCode = await survivingSentinel.exited;
const sentinelAfterCleanup = processReadback(survivingSentinel.pid);
const sentinelCleanup = {
  state:
    sentinelBeforeCleanup.state === "live" &&
    sentinelAfterCleanup.state === "absent"
      ? "clean"
      : "failed",
  before: sentinelBeforeCleanup,
  exitCode: sentinelExitCode,
  after: sentinelAfterCleanup,
};
const headlessRootCleanup = await reapIsolatedHeadlessRoot().catch((error) => ({
  state: "failed" as const,
  error: error instanceof Error ? error.message : String(error),
}));
const rootReaped =
  headlessRootCleanup.state === "clean" ||
  headlessRootCleanup.state === "not-opened";
const finalDecision = finalU5Result(
  proof.result === "passed" || proof.result === "partial"
    ? proof.result
    : "failed",
  cleanup.state === "clean" && sentinelCleanup.state === "clean" && rootReaped
    ? "clean"
    : cleanup.state === "failed" ||
        sentinelCleanup.state === "failed" ||
        !rootReaped
      ? "failed"
      : "unknown",
  routingRestore.state === "restored" ? "restored" : "failed",
);
const providerMatrix = buildProviderMatrix(
  attemptProviders,
  providerOutcomes,
).map((row) => ({
  ...row,
  artifact:
    providerOutcomes.get(row.provider as CapabilityProvider) === undefined
      ? null
      : `providers/${row.provider}.json`,
}));
const result = {
  schemaVersion: 1,
  runId,
  scope,
  result: finalDecision.result,
  acceptance: finalDecision.acceptance,
  startedAt,
  completedAt: new Date().toISOString(),
  artifactRoot: evidenceRoot,
  proof,
  proofError,
  providerMatrix,
  limitations: [
    ...(proof.result === "partial"
      ? [
          "Five-provider concurrency is not established; every blocked provider is a deferred obligation requiring a full fresh proof after restart.",
        ]
      : []),
    "Background draft preservation is not claimed; a separate fresh attempt failed and remains red evidence.",
  ],
};
writeEvidence("result.json", result);
console.log(json(result));
process.exitCode = finalDecision.exitCode;
