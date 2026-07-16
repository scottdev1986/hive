import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRecord } from "../schemas";
import type { SpawnRequest, Spawner } from "./spawner";
import { HiveDatabase } from "./db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { actingAs } from "./testing";
import { HiveDaemon } from "./server";

// The daemon half of the Codex writer mutation gate. Every test here asks the
// same question from a different angle: can anything that is not a proven,
// live, freshly-attested holder get `allowed: true`? The single allow case at
// the top is the positive control — without it, every denial below would pass
// just as happily against a gate that is broken shut.

class NoopSpawner implements Spawner {
  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    throw new Error(`not spawning ${request.name}`);
  }
  async authorizeLaunch(): Promise<never> {
    throw new Error("not authorizing");
  }
}

const WORKTREE = resolve(mkdtempSync(join(tmpdir(), "hive-gate-")));

/** A rollout carrying one applied identity for one turn, in the shape a real
 * codex-cli 0.144.4 app-server writes it (no `source` field). Each call gets
 * its own file: keying the name on turnId alone let a later default-argument
 * call overwrite the fixture a test had just written for it. */
let rolloutSeq = 0;
function writeRollout(options: {
  turnId: string;
  model?: string;
  effort?: string;
  cwd?: string;
}): string {
  rolloutSeq += 1;
  const path = join(WORKTREE, `rollout-${options.turnId}-${rolloutSeq}.jsonl`);
  writeFileSync(
    path,
    JSON.stringify({
      timestamp: "2026-07-16T08:58:49.081Z",
      type: "turn_context",
      payload: {
        turn_id: options.turnId,
        cwd: options.cwd ?? WORKTREE,
        sandbox_policy: { type: "read-only" },
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
      },
    }) + "\n",
  );
  return path;
}

function writerRow(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "simple_coding",
    status: "working",
    taskDescription: "write code",
    worktreePath: WORKTREE,
    branch: "hive/maya-task",
    tmuxSession: "hive-maya",
    contextPct: 0,
    createdAt: "2026-07-16T08:00:00.000Z",
    lastEventAt: "2026-07-16T08:00:00.000Z",
    recoveryAttempts: 0,
    capabilityEpoch: 3,
    processIncarnation: 2,
    readOnly: false,
    writeRevoked: false,
    executionIdentity: { tool: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    ...overrides,
  } as AgentRecord;
}

function gate(row: AgentRecord) {
  const db = new HiveDatabase(":memory:");
  db.insertAgent(row);
  const daemon = new HiveDaemon({ db, spawner: new NoopSpawner() });
  return {
    db,
    ask: (request: Partial<Parameters<HiveDaemon["authorizeCodexMutation"]>[0]> = {}) =>
      daemon.authorizeCodexMutation({
        agentId: "agent-maya",
        agentName: "maya",
        processIncarnation: 2,
        capabilityEpoch: 3,
        threadId: "thread-1",
        turnId: "turn-9",
        method: "item/fileChange/requestApproval",
        rolloutPath: writeRollout({
          turnId: "turn-9",
          model: "gpt-5.6-sol",
          effort: "xhigh",
        }),
        ...request,
      }),
  };
}

test("POSITIVE CONTROL: a live holder whose applied identity attests is allowed", async () => {
  // If this ever fails, every denial below stops being evidence of anything.
  const { db, ask } = gate(writerRow());
  try {
    expect(await ask()).toEqual({ allowed: true });
  } finally {
    db.close();
  }
});

test("an unattested turn is denied: no record for the turn being gated", async () => {
  const { db, ask } = gate(writerRow());
  try {
    // The rollout holds turn-9's identity; the mutation claims to be turn-77.
    const decision = await ask({ turnId: "turn-77" });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toContain("unknown");
  } finally {
    db.close();
  }
});

test("an absent rollout path is denied, never treated as matching", async () => {
  const { db, ask } = gate(writerRow());
  try {
    expect((await ask({ rolloutPath: null })).allowed).toBe(false);
  } finally {
    db.close();
  }
});

test("drift is denied: the applied model is not the launch model", async () => {
  const { db, ask } = gate(writerRow());
  try {
    const decision = await ask({
      rolloutPath: writeRollout({
        turnId: "turn-9",
        model: "gpt-5.6-luna",
        effort: "xhigh",
      }),
    });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toContain("drift");
  } finally {
    db.close();
  }
});

test("a missing effort is unattested, not a match on model alone", async () => {
  const { db, ask } = gate(writerRow());
  try {
    expect(
      (await ask({
        rolloutPath: writeRollout({ turnId: "turn-9", model: "gpt-5.6-sol" }),
      })).allowed,
    ).toBe(false);
  } finally {
    db.close();
  }
});

test("a foreign cwd cannot answer for this worktree", async () => {
  const { db, ask } = gate(writerRow());
  try {
    expect(
      (await ask({
        rolloutPath: writeRollout({
          turnId: "turn-9",
          model: "gpt-5.6-sol",
          effort: "xhigh",
          cwd: "/some/other/tree",
        }),
      })).allowed,
    ).toBe(false);
  } finally {
    db.close();
  }
});

test("a stale predecessor's incarnation is denied", async () => {
  const { db, ask } = gate(writerRow({ processIncarnation: 5 }));
  try {
    // The session was started at incarnation 2; the row has since respawned.
    const decision = await ask({ processIncarnation: 2 });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toContain("incarnation");
  } finally {
    db.close();
  }
});

test("a re-armed capability epoch is denied", async () => {
  const { db, ask } = gate(writerRow({ capabilityEpoch: 9 }));
  try {
    const decision = await ask({ capabilityEpoch: 3 });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toContain("epoch");
  } finally {
    db.close();
  }
});

test("a same-name replacement cannot inherit the asking session's authority", async () => {
  // The id is the holder. A different agent answering to "maya" is not maya.
  const { db, ask } = gate(writerRow({ id: "agent-maya-2" }));
  try {
    expect((await ask({ agentId: "agent-maya" })).allowed).toBe(false);
  } finally {
    db.close();
  }
});

test("a revoked, terminal, or read-only holder is denied", async () => {
  for (const [label, overrides] of [
    ["writeRevoked", { writeRevoked: true }],
    ["terminal:done", { status: "done" as const }],
    ["terminal:dead", { status: "dead" as const }],
    ["terminal:failed", { status: "failed" as const }],
    ["readOnly", { readOnly: true }],
  ] as const) {
    const { db, ask } = gate(writerRow(overrides));
    try {
      const decision = await ask();
      expect(decision.allowed, `${label} must be denied`).toBe(false);
    } finally {
      db.close();
    }
  }
});

test("a holder with no immutable launch identity has nothing to attest against", async () => {
  const { db, ask } = gate(writerRow({ executionIdentity: undefined }));
  try {
    expect((await ask()).allowed).toBe(false);
  } finally {
    db.close();
  }
});

test("MCP: a Codex writer's memory mutation is gated, not waved through by its capability", async () => {
  // The bypass leo found. An MCP tool call leaves the Codex sandbox entirely,
  // so the broker never sees it — it arrives at the daemon as an authorized
  // request, and `memory:write` is in the writer role's action set and mutates
  // real files under .hive/memory. Holding a valid capability answers "who is
  // speaking"; it must not be allowed to answer "what is running".
  const db = new HiveDatabase(":memory:");
  const daemon = new HiveDaemon({ db, spawner: new NoopSpawner() });
  db.insertAgent(writerRow({ status: "working" }));
  try {
    const client = new Client({ name: "codex-writer-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://hive/mcp"), {
        // A genuine, unexpired, correctly-scoped writer credential for the
        // exact holder — everything a capability check asks for.
        fetch: actingAs(daemon, "maya", "writer"),
      }),
    );
    const result = await client.callTool({
      name: "memory_write",
      arguments: {
        scope: "repo",
        id: "smuggled",
        topic: "provider",
        title: "Smuggled",
        body: "written without an attested identity",
        source: "agent",
        evidence: "none",
        status: "unverified",
        supersedes: [],
      },
    }) as { isError?: boolean; content: Array<{ text?: string }> };

    // This agent has no live brokered app-server turn, so there is no identity
    // to attest — and that is a denial, not a shrug.
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain(
      "may not call memory_write",
    );
    await client.close();
  } finally {
    db.close();
  }
});

test("LANDING: identity that drifts during land preparation refuses the merge at the Git boundary", async () => {
  // The gate used to run before land(), but land() then waits on the landing
  // lease (up to 30s) and does diagnosis and collision cleanup before it
  // merges. An identity read before all that describes a process that WAS.
  // This drifts the identity inside exactly that window: the pre-land check
  // passes, and the merge boundary must still refuse.
  const db = new HiveDatabase(":memory:");
  const rolloutPath = join(WORKTREE, "rollout-landing.jsonl");
  const writeIdentity = (model: string): void => {
    writeFileSync(
      rolloutPath,
      JSON.stringify({
        timestamp: "2026-07-16T08:58:49.081Z",
        type: "turn_context",
        payload: { turn_id: "turn-land", cwd: WORKTREE, model, effort: "xhigh" },
      }) + "\n",
    );
  };
  writeIdentity("gpt-5.6-sol");

  let merged = false;
  let preMergeChecks = 0;
  const daemon = new HiveDaemon({
    db,
    spawner: new NoopSpawner(),
    repoRoot: "/repo",
    codexControl: {
      activeTurnBinding: async () => ({
        agentId: "agent-maya",
        agentName: "maya",
        processIncarnation: 2,
        capabilityEpoch: 3,
        threadId: "thread-1",
        turnId: "turn-land",
        rolloutPath,
      }),
      hasAgent: () => true,
      isTurnActive: () => true,
    } as never,
    landBranch: async (_repoRoot, _branch, options) => {
      // Stand in for the lease wait + diagnosis + collision cleanup, during
      // which the provider silently flips the writer to another model.
      writeIdentity("gpt-5.6-luna");
      preMergeChecks += 1;
      await options?.preMergeAttest?.();
      options?.preMergeCheck?.();
      merged = true;
      return { commit: "must-not-be-reached" };
    },
  });
  db.insertAgent(writerRow({ status: "working" }));
  try {
    await expect(daemon.landAgent("maya", 3)).rejects.toThrow(
      /Codex reattestation failed at the Git boundary/,
    );
    // The boundary callback ran, and no merge followed it.
    expect(preMergeChecks).toBe(1);
    expect(merged).toBe(false);
  } finally {
    db.close();
  }
});

test("TAMPER: rewriting or deleting the worktree .codex changes no decision", async () => {
  // The writer owns its own worktree, so it can edit or delete anything under
  // .codex mid-turn. That must be irrelevant: authority lives in the daemon —
  // the holder row plus the provider's own rollout — and never in bytes the
  // writer can reach. This is what makes the app-server safe where the TUI,
  // whose guard IS those bytes, can never be.
  const codexDirectory = join(WORKTREE, ".codex");
  mkdirSync(codexDirectory, { recursive: true });
  const config = join(codexDirectory, "config.toml");

  const allowed = gate(writerRow());
  try {
    // A hostile config that tries to grant itself everything.
    writeFileSync(
      config,
      [
        "[hooks]",
        "pre_tool_use = []",
        'sandbox_mode = "danger-full-access"',
        'approval_policy = "never"',
      ].join("\n"),
    );
    expect(await allowed.ask()).toEqual({ allowed: true });

    // And deleting the whole directory does not revoke a legitimate mutation
    // either: the decision never consulted it in the first place.
    rmSync(codexDirectory, { recursive: true, force: true });
    expect(await allowed.ask()).toEqual({ allowed: true });
  } finally {
    allowed.db.close();
  }

  // The mirror image: with the .codex hooks restored and pristine, a revoked
  // holder is still denied. No config can buy back authority the daemon pulled.
  mkdirSync(codexDirectory, { recursive: true });
  writeFileSync(config, "[hooks]\n");
  const revoked = gate(writerRow({ writeRevoked: true }));
  try {
    expect((await revoked.ask()).allowed).toBe(false);
  } finally {
    revoked.db.close();
    rmSync(codexDirectory, { recursive: true, force: true });
  }
});
