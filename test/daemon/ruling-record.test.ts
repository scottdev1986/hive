import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoMemoryCitesItem } from "../../src/daemon/messaging/ruling-record";
import { writeMemoryFact } from "../../src/memory-service/memory-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("repoMemoryCitesItem", () => {
  test("an article cites the itemId from evidence or body, not title", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-ruling-record-"));
    roots.push(root);
    expect(await repoMemoryCitesItem(root, "item-abc")).toBe(false);

    await writeMemoryFact(root, {
      scope: "repo",
      topic: "rulings",
      title: "Wait on first boot",
      body: "Do not invent work.",
      source: "orchestrator",
      evidence: "owner control item-abc",
      status: "unverified",
      supersedes: [],
      author: "queen",
    });
    expect(await repoMemoryCitesItem(root, "item-abc")).toBe(true);
    expect(await repoMemoryCitesItem(root, "item-other")).toBe(false);
  });
});
