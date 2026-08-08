// Drives one real root/queen session through launch, self-send, observation,
// and teardown against an already-running private QA rig. Composition uses
// only existing doors: hidden `hive workspace-orchestrator`, POST/GET
// /orchestrator-session, queen.cap → hive_terminal_observe, and the mailbox.
// Every empty read has a positive control; notified ≠ acknowledged is recorded
// honestly (B6 terrain).

import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { agentFetch, userFetch } from "../../src/cli/credential";
import { buildHookEvent, postHookEvent } from "../../src/cli/event-command";
import { OrchestratorSessiondSnapshotSchema } from "../../src/daemon/orchestrator-host/sessiond-controller";
import { CaptureResultSchema } from "../../src/schemas/session-protocol";
import { RunCheckpointSchema } from "../../src/schemas/run-checkpoint";
import {
  RoutingPolicySchema,
  type RoutingPolicy,
} from "../../src/schemas/routing-policy";
import { isProductFailure } from "./agent-scenario-core";
import {
  applyOrphanRefuseTransition,
  bindRetryMessageId,
  catalogDeterminism,
  classifyUserOrphan,
  deliveryEvidenceLabel,
  hasTerminalWriteReceipt,
  planOrphanRefuseTransition,
  type AttemptEvidence,
  type BlockedDelivery,
  type QCatalogRowId,
} from "./queen-scenario-core";
import {
  callMcpTool,
  requiredQaCoordinates,
  writeRowRecord,
  type QaRowRecord,
} from "./qa-client";

const coordinates = requiredQaCoordinates();
const home = realpathSync(coordinates.home);
const project = realpathSync(coordinates.project);
const artifacts = realpathSync(coordinates.artifacts);
const sourceRoot = realpathSync(coordinates.sourceRoot);
const port = coordinates.port;

if (!home.startsWith("/private/tmp/hvqa-") && !home.startsWith("/tmp/hvqa-")) {
  throw new Error(`QA home is not an isolated rig: ${home}`);
}
if (!artifacts.startsWith(`${home}/`)) {
  throw new Error(`artifact directory is outside QA home: ${artifacts}`);
}
if (home.includes("hvqa-0de8db4fd4")) {
  throw new Error(`refusing the shared off-limits rig: ${home}`);
}

process.env.HIVE_HOME = home;

const tool = z
  .enum(["claude", "codex", "grok", "kimi", "opencode"])
  .parse(process.env.HIVE_QA_QUEEN_TOOL ?? "claude");
const nonce = `Q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const ackMarker = `HIVE_QA_QUEEN_ACK ${nonce}`;
const sourceSha = git("-C", sourceRoot, "rev-parse", "HEAD");
const initialHead = git("-C", project, "rev-parse", "HEAD");
const initialWorktrees = git("-C", project, "worktree", "list", "--porcelain");
const instanceId = createHash("sha256").update(home).digest("hex").slice(0, 10);
const recordsPath = join(artifacts, "queen-scenario.jsonl");
const evidenceNames = ["queen-scenario.jsonl"];
writeFileSync(recordsPath, "");

const SendSummarySchema = z.object({ itemId: z.string() });
const TerminalObservationSchema = z.object({
  capture: CaptureResultSchema,
});
const MessageRowSchema = z.object({
  id: z.string(),
  state: z.enum(["queued", "notified", "acknowledged"]),
  createdAt: z.string(),
  notifiedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
});
const TerminalReceiptSchema = z
  .object({
    transactionId: z.string(),
    stage: z.string().optional(),
    diagnostic: z.string().nullable().optional(),
  })
  .loose();
const MessageAttemptSchema = z.object({
  attemptId: z.string(),
  messageId: z.string(),
  outcome: z.enum([
    "pending",
    "written",
    "foreground-changed",
    "input-busy",
    "timeout",
    "unknown",
  ]),
  terminalReceipt: TerminalReceiptSchema.nullable(),
});

type MessageRow = z.infer<typeof MessageRowSchema>;
type MessageAttempt = z.infer<typeof MessageAttemptSchema>;
type Snapshot = z.infer<typeof OrchestratorSessiondSnapshotSchema>;

let supervisor: Bun.Subprocess | null = null;
let rootLocator: Snapshot["locator"] | null = null;
// Survivor set is ONLY processes this scenario started (supervisor + root
// provider). Never lsof +D the shared project path — every rig shares
// QA_PROJECT by design, and a path-primary kill is fratricide (T6 review:
// "the path gate never becomes primary").
let ownedIdentities = new Set<string>();
const rows: QaRowRecord[] = [];

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args]);
  if (!result.success)
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  return new TextDecoder().decode(result.stdout).trim();
}

function record(
  id: QCatalogRowId,
  verdict: QaRowRecord["verdict"],
  extraEvidence: string[] = [],
): void {
  // Catalog is the single authority for ownership and determinism. Only Q-owned
  // row ids may appear here (D owns MCP-12/MCP-39; A owns MCP-03/CLI-17).
  const row: QaRowRecord = {
    id,
    mode: "live",
    verdict,
    determinism: catalogDeterminism(id),
    bugs: { present: [], absent: [] },
    evidence: [...evidenceNames, ...extraEvidence],
    sourceSha,
  };
  rows.push(row);
  writeRowRecord(recordsPath, row);
}

async function callQueenTool<T>(
  name: string,
  args: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return await callMcpTool(port, agentFetch("queen"), name, args, key, schema);
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  read: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(500);
  }
}

async function lsof(args: string[]): Promise<string> {
  const child = Bun.spawn(["lsof", "-n", "-P", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0 && stdout.length === 0) {
    if (code === 1 && stderr.length === 0) return "";
    throw new Error(`lsof failed (${code}): ${stderr.trim()}`);
  }
  return stdout;
}

function parseCwdIdentities(output: string): Set<string> {
  const identities = new Set<string>();
  let pid: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    if (line.startsWith("i") && pid !== null)
      identities.add(`${pid}:${line.slice(1)}`);
  }
  return identities;
}

async function cwdIdentityForPid(pid: number): Promise<string | null> {
  const identities = parseCwdIdentities(
    await lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fpfi"]),
  );
  return identities.values().next().value ?? null;
}

async function ownPid(pid: number | undefined | null): Promise<void> {
  if (pid === undefined || pid === null || !Number.isFinite(pid) || pid <= 1)
    return;
  const identity = await cwdIdentityForPid(pid);
  if (identity !== null) ownedIdentities.add(identity);
}

function rootProviderPid(sessionId: string): number | null {
  const db = new Database(`${home}/hive.db`, { readonly: true });
  try {
    const row = db
      .query(
        "SELECT recordJson FROM provider_runs WHERE terminalSessionId = ? AND state = 'running' ORDER BY rowid DESC LIMIT 1",
      )
      .get(sessionId) as { recordJson: string } | null;
    if (row === null) return null;
    return z
      .object({ pid: z.number().int().positive() })
      .loose()
      .parse(JSON.parse(row.recordJson)).pid;
  } finally {
    db.close();
  }
}

async function getOrchestratorSession(): Promise<Snapshot | null> {
  const response = await userFetch(
    `http://127.0.0.1:${port}/orchestrator-session`,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `GET /orchestrator-session failed (${response.status}): ${body}`,
    );
  }
  return OrchestratorSessiondSnapshotSchema.parse(await response.json());
}

async function readRoutingPolicy(): Promise<RoutingPolicy> {
  const response = await userFetch(
    `http://127.0.0.1:${port}/routing/policy`,
  );
  if (!response.ok) {
    throw new Error(
      `GET /routing/policy failed (${response.status}): ${await response.text().catch(() => "")}`,
    );
  }
  return RoutingPolicySchema.parse(await response.json());
}

async function mutateRoutingPolicy(
  mutation: Record<string, unknown>,
): Promise<RoutingPolicy> {
  const response = await userFetch(
    `http://127.0.0.1:${port}/routing/policy`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mutation),
    },
  );
  if (!response.ok) {
    throw new Error(
      `POST /routing/policy failed (${response.status}): ${await response.text().catch(() => "")}`,
    );
  }
  return RoutingPolicySchema.parse(await response.json());
}

const InventoryModelSchema = z
  .object({
    vendor: z.string(),
    canonicalId: z.string().min(1),
  })
  .loose();
const ModelInventorySchema = z
  .object({
    models: z.array(InventoryModelSchema),
    discoveredCount: z.number().int().nonnegative(),
  })
  .loose();

/** Real catalog door + provider enablement before the one authorized spend. */
async function preflightAdmissionLadder(): Promise<{
  model: string;
  provider: string;
}> {
  // hive_models is the production inventory; inventing model ids is the same
  // fixture/production divergence class as minting content:true only in tests.
  const inventory = await callMcpTool(
    port,
    userFetch,
    "hive_models",
    {},
    "inventory",
    ModelInventorySchema,
  );
  const forTool = inventory.models.filter((model) => model.vendor === tool);
  if (forTool.length === 0) {
    throw new Error(
      `PRODUCT_RED hive_models inventory has no models for provider ${tool} (discoveredCount=${inventory.discoveredCount})`,
    );
  }
  const selected = forTool[0]!;
  const modelId = selected.canonicalId;
  // Prove the selected id is still present when re-read (not a one-shot parse).
  const inventoryAgain = await callMcpTool(
    port,
    userFetch,
    "hive_models",
    {},
    "inventory",
    ModelInventorySchema,
  );
  if (
    !inventoryAgain.models.some(
      (model) => model.vendor === tool && model.canonicalId === modelId,
    )
  ) {
    throw new Error(
      `PRODUCT_RED selected model ${tool}/${modelId} disappeared from hive_models on re-read`,
    );
  }

  let policy = await readRoutingPolicy();
  if (policy.providers[tool] !== "enabled") {
    policy = await mutateRoutingPolicy({
      op: "set-provider",
      expectedRevision: policy.revision,
      provider: tool,
      state: "enabled",
    });
  }
  const enabledReadback = await readRoutingPolicy();
  if (enabledReadback.providers[tool] !== "enabled") {
    throw new Error(
      `PRODUCT_RED provider ${tool} not enabled after set-provider readback`,
    );
  }

  const route =
    enabledReadback.global ??
    enabledReadback.categories.standard_coding ??
    null;
  const hasExactCandidate =
    route?.candidates.some(
      (candidate) =>
        candidate.provider === tool && candidate.model === modelId,
    ) === true;
  if (!hasExactCandidate) {
    policy = await readRoutingPolicy();
    await mutateRoutingPolicy({
      op: "set-route",
      expectedRevision: policy.revision,
      scope: "global",
      route: {
        mode: "user-weighted",
        candidates: [
          {
            provider: tool,
            model: modelId,
            effort: { mode: "none" },
            weight: 1,
          },
        ],
      },
    });
  }

  const finalPolicy = await readRoutingPolicy();
  if (finalPolicy.providers[tool] !== "enabled") {
    throw new Error(
      `PRODUCT_RED provider enablement readback lost for ${tool}`,
    );
  }
  const finalRoute =
    finalPolicy.global ?? finalPolicy.categories.standard_coding ?? null;
  if (
    finalRoute?.candidates.some(
      (candidate) =>
        candidate.provider === tool && candidate.model === modelId,
    ) !== true
  ) {
    throw new Error(
      `PRODUCT_RED route readback missing catalog-proven ${tool}/${modelId}`,
    );
  }
  // Third independent fact: model still in the live catalog after policy write.
  const postWriteCatalog = await callMcpTool(
    port,
    userFetch,
    "hive_models",
    {},
    "inventory",
    ModelInventorySchema,
  );
  if (
    !postWriteCatalog.models.some(
      (model) => model.vendor === tool && model.canonicalId === modelId,
    )
  ) {
    throw new Error(
      `PRODUCT_RED ${tool}/${modelId} left the catalog after route write`,
    );
  }
  console.log(
    `preflight ok: catalog model=${tool}/${modelId}; provider enabled; route revision=${finalPolicy.revision}`,
  );
  writeFileSync(
    join(artifacts, "queen-preflight-policy.json"),
    `${JSON.stringify(
      {
        provider: tool,
        model: modelId,
        enabled: finalPolicy.providers[tool],
        route: finalRoute,
        revision: finalPolicy.revision,
        catalogDiscovered: inventory.discoveredCount,
      },
      null,
      2,
    )}\n`,
  );
  return { model: modelId, provider: tool };
}







async function observeRoot(
  locator: Snapshot["locator"],
): Promise<z.infer<typeof TerminalObservationSchema>> {
  return await callQueenTool(
    "hive_terminal_observe",
    {
      sessionId: locator.sessionId,
      generation: locator.generation,
      include: "visible-text",
      maxRows: 200,
    },
    "terminalObservation",
    TerminalObservationSchema,
  );
}

function signalPid(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

async function terminateRootAndSupervisor(): Promise<"clean" | "no-launch"> {
  if (supervisor === null && rootLocator === null && ownedIdentities.size === 0)
    return "no-launch";

  if (rootLocator !== null) {
    await ownPid(rootProviderPid(rootLocator.sessionId));
  }
  if (supervisor?.pid !== undefined) {
    await ownPid(supervisor.pid);
  }

  if (supervisor !== null && supervisor.pid !== undefined) {
    signalPid(supervisor.pid, "SIGTERM");
  }
  await Bun.sleep(500);
  if (supervisor !== null && supervisor.pid !== undefined) {
    signalPid(supervisor.pid, "SIGKILL");
  }

  for (const identity of ownedIdentities) {
    const pid = Number(identity.slice(0, identity.indexOf(":")));
    if (!Number.isFinite(pid) || pid <= 1) continue;
    if ((await cwdIdentityForPid(pid)) === identity) {
      signalPid(pid, "SIGTERM");
    }
  }
  await Bun.sleep(500);
  for (const identity of ownedIdentities) {
    const pid = Number(identity.slice(0, identity.indexOf(":")));
    if (!Number.isFinite(pid) || pid <= 1) continue;
    if ((await cwdIdentityForPid(pid)) === identity) {
      signalPid(pid, "SIGKILL");
    }
  }

  await waitFor("owned root/supervisor processes to exit", 30_000, async () => {
    for (const identity of ownedIdentities) {
      const pid = Number(identity.slice(0, identity.indexOf(":")));
      if ((await cwdIdentityForPid(pid)) === identity) return null;
    }
    return true;
  });

  await waitFor("orchestrator session not running", 15_000, async () => {
    const snap = await getOrchestratorSession();
    if (snap === null || snap.state !== "running") return true;
    return null;
  }).catch(() => {
    console.log(
      "orchestrator-session still reports running after owned-pid kill; survivor readback is authoritative",
    );
  });

  if (supervisor !== null) {
    await Promise.race([
      supervisor.exited,
      Bun.sleep(5_000).then(() => undefined),
    ]);
    supervisor = null;
  }

  const clean =
    git("-C", project, "status", "--porcelain") === "" &&
    git("-C", project, "rev-parse", "HEAD") === initialHead &&
    git("-C", project, "worktree", "list", "--porcelain") === initialWorktrees;
  if (!clean) {
    throw new Error(
      `INFRASTRUCTURE_RED project not restored after root teardown: head/worktree/porcelain drifted`,
    );
  }
  return "clean";
}

// --- preflight -------------------------------------------------------------
if (git("-C", project, "status", "--porcelain") !== "") {
  throw new Error(`QA project is not fresh: ${project}`);
}
const readerControl = await cwdIdentityForPid(process.pid);
const expectedReaderControl = `${process.pid}:${statSync(process.cwd(), { bigint: true }).ino}`;
if (readerControl !== expectedReaderControl) {
  throw new Error(
    "lsof process reader failed its pid+cwd-inode positive control",
  );
}
mkdirSync(artifacts, { recursive: true });

let failure: unknown = null;
const sys07Evidence: string[] = [];
try {
  const preflight = await preflightAdmissionLadder();
  sys07Evidence.push(
    `preflight:${preflight.provider}/${preflight.model}`,
    "catalog:hive_models",
  );

  // Honest headless-owner checkpoint: root TUI context is unmeasured here.
  // Checkpoint is Q evidence inside SYS-07 (MCP-39 is D-owned; do not emit it).
  const checkpoint = await callQueenTool(
    "hive_run_checkpoint",
    {
      reason: "unknown-context",
      contextUsage: {
        kind: "unknown",
        reason: "headless QA owner has no root TUI context measurement",
      },
      decision: {
        decision: "replace",
        reason: "checkpoint the headless owner before queen root launch",
      },
      written: {
        goal: "Run one QA queen root through launch, nonce self-send, observe, teardown",
        done: [
          "QA rig coordinates verified",
          "pid+cwd-inode reader control passed",
          "provider enablement and catalog route read back",
        ],
        failures: [],
        uncertainty: [
          "Provider turn wording around the exact ACK marker is unbounded",
        ],
        nextAction: `Launch workspace-orchestrator tool=${tool} and measure one nonce round-trip`,
        rollback: "Terminate the supervisor and root provider processes",
      },
      unresolvedQuestions: [],
      model: null,
    },
    "checkpoint",
    RunCheckpointSchema,
  );
  if (!checkpoint.digest.startsWith("sha256:")) {
    throw new Error(
      `PRODUCT_RED checkpoint digest missing/invalid: ${checkpoint.digest}`,
    );
  }
  if (checkpoint.revision.length === 0) {
    throw new Error("PRODUCT_RED checkpoint revision is empty");
  }
  if (checkpoint.written === null) {
    throw new Error(
      "PRODUCT_RED checkpoint written layer is null after supplying one",
    );
  }
  console.log(
    `checkpoint written digest=${checkpoint.digest} revision=${checkpoint.revision}`,
  );
  writeFileSync(
    join(artifacts, "queen-checkpoint.json"),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
  );
  sys07Evidence.push(
    `checkpoint.digest=${checkpoint.digest}`,
    `checkpoint.revision=${checkpoint.revision}`,
    `checkpoint.written.goal=${checkpoint.written.goal.slice(0, 120)}`,
    `checkpoint.written.nextAction=${checkpoint.written.nextAction.slice(0, 80)}`,
    "artifact:queen-checkpoint.json",
  );

  const supervisorLog = join(artifacts, "workspace-orchestrator.log");
  supervisor = Bun.spawn(
    [
      "bun",
      "run",
      join(sourceRoot, "src/cli.ts"),
      "workspace-orchestrator",
      "--tool",
      tool,
      "--port",
      String(port),
      "--instance-id",
      instanceId,
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        HIVE_HOME: home,
        HIVE_DEFAULT_HOME: join(home, "default"),
        HIVE_DISABLE_UPDATES: "1",
      },
      stdin: "ignore",
      stdout: Bun.file(supervisorLog),
      stderr: Bun.file(supervisorLog),
    },
  );
  await ownPid(supervisor.pid);
  console.log(
    `spawned workspace-orchestrator pid=${supervisor.pid} tool=${tool} instance=${instanceId} (CLI-17 waits for running root)`,
  );

  const running = await waitFor(
    "orchestrator session running",
    120_000,
    async () => {
      if (supervisor !== null && supervisor.exitCode !== null) {
        throw new Error(
          `PRODUCT_RED workspace-orchestrator exited early code=${supervisor.exitCode}; see ${supervisorLog}`,
        );
      }
      const snap = await getOrchestratorSession();
      if (snap === null) return null;
      if (snap.state === "failed") {
        throw new Error(
          `PRODUCT_RED queen session failed: ${snap.diagnostic ?? "no diagnostic"}`,
        );
      }
      if (snap.state === "exited") {
        throw new Error(
          `PRODUCT_RED queen session exited before running exitCode=${snap.exitCode}`,
        );
      }
      if (snap.state !== "running") return null;
      if (snap.locator.instanceId !== instanceId) {
        throw new Error(
          `PRODUCT_RED root instanceId mismatch: got ${snap.locator.instanceId} want ${instanceId}`,
        );
      }
      return snap;
    },
  );
  rootLocator = running.locator;
  const firstLocator = {
    sessionId: running.locator.sessionId,
    generation: running.locator.generation,
    instanceId: running.locator.instanceId,
  };
  await Bun.sleep(500);
  const stable = await getOrchestratorSession();
  if (
    stable === null ||
    stable.state !== "running" ||
    stable.locator.sessionId !== firstLocator.sessionId ||
    stable.locator.generation !== firstLocator.generation ||
    stable.locator.instanceId !== firstLocator.instanceId
  ) {
    throw new Error(
      `PRODUCT_RED root locator was not stable across two reads: first=${JSON.stringify(firstLocator)} second=${JSON.stringify(stable?.locator ?? null)}`,
    );
  }
  rootLocator = stable.locator;
  console.log(
    `root running sessionId=${rootLocator.sessionId} generation=${rootLocator.generation} instanceId=${rootLocator.instanceId}`,
  );
  // CLI-17 is A-owned; keep the stable root as SYS-07 evidence only.
  sys07Evidence.push(
    `root.sessionId=${rootLocator.sessionId}`,
    `root.generation=${rootLocator.generation}`,
    `root.requestId=${stable.requestId}`,
    `tool=${tool}`,
  );
  writeFileSync(
    join(artifacts, "queen-root-locator.json"),
    `${JSON.stringify({ requestId: stable.requestId, locator: rootLocator, tool }, null, 2)}\n`,
  );

  await waitFor("queen.cap after root launch", 30_000, async () => {
    const cap = Bun.file(join(home, "credentials", "queen.cap"));
    if (!(await cap.exists())) return null;
    const text = (await cap.text()).trim();
    return text.length > 0 ? text : null;
  });

  const observed = await waitFor(
    "non-empty root terminal output (positive control)",
    90_000,
    async () => {
      if (rootLocator === null) return null;
      try {
        const value = await observeRoot(rootLocator);
        if (value.capture.locator.sessionId !== rootLocator.sessionId) {
          throw new Error("terminal observation returned the wrong session");
        }
        if (value.capture.locator.generation !== rootLocator.generation) {
          throw new Error("terminal observation returned the wrong generation");
        }
        if (value.capture.truncated) {
          throw new Error("PRODUCT_RED terminal observation was truncated");
        }
        return value.capture.text?.trim() ? value : null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("No exact terminal generation")) return null;
        if (message.includes("authenticate") || message.includes("401"))
          return null;
        if (message.includes("scope was not granted")) {
          throw new Error(`PRODUCT_RED ${message}`);
        }
        throw error;
      }
    },
  );
  writeFileSync(
    join(artifacts, "queen-positive-control.json"),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
  console.log(
    `positive-control observation passed sha256=${observed.capture.sha256}`,
  );
  // MCP-03 is A-owned; observation is SYS-07 evidence (root-pane path).
  sys07Evidence.push(
    `observe.sha256=${observed.capture.sha256}`,
    `observe.generation=${rootLocator.generation}`,
  );

  await ownPid(supervisor?.pid);
  await waitFor("root provider pid in provider_runs", 30_000, async () => {
    if (rootLocator === null) return null;
    const pid = rootProviderPid(rootLocator.sessionId);
    if (pid === null) return null;
    await ownPid(pid);
    return pid;
  });
  console.log(
    `owned survivor identities (pid+cwd-inode): ${[...ownedIdentities].join(",") || "(none)"}`,
  );

  // session-start deliberately does not mark the root input-ready (logo paste
  // risk). turn-end is the existing readiness door; after observation proves
  // the pane has left the logo and shows a prompt, fire the same hook path.
  await postHookEvent(
    buildHookEvent("turn-end", { agent: "queen" }),
    port,
    agentFetch("queen"),
  );
  console.log("posted turn-end readiness door after positive-control observe");

  const sendBody = `QA queen-drive nonce=${nonce}. Read this inbox item, then print exactly: ${ackMarker}`;

  // sendOnce is block-scoped to the single initial send. The orphan-refuse
  // retry site below cannot name it — a mutation that calls sendOnce() there
  // fails direct tsc (cheapest possible red for a second message).
async function queenMailboxStatus(): Promise<{
  lanes: { control: { available: number; leased: number } };
}> {
  return callQueenTool(
    "hive_mail_status",
    { recipient: "queen" },
    "mail",
    z.object({
      lanes: z.object({
        control: z.object({ available: z.number(), leased: z.number() }),
      }),
    }),
  );
}

  let messageId: string;
  {
    const sendOnce = async (): Promise<string> => {
      const sent = await callQueenTool(
        "hive_mail_publish",
        {
          from: "queen",
          to: "queen",
          lane: "control",
          topic: "qa",
          body: sendBody,
          idempotencyKey: `qa-queen-self:${nonce}`,
        },
        "mail",
        SendSummarySchema,
      );
      return sent.itemId;
    };
    messageId = await sendOnce();
  }
  console.log(`sent self-message id=${messageId} nonce=${nonce}`);

  // The mailbox replaces the terminal-delivery machine this block used to be.
  // There is no write to wait for and no receipt to classify: publishing is
  // durable acceptance, and the milestone is the root settling what it took.
  const settledDeadline = Date.now() + 120_000;
  let mailbox = await queenMailboxStatus();
  if (mailbox.lanes.control.available + mailbox.lanes.control.leased === 0) {
    throw new Error("mailbox reader failed its positive control");
  }
  while (mailbox.lanes.control.available + mailbox.lanes.control.leased > 0) {
    if (Date.now() >= settledDeadline) {
      writeFileSync(
        join(artifacts, "queen-message-delivery.json"),
        `${JSON.stringify({ messageId, mailbox }, null, 2)}\n`,
      );
      throw new Error(
        `PRODUCT_RED root never settled its mail id=${messageId} ` +
          `control=${mailbox.lanes.control.available}/${mailbox.lanes.control.leased}`,
      );
    }
    await Bun.sleep(500);
    mailbox = await queenMailboxStatus();
  }
  writeFileSync(
    join(artifacts, "queen-message-delivery.json"),
    `${JSON.stringify({ messageId, mailbox }, null, 2)}\n`,
  );
  console.log(`root settled its mail id=${messageId}`);
  // MCP-12 is D-owned; publish/settle is SYS-07 evidence only.
  sys07Evidence.push(`messageId=${messageId}`, "settled");

  const ackObservation = await waitFor(
    `exact ACK marker in root visible text (${ackMarker})`,
    240_000,
    async () => {
      if (rootLocator === null) return null;
      const value = await observeRoot(rootLocator);
      if (value.capture.locator.generation !== rootLocator.generation) {
        throw new Error(
          `PRODUCT_RED observation generation drifted during ACK poll: got ${value.capture.locator.generation} want ${rootLocator.generation}`,
        );
      }
      if (value.capture.truncated) {
        throw new Error("PRODUCT_RED ACK observation was truncated");
      }
      const text = value.capture.text ?? "";
      return text.includes(ackMarker) ? value : null;
    },
  );
  writeFileSync(
    join(artifacts, "queen-ack-capture.json"),
    `${JSON.stringify(ackObservation, null, 2)}\n`,
  );
  writeFileSync(
    join(artifacts, "queen-ack-visible-text.txt"),
    ackObservation.capture.text ?? "",
  );
  console.log(
    `ACK observed sha256=${ackObservation.capture.sha256} marker=${ackMarker}`,
  );

  record("SYS-07", "working", [
    ...sys07Evidence,
    `nonce=${nonce}`,
    `ack.sha256=${ackObservation.capture.sha256}`,
  ]);
} catch (error) {
  failure = error;
  const message = error instanceof Error ? error.message : String(error);
  writeFileSync(join(artifacts, "queen-scenario.error.txt"), `${message}\n`);
  if (!rows.some((r) => r.id === "SYS-07")) {
    record("SYS-07", "broken", [...sys07Evidence, message.slice(0, 400)]);
  }
} finally {
  try {
    const outcome = await terminateRootAndSupervisor();
    console.log(
      outcome === "clean"
        ? "teardown clean: no owned pid+cwd-inode survivors; project restored"
        : "INFRASTRUCTURE_RED teardown found no root launch; survivor cleanliness is unmeasured",
    );
    if (outcome === "no-launch" && failure === null) {
      failure = new Error(
        "INFRASTRUCTURE_RED teardown found no root launch; survivor cleanliness is unmeasured",
      );
    }
  } catch (error) {
    failure =
      failure === null
        ? error
        : new AggregateError([failure, error], "scenario and teardown failed");
  }
}

if (failure !== null) {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (isProductFailure(failure)) throw failure;
  throw new Error(`INFRASTRUCTURE_RED ${message}`, { cause: failure });
}
console.log(`queen scenario passed nonce=${nonce} rows=${rows.length}`);
