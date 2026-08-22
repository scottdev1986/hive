import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodicStore } from "../src/memory-service/episodic";
import { loadRecentMistakes } from "../src/memory-service/pack-floor";

/** Test that loadRecentMistakes works with EpisodicStore */

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

describe("loadRecentMistakes with EpisodicStore", () => {
  test("works with real EpisodicStore instance", async () => {
    const root = await makeTempDir("pack-floor-test-");
    const episodic = new EpisodicStore(":memory:");

    episodic.appendEvent({
      type: "mistake",
      summary: "Test mistake 1",
      provenance: {},
    });

    episodic.appendEvent({
      type: "pitfall",
      summary: "Test pitfall 1",
      provenance: {},
    });

    episodic.appendEvent({
      type: "other",
      summary: "Not a mistake",
      provenance: {},
    });

    const mistakes = await loadRecentMistakes(episodic, root);

    expect(mistakes.length).toBeGreaterThan(0);
    expect(mistakes.some((m) => m.includes("Test mistake 1"))).toBe(true);
    expect(mistakes.some((m) => m.includes("Test pitfall 1"))).toBe(true);
    expect(mistakes.some((m) => m.includes("Not a mistake"))).toBe(false);

    episodic.close();
  });

  test("returns empty array when episodic is undefined", async () => {
    const root = await makeTempDir("pack-floor-undefined-");
    const mistakes = await loadRecentMistakes(undefined, root);
    expect(mistakes.length).toBe(0);
  });

  test("includes promoted mistakes when present", async () => {
    const root = await makeTempDir("pack-floor-promoted-");
    const episodic = new EpisodicStore(":memory:");

    const { writeMemoryFact } =
      await import("../src/memory-service/memory-store");

    await writeMemoryFact(root, {
      scope: "repo",
      topic: "mistakes-promoted",
      title: "Promoted mistake",
      body: "## What failed\n\n- Failure signature: test:promoted:error\n\nTest",
      tags: ["pitfall", "promoted", "always-on"],
      source: "orchestrator",
      status: "unverified",
      kind: "pitfall",
      date: "2026-08-20",
      evidence: "Test",
      supersedes: [],
    });

    episodic.appendEvent({
      type: "mistake",
      summary: "Recent mistake",
      provenance: {},
    });

    const mistakes = await loadRecentMistakes(episodic, root);

    const promoted = mistakes.filter((m) => m.includes("[PROMOTED]"));
    const recent = mistakes.filter((m) => m.includes("Recent mistake"));

    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted[0]).toContain("test:promoted:error");
    expect(recent.length).toBeGreaterThan(0);

    episodic.close();
  });
});
