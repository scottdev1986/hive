// Trigger protocol (HiveMemory HM-3 WP7, board #120, plan §3 item 3, article
// lesson A1): queen/operator trigger words execute memory recall/writes at
// the daemon and the labeled result replaces the delivered body; agent
// senders carry no trigger authority and their text is delivered verbatim.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMemoryFact,
  writeMemoryFact,
  type MemoryWriteFileResult,
} from "../adapters/memory";
import type { AgentRecord, MemoryWriteInput } from "../schemas";
import { HiveDatabase } from "./db";
import { MessageDelivery, type TmuxSender } from "./delivery";
import { EpisodicStore } from "./episodic-store";
import { MemoryIndex } from "./memory-index";
import {
  createMemoryTriggerExecutor,
  detectMemoryTrigger,
  memoryTriggerAuthority,
  type MemoryTriggerDeps,
} from "./memory-triggers";
import { submitPaste } from "./testing";

// Global-scope memory lives under HIVE_HOME, so the whole file runs against
// a disposable home (same posture as memory-delta.test.ts).
let tempRoot = "";
let previousHiveHome: string | undefined;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hive-memory-triggers-test-"));
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");
});

afterAll(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
  await rm(tempRoot, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  return await mkdtemp(join(tempRoot, "repo-"));
}

const timestamp = "2026-07-22T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "idle",
    taskDescription: "Build the trigger protocol",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-triggers",
    tmuxSession: "hive-maya",
    contextPct: 10,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

/** A working TUI: takes the paste, submits it, and the turn-start proves it. */
class SubmittingTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];

  constructor(private readonly db: HiveDatabase) {}

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
    submitPaste(this.db, session);
  }
}

interface TriggerHarness {
  repo: string;
  db: HiveDatabase;
  index: MemoryIndex;
  episodic: EpisodicStore;
  tmux: SubmittingTmuxSender;
  delivery: MessageDelivery;
  deps: MemoryTriggerDeps;
}

/** Delivery + trigger executor wired the way HiveDaemon wires them. */
async function makeHarness(): Promise<TriggerHarness> {
  const repo = await makeRepo();
  const db = new HiveDatabase(":memory:");
  const index = new MemoryIndex(new Database(":memory:"));
  const episodic = new EpisodicStore(":memory:");
  const write = async (input: MemoryWriteInput): Promise<MemoryWriteFileResult> => {
    const written = await writeMemoryFact(repo, input);
    for (const id of written.supersededIds) index.removeFact(input.scope, id);
    index.upsertFact(written);
    return written;
  };
  const deps: MemoryTriggerDeps = {
    repoRoot: () => repo,
    memory: index,
    write,
    episodic,
  };
  const tmux = new SubmittingTmuxSender(db);
  const delivery = new MessageDelivery(
    db,
    tmux,
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    () => false,
    undefined,
    undefined,
    createMemoryTriggerExecutor(deps),
  );
  db.insertAgent(agent());
  return { repo, db, index, episodic, tmux, delivery, deps };
}

async function seedArticle(
  harness: TriggerHarness,
  overrides: Partial<MemoryWriteInput> = {},
): Promise<MemoryWriteFileResult> {
  return await harness.deps.write({
    scope: "repo",
    topic: "delivery",
    title: "Urgent cancels the in-flight turn",
    body: "An urgent message cancels the current turn and it is never resumed.",
    source: "orchestrator",
    evidence: "Delivery contract",
    status: "verified",
    kind: "article",
    supersedes: [],
    verified: "2026-07-22",
    date: "2026-07-22",
    ...overrides,
  });
}

describe("detectMemoryTrigger", () => {
  test("each trigger phrase parses, case-insensitive, payload trimmed", () => {
    expect(detectMemoryTrigger("recall: delivery boundaries")).toEqual({
      kind: "recall",
      payload: "delivery boundaries",
    });
    expect(detectMemoryTrigger("NOTE THIS: the sky is blue")).toEqual({
      kind: "note",
      payload: "the sky is blue",
    });
    expect(detectMemoryTrigger("  Document This:  Delivery Contract ")).toEqual({
      kind: "document",
      payload: "Delivery Contract",
    });
  });

  test("the colon is required and the phrase must start the message", () => {
    expect(detectMemoryTrigger("recall delivery boundaries")).toBeNull();
    expect(detectMemoryTrigger("please recall: anything")).toBeNull();
    expect(detectMemoryTrigger("note this now: no colon after phrase")).toBeNull();
    expect(detectMemoryTrigger("a note this: not at the start")).toBeNull();
    expect(detectMemoryTrigger("recall:")).toBeNull();
    expect(detectMemoryTrigger("note this:   ")).toBeNull();
    expect(detectMemoryTrigger("an ordinary message")).toBeNull();
  });
});

describe("memoryTriggerAuthority", () => {
  test("queen (any alias) and operator may trigger; agents and system senders may not", () => {
    expect(memoryTriggerAuthority("queen")).toBe("queen");
    expect(memoryTriggerAuthority("orchestrator")).toBe("queen");
    expect(memoryTriggerAuthority("operator")).toBe("operator");
    expect(memoryTriggerAuthority("maya")).toBeNull();
    expect(memoryTriggerAuthority("hive-control")).toBeNull();
  });
});

describe("recall trigger", () => {
  test("hits deliver a labeled results block instead of the raw trigger text", async () => {
    const harness = await makeHarness();
    try {
      await seedArticle(harness);
      await seedArticle(harness, {
        id: "pitfall-paste",
        topic: "pitfalls",
        title: "Pitfall: paste without submit",
        body: "An urgent paste that is never submitted leaves the turn unstarted.",
        status: "unverified",
        kind: "pitfall",
        verified: undefined,
        evidence: "Harvested",
      });

      const message = await harness.delivery.send(
        "queen",
        "maya",
        "recall: urgent turn",
      );
      expect(message.deliveredAt === null).toBe(false);
      expect(harness.tmux.calls).toHaveLength(1);
      const text = harness.tmux.calls[0]![1];
      // The trigger is a command, not content: the raw text is gone.
      expect(text).not.toContain("recall: urgent turn");
      expect(text).toContain("🧠 Hive memory recall for 'urgent turn' — ");
      expect(text).toContain("system-injected by the Hive daemon");
      expect(text).toContain("Pitfalls matching this query:");
      expect(text).toContain("[pitfall]: Pitfall: paste without submit");
      // Hint-not-authority marking and verification labels.
      expect(text).toContain("not authority");
      expect(text).toContain("memory_read(scope, id)");
      expect(text).toContain("Urgent cancels the in-flight turn");
      // The episodic audit row carries the trigger provenance.
      const audit = harness.episodic.eventsFor({ agent: "maya" })
        .filter((event) => event.type === "memory-trigger");
      expect(audit).toHaveLength(1);
      const provenance = JSON.parse(audit[0]!.provenance) as Record<string, unknown>;
      expect(provenance).toMatchObject({
        sender: "queen",
        target: "maya",
        kind: "recall",
        outcome: "ok",
      });
    } finally {
      harness.db.close();
      harness.episodic.close();
    }
  });

  test("no hits deliver an honest empty block, distinct from a missing index", async () => {
    const harness = await makeHarness();
    try {
      await seedArticle(harness);
      const message = await harness.delivery.send(
        "operator",
        "maya",
        "recall: nonexistent zzzqxwv topic",
      );
      expect(message.deliveredAt === null).toBe(false);
      const text = harness.tmux.calls[0]![1];
      expect(text).toContain(
        "🧠 Hive memory recall for 'nonexistent zzzqxwv topic' — no matching memory",
      );
      expect(text).toContain("honest empty result");
      const audit = harness.episodic.eventsFor({ agent: "maya" });
      expect(JSON.parse(audit[0]!.provenance)).toMatchObject({
        sender: "operator",
        kind: "recall",
        outcome: "empty",
      });
    } finally {
      harness.db.close();
      harness.episodic.close();
    }
  });
});

describe("note this trigger", () => {
  test("writes an unverified repo observation and delivers a confirmation", async () => {
    const harness = await makeHarness();
    try {
      await harness.delivery.send(
        "queen",
        "maya",
        "note this: tmux exit 0 only means tmux accepted the keystrokes",
      );
      const text = harness.tmux.calls[0]![1];
      expect(text).toContain(
        '🧠 Hive noted: "tmux exit 0 only means tmux accepted the keystrokes" [unverified]',
      );
      // The raw trigger text is replaced, not relayed as the sender's words.
      expect(text).not.toContain("📨 message from queen");
      const written = harness.index.search("tmux keystrokes");
      expect(written).toHaveLength(1);
      const fact = await readMemoryFact(harness.repo, "repo", written[0]!.id);
      expect(fact).toMatchObject({
        topic: "notes",
        source: "orchestrator",
        status: "unverified",
      });
      const audit = harness.episodic.eventsFor({ agent: "maya" });
      expect(JSON.parse(audit[0]!.provenance)).toMatchObject({
        sender: "queen",
        target: "maya",
        kind: "note",
        action: "created",
      });
    } finally {
      harness.db.close();
      harness.episodic.close();
    }
  });

  test("operator notes carry source human", async () => {
    const harness = await makeHarness();
    try {
      await harness.delivery.send("operator", "maya", "note this: the floor is 16 GB");
      const written = harness.index.search("floor");
      const fact = await readMemoryFact(harness.repo, "repo", written[0]!.id);
      expect(fact!.source).toBe("human");
    } finally {
      harness.db.close();
      harness.episodic.close();
    }
  });

  test("the same fact twice becomes an update, not a duplicate, not an error", async () => {
    const harness = await makeHarness();
    try {
      await harness.delivery.send("queen", "maya", "note this: quota reads tighten");
      const first = harness.index.search("quota reads")[0]!;
      // Same normalized title, different punctuation/case and a refined body.
      await harness.delivery.send("queen", "maya", "Note this: Quota reads, tighten!");
      expect(harness.tmux.calls[1]![1]).toContain("updated existing article");
      const facts = harness.index.search("quota reads");
      expect(facts).toHaveLength(1);
      expect(facts[0]!.id).toBe(first.id);
      const fact = await readMemoryFact(harness.repo, "repo", first.id);
      expect(fact!.supersedes).toContain(first.id);
      const audit = harness.episodic.eventsFor({ agent: "maya" });
      expect(JSON.parse(audit[1]!.provenance)).toMatchObject({
        kind: "note",
        action: "updated",
        id: first.id,
      });
    } finally {
      harness.db.close();
      harness.episodic.close();
    }
  });
});

describe("document this trigger", () => {
  test("writes a topic-typed unverified scaffold and confirms", async () => {
    const harness = await makeHarness();
    try {
      await harness.delivery.send(
        "queen",
        "maya",
        "document this: Delivery Boundary Semantics",
      );
      const text = harness.tmux.calls[0]![1];
      expect(text).toContain(
        '🧠 Hive documented: "Delivery Boundary Semantics" [unverified]',
      );
      expect(text).toContain("wrote article [repo/delivery-boundary-semantics]");
      const written = harness.index.search("Delivery Boundary Semantics");
      expect(written).toHaveLength(1);
      const fact = await readMemoryFact(harness.repo, "repo", written[0]!.id);
      expect(fact).toMatchObject({
        topic: "delivery-boundary-semantics",
        source: "orchestrator",
        status: "unverified",
        kind: "article",
      });
      // The scaffold prompts verification instead of asserting authority.
      expect(fact!.body).toContain("## Verification");
      expect(fact!.body).toContain("UNVERIFIED");
    } finally {
      harness.db.close();
      harness.episodic.close();
    }
  });
});

describe("authority and failure isolation", () => {
  test("agent-sent trigger text is delivered verbatim; nothing executes", async () => {
    const harness = await makeHarness();
    try {
      const message = await harness.delivery.send(
        "sam",
        "maya",
        "note this: agents should not write this",
      );
      expect(message.deliveredAt === null).toBe(false);
      expect(harness.tmux.calls[0]![1]).toBe(
        "📨 message from sam: note this: agents should not write this",
      );
      // No wiki write, no audit row.
      expect(harness.index.search("agents should not write this")).toHaveLength(0);
      expect(
        harness.episodic.eventsFor({ agent: "maya" })
          .filter((event) => event.type === "memory-trigger"),
      ).toHaveLength(0);
    } finally {
      harness.db.close();
      harness.episodic.close();
    }
  });

  test("a failing trigger still delivers the original message, with a note", async () => {
    const harness = await makeHarness();
    try {
      harness.deps.write = () => Promise.reject(new Error("wiki disk on fire"));
      const message = await harness.delivery.send(
        "queen",
        "maya",
        "note this: this write will fail",
      );
      expect(message.deliveredAt === null).toBe(false);
      const text = harness.tmux.calls[0]![1];
      expect(text).toContain(
        "📨 message from queen: note this: this write will fail",
      );
      expect(text).toContain("⚠️ Hive memory trigger failed (wiki disk on fire)");
      expect(text).toContain("delivered unmodified");
    } finally {
      harness.db.close();
      harness.episodic.close();
    }
  });

  test("no executor wired: trigger text is plain message content (byte-identical)", async () => {
    const db = new HiveDatabase(":memory:");
    try {
      const tmux = new SubmittingTmuxSender(db);
      const delivery = new MessageDelivery(db, tmux);
      db.insertAgent(agent());
      await delivery.send("queen", "maya", "recall: anything");
      expect(tmux.calls[0]![1]).toBe("📨 message from queen: recall: anything");
    } finally {
      db.close();
    }
  });

  test("the wake delta still composes around an executed trigger", async () => {
    const harness = await makeHarness();
    try {
      const wakeDelta = {
        compose: async () => ({
          block: "🧠 Hive memory update since your last turn — 1 change",
          advanceTo: { repo: 1, global: 0 },
        }),
        advance: () => undefined,
      };
      const tmux = new SubmittingTmuxSender(harness.db);
      const delivery = new MessageDelivery(
        harness.db,
        tmux,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        () => false,
        undefined,
        wakeDelta,
        createMemoryTriggerExecutor(harness.deps),
      );
      await delivery.send("queen", "maya", "note this: delta rides along");
      const text = tmux.calls[0]![1];
      expect(text).toContain("🧠 Hive noted:");
      expect(text).toContain("🧠 Hive memory update since your last turn");
    } finally {
      harness.db.close();
      harness.episodic.close();
    }
  });
});
