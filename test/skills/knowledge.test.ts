import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { QUEEN_POLICY } from "../../src/cli/queen-policy";
import { ROLE_GRANTS } from "../../src/daemon/authorization/authorization-service";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import type { HiveToolRegistrar } from "../../src/daemon/authorization/mcp-tool-policy";
import {
  QUEEN_KNOWLEDGE,
  QUEEN_KNOWLEDGE_INDEX,
  queenKnowledgeIndex,
  resolveQueenKnowledge,
} from "../../src/skills/knowledge";
import {
  type KnowledgeResult,
  registerKnowledgeTool,
} from "../../src/skills/knowledge-tool";
import { SHIPPED_SKILLS } from "../../src/skills/shipped";
import { realCaller } from "../daemon/hierarchy-tool-fixture";

type KnowledgeInput = { topic?: string };
type KnowledgeHandler = (
  input: KnowledgeInput,
) => Promise<{ structuredContent: { knowledge: KnowledgeResult } }>;

/** Captures the handler registerKnowledgeTool installs, the same shape every tool suite uses. */
function captureKnowledgeHandler(
  capability: Parameters<typeof registerKnowledgeTool>[1],
  authorizeTool: Parameters<typeof registerKnowledgeTool>[2]["authorizeTool"],
): KnowledgeHandler {
  let captured: KnowledgeHandler | null = null;
  const server = {
    registerTool: (
      _name: string,
      _config: unknown,
      handler: KnowledgeHandler,
    ) => {
      captured = handler;
    },
  } as unknown as HiveToolRegistrar;
  registerKnowledgeTool(server, capability, { authorizeTool });
  if (captured === null) throw new Error("hive_knowledge was not registered");
  return captured;
}

/** A queen caller on the real authorization path, plus a writer for the refusal half. */
function callers() {
  const db = new HiveDatabase(":memory:");
  return {
    queen: realCaller(db, "queen", "orchestrator"),
    writer: realCaller(db, "writer-1", "writer"),
  };
}

describe("queen-knowledge registry", () => {
  test("every entry resolves to a shipped skill with real content", () => {
    for (const entry of QUEEN_KNOWLEDGE) {
      const skill = SHIPPED_SKILLS.find(
        (candidate) => candidate.name === entry.skillName,
      );
      expect(
        skill,
        `${entry.topic} names unshipped ${entry.skillName}`,
      ).toBeDefined();
      expect(skill?.content.length).toBeGreaterThan(100);
      expect(skill?.roles).toContain("queen");
      expect(entry.roles).toEqual(["queen"]);
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.summary).not.toContain("\n");
    }
    const topics = QUEEN_KNOWLEDGE.map((entry) => entry.topic);
    expect(new Set(topics).size).toBe(topics.length);
    expect(topics).toEqual([
      "alignment",
      "memory",
      "worktree-lifecycle",
      "escalation",
      "dispatch",
      "mail-discipline",
      "landing",
      "succession",
      "board-conventions",
    ]);
  });

  test("resolveQueenKnowledge returns the shipped body, never a copy stored beside it", () => {
    for (const entry of QUEEN_KNOWLEDGE) {
      const resolved = resolveQueenKnowledge(entry.topic);
      const shipped = SHIPPED_SKILLS.find(
        (candidate) => candidate.name === entry.skillName,
      );
      expect(resolved?.skill).toBe(shipped);
    }
    expect(resolveQueenKnowledge("nope")).toBeNull();
  });
});

describe("hive_knowledge", () => {
  test("a known topic returns the full body, its skill name, and the content digest", async () => {
    const { queen } = callers();
    const handler = captureKnowledgeHandler(
      queen.capability,
      queen.authorizeTool,
    );
    for (const entry of QUEEN_KNOWLEDGE) {
      const result = await handler({ topic: entry.topic });
      const knowledge = result.structuredContent.knowledge;
      if (knowledge.kind !== "body") {
        throw new Error(`expected a body, got ${knowledge.kind}`);
      }
      const shipped = SHIPPED_SKILLS.find(
        (candidate) => candidate.name === entry.skillName,
      );
      if (shipped === undefined) {
        throw new Error(`${entry.skillName} is not shipped`);
      }
      // The digest is recomputed here, not via knowledgeDigest: an assertion
      // that shares the implementation under test proves nothing.
      const expectedDigest = `sha256:${createHash("sha256")
        .update(shipped.content, "utf8")
        .digest("hex")}`;
      expect(knowledge).toEqual({
        kind: "body",
        topic: entry.topic,
        skillName: entry.skillName,
        digest: expectedDigest,
        body: shipped.content,
      });
      expect(knowledge.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("an omitted topic returns the index: topic and summary per entry", async () => {
    const { queen } = callers();
    const handler = captureKnowledgeHandler(
      queen.capability,
      queen.authorizeTool,
    );
    const result = await handler({});
    expect(result.structuredContent.knowledge).toEqual({
      kind: "index",
      entries: queenKnowledgeIndex(),
    });
  });

  test("an unknown topic is a typed refusal naming the valid topics, with the index", async () => {
    const { queen } = callers();
    const handler = captureKnowledgeHandler(
      queen.capability,
      queen.authorizeTool,
    );
    const result = await handler({ topic: "nope" });
    const validTopics = [
      "alignment",
      "memory",
      "worktree-lifecycle",
      "escalation",
      "dispatch",
      "mail-discipline",
      "landing",
      "succession",
      "board-conventions",
    ];
    expect(result.structuredContent.knowledge).toEqual({
      kind: "refusal",
      topic: "nope",
      validTopics,
      fix: `Fix: call hive_knowledge with topic=<one of ${validTopics.join(", ")}>`,
      entries: queenKnowledgeIndex(),
    });
  });

  test("the grant is queen-only: a writer is refused before any topic is read", async () => {
    const { writer } = callers();
    const handler = captureKnowledgeHandler(
      writer.capability,
      writer.authorizeTool,
    );
    await expect(handler({ topic: "memory" })).rejects.toThrow(
      "Role writer may not knowledge:read",
    );
    await expect(handler({})).rejects.toThrow(
      "Role writer may not knowledge:read",
    );
    for (const role of ["user", "writer", "reader"] as const) {
      expect(ROLE_GRANTS[role].actions).not.toContain("knowledge:read");
    }
    expect(ROLE_GRANTS.orchestrator.actions).toContain("knowledge:read");
  });
});

describe("the queen policy's skill index", () => {
  test("is the registry's own rendering, one line per entry", () => {
    expect(QUEEN_POLICY).toContain(QUEEN_KNOWLEDGE_INDEX);
    for (const entry of QUEEN_KNOWLEDGE) {
      expect(QUEEN_POLICY).toContain(`hive_knowledge topic=${entry.topic}`);
    }
  });
});
