import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRecord, SpawnRequest, Spawner } from "../schemas";
import { HiveDatabase } from "./db";
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
