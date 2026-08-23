import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { formatWakePrompt } from "../../src/cli/agent-ui/wake-prompt";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { WakePayloadService } from "../../src/daemon/wake-payload-service";
import { MailStore } from "../../src/mail-service/store";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import { writeMemoryFact } from "../../src/memory-service/memory-store";
import type { MemoryWriteInput } from "../../src/schemas/memory";
import { tempRoot } from "../temp-root";

const T0 = new Date("2026-08-02T12:00:00.000Z");
const at = (secondsFromStart: number): string =>
  new Date(T0.getTime() + secondsFromStart * 1_000).toISOString();

async function wakeService(
  root: string,
  mailStore: MailStore,
  wakeBudgetTokens: number,
): Promise<WakePayloadService> {
  const index = new MemoryIndex(new Database(":memory:"));
  await index.rebuild(root);
  return new WakePayloadService({
    mailStore,
    repoRoot: () => root,
    wakeBudgetTokens,
    memoryRecallDeps: () => ({
      repoRoot: () => root,
      memory: index,
    }),
  });
}

describe("WakePayloadService", () => {
  test("builds payload with mail counts by lane", async () => {
    const root = tempRoot("hive-wake-");
    const db = new HiveDatabase(":memory:");
    const mailStore = new MailStore(db);

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

    const service = await wakeService(root, mailStore, 300);

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

  test("builds date-ranked recent wiki slice, not recipient search", async () => {
    const root = tempRoot("hive-wake-");
    const db = new HiveDatabase(":memory:");
    const mailStore = new MailStore(db);

    // First writes are unverified: the schema refuses verified without a
    // date, and the store refuses an author verifying their own article.
    const articles: Array<MemoryWriteInput> = [
      {
        scope: "repo",
        topic: "test",
        id: "old-article",
        title: "Old article",
        body: "This is an old article.",
        source: "user",
        evidence: "test",
        status: "unverified",
        kind: "article",
        date: "2026-07-01",
        tags: [],
        supersedes: [],
      },
      {
        scope: "repo",
        topic: "test",
        id: "recent-article",
        title: "Recent article",
        body: "This is a recent article.",
        source: "user",
        evidence: "test",
        status: "unverified",
        kind: "article",
        date: "2026-08-01",
        tags: [],
        supersedes: [],
      },
      {
        scope: "repo",
        topic: "test",
        id: "newest-article",
        title: "Newest article",
        body: "This is the newest article.",
        source: "user",
        evidence: "test",
        status: "unverified",
        kind: "article",
        date: "2026-08-02",
        tags: [],
        supersedes: [],
      },
    ];

    for (const article of articles) {
      await writeMemoryFact(root, article);
    }

    const service = await wakeService(root, mailStore, 300);

    const payload = await service.build({
      recipient: "test",
      wakeId: "wake456",
      oldestItemId: "item2",
      lane: "work",
    });

    expect(payload.memoryDelta.state).toBe("ok");
    // Should be sorted by date descending
    const allRows = [
      ...payload.memoryDelta.pitfalls,
      ...payload.memoryDelta.articles,
    ];
    expect(allRows[0]?.id).toBe("newest-article");
    expect(allRows[1]?.id).toBe("recent-article");
    expect(allRows[2]?.id).toBe("old-article");
  });

  test("clamps memory to wake_budget_tokens and reports omitted counts", async () => {
    const root = tempRoot("hive-wake-");
    const db = new HiveDatabase(":memory:");
    const mailStore = new MailStore(db);

    // Write many articles to exceed the budget
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
        source: "user",
        evidence: "test",
        status: "unverified",
        kind: "article",
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        tags: [],
        supersedes: [],
      });
    }

    for (const article of articles) {
      await writeMemoryFact(root, article);
    }

    const service = await wakeService(root, mailStore, 150);

    const payload = await service.build({
      recipient: "test",
      wakeId: "wake789",
      oldestItemId: "item3",
      lane: "work",
    });

    expect(payload.memoryDelta.budget).toBe(150);
    expect(payload.memoryDelta.tokens).toBeLessThanOrEqual(150);
    expect(payload.memoryDelta.truncated).toBe(true);
    expect(payload.memoryDelta.omitted).toBeGreaterThan(0);
  });

  test("reports empty state when wiki has no rows", async () => {
    const root = tempRoot("hive-wake-");
    const db = new HiveDatabase(":memory:");
    const mailStore = new MailStore(db);

    const service = await wakeService(root, mailStore, 300);

    const payload = await service.build({
      recipient: "test",
      wakeId: "wake000",
      oldestItemId: "item4",
      lane: "control",
    });

    expect(payload.memoryDelta.state).toBe("empty");
    expect(payload.memoryDelta.pitfalls).toHaveLength(0);
    expect(payload.memoryDelta.articles).toHaveLength(0);
  });
});

describe("formatWakePrompt", () => {
  test("rendered text contains no mail body", () => {
    const payload = {
      wakeId: "wake123",
      oldestItemId: "item1",
      lane: "control" as const,
      mailCounts: {
        controlAvailable: 2,
        workAvailable: 3,
      },
      memoryDelta: {
        state: "empty" as const,
        semantic: "disabled" as const,
        pitfalls: [],
        articles: [],
        tokens: 0,
        budget: 300,
        truncated: false,
        omitted: 0,
        omittedPitfalls: 0,
        omittedArticles: 0,
      },
    };

    const text = formatWakePrompt(payload);

    // Should not contain mail bodies
    expect(text).not.toContain("control message");
    expect(text).not.toContain("work message 1");
    expect(text).not.toContain("work message 2");
  });

  test("rendered text does not contain oldestItemId or wakeId", () => {
    const payload = {
      wakeId: "wake-xyz-123",
      oldestItemId: "item-abc-456",
      lane: "work" as const,
      mailCounts: {
        controlAvailable: 1,
        workAvailable: 2,
      },
      memoryDelta: {
        state: "empty" as const,
        semantic: "disabled" as const,
        pitfalls: [],
        articles: [],
        tokens: 0,
        budget: 300,
        truncated: false,
        omitted: 0,
        omittedPitfalls: 0,
        omittedArticles: 0,
      },
    };

    const text = formatWakePrompt(payload);

    expect(text).not.toContain("wake-xyz-123");
    expect(text).not.toContain("item-abc-456");
    expect(text).not.toContain("oldestItemId");
    expect(text).not.toContain("wakeId");
  });

  test("truncated memory shows omitted counts", () => {
    const payload = {
      wakeId: "wake123",
      oldestItemId: "item1",
      lane: "control" as const,
      mailCounts: {
        controlAvailable: 1,
        workAvailable: 0,
      },
      memoryDelta: {
        state: "ok" as const,
        semantic: "disabled" as const,
        pitfalls: [
          {
            scope: "repo",
            topic: "test",
            id: "pitfall-1",
            date: "2026-08-01",
            title: "Test pitfall",
            snippet: "A test pitfall",
            status: "verified",
            flag: null,
            pitfall: true,
          },
        ],
        articles: [
          {
            scope: "repo",
            topic: "test",
            id: "article-1",
            date: "2026-08-01",
            title: "Test article",
            snippet: "A test article",
            status: "verified",
            flag: null,
            pitfall: false,
          },
        ],
        tokens: 120,
        budget: 150,
        truncated: true,
        omitted: 5,
        omittedPitfalls: 2,
        omittedArticles: 3,
      },
    };

    const text = formatWakePrompt(payload);

    expect(text).toContain("5 omitted");
    expect(text).toContain("2 pitfalls");
    expect(text).toContain("3 articles");
  });

  test("empty state uses honest wording without since-last-wake language", () => {
    const payload = {
      wakeId: "wake123",
      oldestItemId: "item1",
      lane: "control" as const,
      mailCounts: {
        controlAvailable: 1,
        workAvailable: 0,
      },
      memoryDelta: {
        state: "empty" as const,
        semantic: "disabled" as const,
        pitfalls: [],
        articles: [],
        tokens: 0,
        budget: 300,
        truncated: false,
        omitted: 0,
        omittedPitfalls: 0,
        omittedArticles: 0,
      },
    };

    const text = formatWakePrompt(payload);

    // Should not claim to be a delta or "since last wake"
    expect(text).not.toContain("since your last wake");
    expect(text).not.toContain("memory delta");
    expect(text).not.toContain("changes since");
    expect(text).not.toContain("nothing new");

    // Should use honest empty language
    expect(text).toContain("No matching memory for this wake");
    expect(text).toContain("This is not a since-last-wake check");
  });
});
