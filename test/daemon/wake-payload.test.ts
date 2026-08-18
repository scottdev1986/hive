import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { WakePayloadService } from "../../src/daemon/wake-payload-service";
import { MailStore } from "../../src/mail-service/store";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import { writeMemoryFact } from "../../src/memory-service/memory-store";
import type { MemoryWriteInput } from "../../src/schemas/memory";

const T0 = new Date("2026-08-02T12:00:00.000Z");
const at = (secondsFromStart: number): string =>
  new Date(T0.getTime() + secondsFromStart * 1_000).toISOString();

describe("WakePayloadService", () => {
  test("builds payload with mail counts by lane", async () => {
    const db = new HiveDatabase(":memory:");
    const mailStore = new MailStore(db);
    const memory = new MemoryIndex(":memory:");

    // Publish some mail items
    mailStore.publish({
      recipient: "ada",
      sender: "hive-control",
      lane: "control",
      topic: "test",
      recipientGeneration: 1,
      body: "control message",
      idempotencyKey: "key1",
      ttlSeconds: null,
      expiresAt: null,
      now: at(0),
      controlLaneCapacity: 64,
    });
    mailStore.publish({
      recipient: "ada",
      sender: "user",
      lane: "work",
      topic: "updates",
      recipientGeneration: null,
      body: "work message 1",
      idempotencyKey: "key2",
      ttlSeconds: null,
      expiresAt: null,
      now: at(1),
      controlLaneCapacity: 64,
    });
    mailStore.publish({
      recipient: "ada",
      sender: "user",
      lane: "work",
      topic: "status",
      recipientGeneration: null,
      body: "work message 2",
      idempotencyKey: "key3",
      ttlSeconds: null,
      expiresAt: null,
      now: at(2),
      controlLaneCapacity: 64,
    });

    const service = new WakePayloadService({
      mailStore,
      repoRoot: () => "/test/repo",
      memory,
      wakeBudgetTokens: 300,
    });

    const payload = await service.build({
      recipient: "ada",
      wakeId: "wake123",
      oldestItemId: "item1",
      lane: "control",
    });

    expect(payload.wakeId).toBe("wake123");
    expect(payload.oldestItemId).toBe("item1");
    expect(payload.lane).toBe("control");
    expect(payload.mailCounts.controlAvailable).toBe(1);
    expect(payload.mailCounts.workAvailable).toBe(2);
  });

  test("clamps memory delta to wake_budget_tokens", async () => {
    const db = new HiveDatabase(":memory:");
    const mailStore = new MailStore(db);
    const repoRoot = "/tmp/test-repo-wake";
    const memory = new MemoryIndex(":memory:");

    // Write many memory articles to exceed the budget
    const articles: Array<MemoryWriteInput> = [];
    for (let i = 0; i < 20; i++) {
      articles.push({
        scope: "repo",
        topic: "test",
        id: `article-${i}`,
        title: `Test article ${i}`,
        body: `This is test article ${i} with some content that will consume tokens. `.repeat(
          10,
        ),
        source: "test",
        evidence: "test",
        status: "verified",
        kind: "article",
        date: "2026-08-02",
        tags: [],
        supersedes: [],
      });
    }

    // Write articles and index them
    for (const article of articles) {
      await writeMemoryFact(repoRoot, article);
      memory.upsert({
        scope: article.scope,
        topic: article.topic,
        id: article.id,
        title: article.title,
        body: article.body,
        date: article.date,
      });
    }

    const service = new WakePayloadService({
      mailStore,
      repoRoot: () => repoRoot,
      memory,
      wakeBudgetTokens: 150, // Small budget to force truncation
    });

    const payload = await service.build({
      recipient: "test",
      wakeId: "wake456",
      oldestItemId: "item2",
      lane: "work",
    });

    expect(payload.memoryDelta.budget).toBe(150);
    expect(payload.memoryDelta.tokens).toBeLessThanOrEqual(150);
    expect(payload.memoryDelta.truncated).toBe(true);
    expect(payload.memoryDelta.omitted).toBeGreaterThan(0);
  });

  test("reports memory delta state correctly", async () => {
    const db = new HiveDatabase(":memory:");
    const mailStore = new MailStore(db);
    const memory = new MemoryIndex(":memory:");

    const service = new WakePayloadService({
      mailStore,
      repoRoot: () => "/test/repo",
      memory,
      wakeBudgetTokens: 300,
    });

    const payload = await service.build({
      recipient: "test",
      wakeId: "wake789",
      oldestItemId: "item3",
      lane: "control",
    });

    // No memory articles, so should be empty
    expect(payload.memoryDelta.state).toBe("empty");
    expect(payload.memoryDelta.pitfalls).toHaveLength(0);
    expect(payload.memoryDelta.articles).toHaveLength(0);
  });

  test("memory absent when no index wired", async () => {
    const db = new HiveDatabase(":memory:");
    const mailStore = new MailStore(db);

    const service = new WakePayloadService({
      mailStore,
      repoRoot: () => "/test/repo",
      memory: null, // No memory index
      wakeBudgetTokens: 300,
    });

    const payload = await service.build({
      recipient: "test",
      wakeId: "wake000",
      oldestItemId: "item4",
      lane: "work",
    });

    expect(payload.memoryDelta.state).toBe("absent");
  });
});
