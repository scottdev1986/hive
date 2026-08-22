import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodicStore } from "../../src/memory-service/episodic";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import {
  harvestVerification,
  VERIFICATION_ARTICLE_ID,
  verificationCommandFromTitle,
} from "../../src/memory-service/harvest";
import { readMemoryFact } from "../../src/memory-service/memory-store";
import { MemoryWriteService } from "../../src/memory-service/write-service";
import type { MemoryWriteInput } from "../../src/schemas/memory";

const tempRoots: string[] = [];
const originalHiveHome = process.env.HIVE_HOME;

afterEach(async () => {
  if (originalHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHiveHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function repo(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-verify-harvest-home-"));
  const root = await mkdtemp(join(tmpdir(), "hive-verify-harvest-repo-"));
  tempRoots.push(home, root);
  process.env.HIVE_HOME = home;
  return root;
}

function writer(repoRoot: string) {
  const service = new MemoryWriteService({
    repoRoot,
    index: new MemoryIndex(new Database(":memory:")),
    embeddingIndex: null,
  });
  return { write: (input: MemoryWriteInput) => service.write(input) };
}

describe("harvestVerification", () => {
  test("a typed successful command becomes the verification article", async () => {
    const repoRoot = await repo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: "2026-08-16T12:00:00.000Z",
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "tests passed",
      provenance: {
        data: { phase: "complete", command: "npm test", exitCode: 0 },
      },
    });

    const report = await harvestVerification({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
      write: writer(repoRoot).write,
    });

    expect(report.wrote).toBe(true);
    expect(report.command).toBe("npm test");
    expect(report.id).toBe(VERIFICATION_ARTICLE_ID);
    const fact = await readMemoryFact(
      repoRoot,
      "repo",
      VERIFICATION_ARTICLE_ID,
    );
    expect(fact).not.toBeNull();
    expect(verificationCommandFromTitle(fact?.title ?? "")).toBe("npm test");
    expect(fact?.status).toBe("unverified");
    expect(fact?.topic).toBe("verification");
    store.close();
  });

  test("exit-0 prose without a command field writes nothing", async () => {
    const repoRoot = await repo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: "2026-08-16T12:00:00.000Z",
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "Fix complete: 2772 pass / 0 fail (exit code 0)",
      provenance: { data: { phase: "complete", exitCode: 0 } },
    });

    const report = await harvestVerification({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
      write: writer(repoRoot).write,
    });

    expect(report).toEqual({ wrote: false, command: null, id: null });
    expect(
      await readMemoryFact(repoRoot, "repo", VERIFICATION_ARTICLE_ID),
    ).toBeNull();
    store.close();
  });

  test("the same command is not written twice", async () => {
    const repoRoot = await repo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: "2026-08-16T12:00:00.000Z",
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "green",
      provenance: {
        data: { phase: "complete", command: "make test", exitCode: 0 },
      },
    });
    const first = await harvestVerification({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
      write: writer(repoRoot).write,
    });
    expect(first.wrote).toBe(true);

    const second = await harvestVerification({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-2",
      write: writer(repoRoot).write,
    });
    expect(second.wrote).toBe(false);
    expect(second.command).toBe("make test");
    store.close();
  });
});
