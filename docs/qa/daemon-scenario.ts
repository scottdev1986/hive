// Exercises the 53 non-UI deterministic D rows; UI rows belong to tour/judgment legs.
// It never opens the rig database or asks a provider to start.

import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  agentMcpCall,
  listUserMcpTools,
  userMcpCall,
  requiredQaCoordinates,
  writeRowRecord,
  type QaRowRecord,
} from "./qa-client";
import { requireMutationReadback } from "./daemon-scenario-core";

const expectedTools = [
  "graph_locate",
  "hive_approvals",
  "hive_approve",
  "hive_escalate",
  "hive_kill",
  "hive_land",
  "hive_mail_claim",
  "hive_mail_complete",
  "hive_mail_poll",
  "hive_mail_publish",
  "hive_mail_status",
  "hive_mark_dead",
  "hive_models",
  "hive_pickup_handoff",
  "hive_preserve_branch",
  "hive_quota_status",
  "hive_run_checkpoint_get",
  "hive_salvage",
  "hive_settlement_decide",
  "hive_settlement_execute",
  "hive_settlement_list",
  "hive_spawn",
  "hive_spawn_many",
  "hive_status",
  "hive_task_list",
  "hive_terminal_observe",
  "hive_token_usage",
  "memory_delete",
  "memory_read",
  "memory_reindex",
  "memory_search",
  "memory_verify",
  "memory_write",
] as const;

const coordinates = requiredQaCoordinates();
const sourceSha = git("-C", coordinates.sourceRoot, "rev-parse", "HEAD");
const home = realpathSync(coordinates.home);
const artifacts = realpathSync(coordinates.artifacts);
if (!home.startsWith("/private/tmp/hvqa-") && !home.startsWith("/tmp/hvqa-")) {
  throw new Error(`QA home is not an isolated rig: ${home}`);
}
if (!artifacts.startsWith(`${home}/`)) {
  throw new Error(`artifact directory is outside QA home: ${artifacts}`);
}
process.env.HIVE_HOME = home;

const recordsPath = join(artifacts, "daemon-scenario.jsonl");
const needsPath = join(artifacts, "daemon-scenario-needs-fixture.json");
writeFileSync(recordsPath, "");

const evidence = ["daemon-scenario.jsonl"];
const records: QaRowRecord[] = [];

// Matrix determinism for D-owned rows.
const BOUNDED_IDS = new Set([
  "MCP-06",
  "MCP-07",
  "MCP-12",
  "MCP-14",
  "MCP-15",
  "CLI-06",
  "CLI-09",
  "SYS-08",
]);

function determinismFor(id: string): QaRowRecord["determinism"] {
  return BOUNDED_IDS.has(id) ? "bounded" : "yes";
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", process.cwd(), ...args]);
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function record(
  id: string,
  verdict: QaRowRecord["verdict"],
  fixtureNeed?: QaRowRecord["fixtureNeed"],
): void {
  const row: QaRowRecord = {
    id,
    mode: "fixture",
    verdict,
    determinism: determinismFor(id),
    bugs: { present: [], absent: [] },
    evidence,
    sourceSha,
    ...(fixtureNeed === undefined ? {} : { fixtureNeed }),
  };
  records.push(row);
  writeRowRecord(recordsPath, row);
}

async function productRow(
  id: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
    record(id, "working");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeFileSync(join(artifacts, `${id}.error.txt`), `${detail}\n`);
    record(id, "broken");
  }
}

async function mutationRow(
  id: string,
  mutate: () => Promise<void>,
  readback: () => Promise<void>,
): Promise<void> {
  await productRow(id, () => requireMutationReadback(mutate, readback));
}

async function expectToolFailure(
  name: string,
  args: Record<string, unknown>,
  key: string,
): Promise<void> {
  try {
    await userMcpCall(coordinates.port, name, args, key, z.unknown());
  } catch {
    return;
  }
  throw new Error(`${name} unexpectedly succeeded`);
}

function needsFixture(
  id: string,
  state: string,
  reason: string,
  attempted = false,
  productDoor: "unavailable" | "partial" = "unavailable",
): void {
  record(id, "NEEDS-FIXTURE", { state, reason, attempted, productDoor });
}

async function partialFixture(
  id: string,
  state: string,
  reason: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeFileSync(join(artifacts, `${id}.partial.txt`), `${detail}\n`);
  }
  needsFixture(id, state, reason, true, "partial");
}

async function mcpProbe(id: string): Promise<void> {
  const tool = {
    "MCP-01": "hive_status",
    "MCP-02": "hive_update_status",
    "MCP-04": "hive_preserve_branch",
    "MCP-08": "hive_quota_status",
    "MCP-09": "hive_models",
    "MCP-10": "hive_mark_dead",
    "MCP-13": "hive_escalate",
    "MCP-16": "hive_pickup_handoff",
    "MCP-18": "hive_contract_create",
    "MCP-19": "hive_channel_create",
    "MCP-20": "hive_channel_send",
    "MCP-21": "hive_node_create",
    "MCP-23": "hive_spawn_many",
    "MCP-25": "hive_approve",
    "MCP-26": "hive_land",
    "MCP-32": "memory_search",
    "MCP-40": "hive_succession_attest",
  }[id];
  if (tool === undefined) throw new Error(`no product probe for ${id}`);
  if (id === "MCP-01") {
    await userMcpCall(
      coordinates.port,
      tool,
      { detail: "full" },
      "agents",
      z.array(z.unknown()),
    );
    return;
  }
  if (id === "MCP-08") {
    await userMcpCall(coordinates.port, tool, {}, "quotas", z.unknown());
    return;
  }
  if (id === "MCP-09") {
    await userMcpCall(coordinates.port, tool, {}, "inventory", z.unknown());
    return;
  }
  if (id === "MCP-32") {
    await userMcpCall(
      coordinates.port,
      tool,
      { query: "fleet" },
      "results",
      z.array(z.unknown()),
    );
    return;
  }
  const args = id === "MCP-23" ? { requests: [] } : {};
  await userMcpCall(coordinates.port, tool, args, "result", z.unknown());
}

async function cliProbe(id: string): Promise<void> {
  const args =
    id === "CLI-01"
      ? ["instances"]
      : id === "CLI-07"
        ? ["routing"]
        : id === "CLI-10"
          ? ["quota"]
          : id === "CLI-11"
            ? ["graphify", "status"]
            : ["no-such-command"];
  const source = process.env.HIVE_QA_SRC_ROOT;
  if (!source) throw new Error("HIVE_QA_SRC_ROOT is required for CLI probes");
  const child = Bun.spawnSync(["bun", "src/cli.ts", ...args], {
    cwd: source,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output =
    `${new TextDecoder().decode(child.stdout)}${new TextDecoder().decode(child.stderr)}`.trim();
  writeFileSync(join(artifacts, `${id}.partial.txt`), `${output}\n`);
  if (output.length === 0) throw new Error(`${id} produced no CLI observation`);
}

const tools = await listUserMcpTools(coordinates.port);
if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
  throw new Error(`MCP enumeration changed: ${tools.join(",")}`);
}
writeFileSync(
  join(artifacts, "daemon-scenario-tools.json"),
  `${JSON.stringify(tools, null, 2)}\n`,
);

await partialFixture(
  "MCP-05",
  "seeded quota pool",
  "Read-only product call works, but the exact pool/reservation/reset fixture is absent.",
  async () => {
    await userMcpCall(
      coordinates.port,
      "hive_quota_status",
      {},
      "quotas",
      z.array(z.unknown()),
    );
  },
);
await partialFixture(
  "MCP-06",
  "seeded token attribution",
  "Read-only product call works, but no root/worker totals exist without provider sessions.",
  async () => {
    await userMcpCall(
      coordinates.port,
      "hive_token_usage",
      {},
      "tokenUsage",
      z.unknown(),
    );
  },
);
await partialFixture(
  "MCP-07",
  "fixture catalog",
  "Live discovery is callable, but an exact fixture catalog is not seeded.",
  async () => {
    await userMcpCall(
      coordinates.port,
      "hive_models",
      {},
      "inventory",
      z.unknown(),
    );
  },
);
await partialFixture(
  "MCP-24",
  "pending approval",
  "The empty queue is observable, but the required positive pending approval needs a provider or injected fixture.",
  async () => {
    const approvals = await userMcpCall(
      coordinates.port,
      "hive_approvals",
      {},
      "approvals",
      z.array(z.unknown()),
    );
    if (approvals.length !== 0)
      throw new Error("private rig did not start with an empty approval queue");
  },
);

let queenMessageId = "";
await productRow("MCP-12", async () => {
  const receipt = await agentMcpCall(
    coordinates.port,
    "queen",
    "hive_mail_publish",
    {
      from: "queen",
      to: "queen",
      lane: "control",
      topic: "qa",
      body: `QA daemon message ${Date.now()}`,
      idempotencyKey: `qa-daemon-${Date.now()}`,
    },
    "mail",
    z.object({ itemId: z.string() }),
  );
  queenMessageId = receipt.itemId;
});
await productRow("MCP-15", async () => {
  const polled = await agentMcpCall(
    coordinates.port,
    "queen",
    "hive_mail_poll",
    { recipient: "queen" },
    "mail",
    z.object({ control: z.object({ itemId: z.string() }).nullable() }),
  );
  if (polled.control?.itemId !== queenMessageId)
    throw new Error("published message is absent from the queen mailbox");
});
await productRow("MCP-17", async () => {
  await agentMcpCall(
    coordinates.port,
    "queen",
    "hive_mail_claim",
    { recipient: "queen", itemId: queenMessageId, handlerId: "qa-daemon" },
    "mail",
    z.object({ itemId: z.string() }),
  );
});
await mutationRow(
  "MCP-14",
  async () => {
    await agentMcpCall(
      coordinates.port,
      "queen",
      "hive_mail_complete",
      {
        recipient: "queen",
        itemId: queenMessageId,
        handlerId: "qa-daemon",
        disposition: "completed",
      },
      "mail",
      z.unknown(),
    );
  },
  async () => {
    const polled = await agentMcpCall(
      coordinates.port,
      "queen",
      "hive_mail_poll",
      { recipient: "queen" },
      "mail",
      z.object({ control: z.object({ itemId: z.string() }).nullable() }),
    );
    if (polled.control?.itemId === queenMessageId)
      throw new Error("settled message is still offered by the mailbox");
  },
);

const marker = `qa-daemon-${Date.now()}`;
const articleId = `${marker}-article`;
const reindexId = `${marker}-reindex`;
const pitfallId = `${marker}-pitfall`;
const write = (id: string, kind: "article" | "pitfall") =>
  userMcpCall(
    coordinates.port,
    "memory_write",
    {
      scope: "repo",
      id,
      topic: "qa-daemon-scenario",
      title: `${kind} ${marker}`,
      body: `Deterministic ${kind} fixture written through the product memory tool.`,
      evidence: "qa/daemon-scenario.ts",
      source: "agent",
      status: "verified",
      verified: new Date().toISOString().slice(0, 10),
      kind,
      supersedes: [],
    },
    "fact",
    z.unknown(),
  );

await productRow("MCP-27", async () => {
  await write(articleId, "article");
  const hits = await userMcpCall(
    coordinates.port,
    "memory_search",
    { query: marker, scope: "repo" },
    "results",
    z.array(z.unknown()),
  );
  if (hits.length === 0)
    throw new Error("memory search did not read back the seeded article");
  const absent = await userMcpCall(
    coordinates.port,
    "memory_search",
    { query: `absent-${marker}`, scope: "repo" },
    "results",
    z.array(z.unknown()),
  );
  if (absent.length !== 0)
    throw new Error("absent memory query unexpectedly matched");
});
await productRow("MCP-28", async () => {
  await userMcpCall(
    coordinates.port,
    "memory_read",
    { scope: "repo", id: articleId },
    "fact",
    z.unknown(),
  );
  await expectToolFailure(
    "memory_write",
    {
      scope: "repo",
      id: `${articleId}-duplicate`,
      topic: "qa-daemon-scenario",
      title: `article ${marker}`,
      body: "duplicate title",
      evidence: "qa/daemon-scenario.ts",
      source: "agent",
      status: "verified",
      verified: new Date().toISOString().slice(0, 10),
      supersedes: [],
    },
    "fact",
  );
});
await productRow("MCP-29", async () => {
  await userMcpCall(
    coordinates.port,
    "memory_read",
    { scope: "repo", id: articleId },
    "fact",
    z.unknown(),
  );
  await expectToolFailure(
    "memory_read",
    { scope: "repo", id: `missing-${marker}` },
    "fact",
  );
});
await mutationRow(
  "MCP-30",
  async () => {
    await userMcpCall(
      coordinates.port,
      "memory_delete",
      { scope: "repo", id: articleId },
      "result",
      z.object({ deleted: z.literal(true) }),
    );
  },
  async () => {
    await expectToolFailure(
      "memory_read",
      { scope: "repo", id: articleId },
      "fact",
    );
    const hits = await userMcpCall(
      coordinates.port,
      "memory_search",
      { query: marker, scope: "repo" },
      "results",
      z.array(z.unknown()),
    );
    if (hits.length !== 0)
      throw new Error("deleted article remained searchable");
  },
);
await productRow("MCP-31", async () => {
  await write(reindexId, "article");
  const before = await userMcpCall(
    coordinates.port,
    "memory_search",
    { query: reindexId, scope: "repo" },
    "results",
    z.array(z.unknown()),
  );
  if (before.length === 0)
    throw new Error("reindex positive control is absent before rebuild");
  await userMcpCall(
    coordinates.port,
    "memory_reindex",
    {},
    "result",
    z.unknown(),
  );
  const after = await userMcpCall(
    coordinates.port,
    "memory_search",
    { query: reindexId, scope: "repo" },
    "results",
    z.array(z.unknown()),
  );
  if (after.length === 0) throw new Error("reindex lost the seeded article");
});
await productRow("MCP-34", async () => {
  await write(pitfallId, "pitfall");
  const pitfalls = await userMcpCall(
    coordinates.port,
    "memory_search",
    { query: marker, scope: "repo", kind: "pitfall" },
    "results",
    z.array(z.unknown()),
  );
  if (pitfalls.length === 0)
    throw new Error("pitfall search did not read back the seeded pitfall");
  await userMcpCall(
    coordinates.port,
    "memory_read",
    { scope: "repo", id: pitfallId },
    "fact",
    z.unknown(),
  );
});
await productRow("MCP-36", async () => {
  const recall = await userMcpCall(
    coordinates.port,
    "memory_search",
    { query: marker },
    "results",
    z.array(z.object({ kind: z.string().optional() })),
  );
  if (recall.length === 0)
    throw new Error("memory search did not read back the seeded articles");
});
await productRow("MCP-38", async () => {
  const result = await userMcpCall(
    coordinates.port,
    "graph_locate",
    { question: "where is the hello API endpoint" },
    "locate",
    z.object({ available: z.boolean(), answer: z.string() }),
  );
  if (!result.available || !result.answer.includes("backend/main.py"))
    throw new Error("known graph symbol lacks a source citation");
  const noLead = await userMcpCall(
    coordinates.port,
    "graph_locate",
    { question: `nonsense-${marker}` },
    "locate",
    z.object({ answer: z.string() }),
  );
  if (!/no strong lead|no lead/i.test(noLead.answer))
    throw new Error(
      "nonsense graph query did not report an honest no-lead result",
    );
});
await partialFixture(
  "MCP-39",
  "checkpoint read-back projection",
  "A queen capability can create the headless checkpoint without spend, but the product has no independent checkpoint projection to read back.",
  async () => {
    await agentMcpCall(
      coordinates.port,
      "queen",
      "hive_run_checkpoint",
      {
        reason: "unknown-context",
        contextUsage: {
          kind: "unknown",
          reason: "QA headless owner has no root context measurement",
        },
        decision: {
          decision: "replace",
          reason: "QA deterministic checkpoint probe",
        },
        written: {
          goal: "Exercise checkpoint product door",
          done: [],
          failures: [],
          uncertainty: [],
          nextAction: "Read back checkpoint",
          rollback: "Private rig teardown",
        },
        unresolvedQuestions: [],
        model: null,
      },
      "checkpoint",
      z.unknown(),
    );
  },
);

for (const [id, state, reason] of [
  [
    "MCP-01",
    "admitted live agent/root",
    "requires a no-spend synthetic agent/root binding",
  ],
  [
    "MCP-02",
    "assignment-bound writer capability",
    "user cannot create an assignment-bound status subject",
  ],
  [
    "MCP-04",
    "closed and live branch records",
    "requires an agent lifecycle without provider spawn",
  ],
  ["MCP-08", "configured quota pool", "private rig has no seeded quota pool"],
  [
    "MCP-09",
    "crashed session",
    "creating one requires provider session control",
  ],
  [
    "MCP-10",
    "stopped exact provider run",
    "creating one requires provider session control",
  ],
  [
    "MCP-13",
    "committed writer agent",
    "escalation requires a spawned writer branch",
  ],
  [
    "MCP-16",
    "replacement handoff",
    "pickup requires a replacement agent lifecycle",
  ],
  [
    "MCP-18",
    "two live hierarchy bindings",
    "contracts require live agent bindings",
  ],
  [
    "MCP-19",
    "hierarchy channel owner binding",
    "channels require a live agent binding",
  ],
  [
    "MCP-20",
    "channel endpoints",
    "delivery requires two live hierarchy bindings",
  ],
  [
    "MCP-21",
    "run-root hierarchy binding",
    "node creation requires a live agent binding",
  ],
  ["MCP-23", "injected spawn batch", "success case would launch providers"],
  [
    "MCP-25",
    "pending approval",
    "positive approval requires a provider or injected fixture",
  ],
  [
    "MCP-26",
    "reviewed target-repo branch",
    "fast-forward test needs a disposable Git target fixture",
  ],
  [
    "MCP-32",
    "seeded episodic projection rows",
    "Callable typed envelope is observed; seeded projection content needs a fixture.",
  ],
  [
    "MCP-40",
    "successor generation",
    "requires a synthetic successor lifecycle",
  ],
] as const)
  await partialFixture(id, state, reason, () => mcpProbe(id));

for (const [id, state, reason] of [
  [
    "CLI-01",
    "interactive Workspace process",
    "must be tested by the suite/UI leg",
  ],
  [
    "CLI-02",
    "disposable init target",
    "requires disposable installation fixture",
  ],
  [
    "CLI-06",
    "admitted agent",
    "positive status agreement requires an agent lifecycle",
  ],
  [
    "CLI-07",
    "seeded routing policy",
    "private rig has no canonical route fixture",
  ],
  [
    "CLI-08",
    "CAS routing candidates",
    "provider/routing fixture is intentionally separate",
  ],
  ["CLI-09", "agent session", "kill/attach require an admitted agent"],
  ["CLI-10", "configured quota pool", "private rig has no quota seed"],
  [
    "CLI-11",
    "disposable graphify runtime",
    "runtime install must not modify the host",
  ],
  [
    "CLI-12",
    "disposable embeddings runtime",
    "runtime install must not modify the host",
  ],
  [
    "CLI-13",
    "strict memory CLI fixture",
    "daemon-memory coverage does not prove CLI composition",
  ],
  [
    "CLI-14",
    "unlanded work/process fixture",
    "stop-force requires disposable runtime fixture",
  ],
  ["CLI-15", "event/statusline fixture", "needs CLI event projection fixture"],
  [
    "CLI-16",
    "recovery/runtime fixture",
    "requires wrong-instance and recovery fixtures",
  ],
  [
    "SYS-02",
    "HTTP endpoint matrix",
    "requires endpoint-specific seeded product state",
  ],
  [
    "SYS-03",
    "dense routing candidates",
    "belongs to the dedicated dense routing seeder",
  ],
  [
    "SYS-04",
    "enabled provider",
    "provider-affecting row is excluded from no-spend D",
  ],
  [
    "SYS-05",
    "rejected-after-commit injection",
    "requires the dedicated mutation-fault fixture",
  ],
  [
    "SYS-08",
    "cross-vendor review bindings",
    "requires author/reviewer lifecycle fixtures",
  ],
  [
    "SYS-09",
    "reviewed target-repo branch",
    "requires disposable landing fixture",
  ],
] as const)
  await partialFixture(id, state, reason, () => cliProbe(id));

writeFileSync(
  needsPath,
  `${JSON.stringify(
    records.filter((row) => row.verdict === "NEEDS-FIXTURE"),
    null,
    2,
  )}\n`,
);
console.log(
  `daemon scenario wrote ${records.length} records to ${recordsPath}`,
);
