import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemoryFact } from "../../src/adapters/memory";
import { HiveDatabase } from "../../src/daemon/db";
import { HiveSpawner } from "../../src/daemon/spawner-impl";
import type { RoutingPolicy } from "../../src/schemas";

test("spawn memory comes from the primary checkout, not a stale worktree copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-spawner-memory-primary-"));
  const home = await mkdtemp(join(tmpdir(), "hive-spawner-memory-home-"));
  const worktree = join(root, "maya");
  await mkdir(worktree, { recursive: true });
  const previousHome = process.env.HIVE_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  let billingReads = 0;
  process.env.HIVE_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
  const db = new HiveDatabase(":memory:");
  const memoryInput = {
    scope: "repo" as const,
    topic: "testing",
    body: "Spawn-index fixture.",
    source: "agent" as const,
    evidence: "This test writes both copies.",
    status: "verified" as const,
    kind: "article" as const,
    supersedes: [],
    verified: "2026-07-25",
    date: "2026-07-25",
  };
  await writeMemoryFact(root, {
    ...memoryInput,
    id: "fresh-primary-article",
    title: "Fresh primary article",
  });
  await writeMemoryFact(worktree, {
    ...memoryInput,
    id: "stale-worktree-copy",
    title: "Stale worktree copy",
  });
  const policy: RoutingPolicy = {
    schemaVersion: 2,
    revision: 1,
    updatedAt: "2026-07-25T00:00:00.000Z",
    provisional: false,
    providers: {},
    models: [],
    chains: {
      simple_coding: [
        {
          provider: "codex",
          model: "gpt-test",
          effort: { mode: "provider-controlled" },
        },
      ],
    },
    selection: { global: "choice" },
  };
  const admission = {
    engineBuildId: "engine-test",
    geometry: {
      columns: 80,
      rows: 24,
      widthPx: 800,
      heightPx: 480,
      cellWidthPx: 10,
      cellHeightPx: 20,
    },
    visibility: {
      workspaceSessionId: "workspace-test",
      workspacePid: 123,
      workspaceStartToken: "123:1",
      openTerminalRevision: "1",
    },
  };
  const spawner = new HiveSpawner({
    db,
    repoRoot: root,
    port: 4317,
    config: {},
    readRoutingPolicy: () => policy,
    isModelEnabled: async () => true,
    readBilling: async () => {
      billingReads += 1;
      return null;
    },
    createWorktree: async () => ({
      path: worktree,
      branch: "hive/maya-memory",
    }),
    unavailableAgentNames: async () => new Set(),
    removeWorktree: async () => {},
    assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    stopSession: async () => ({ killed: [], survivors: [] }),
    listCodexMcpServers: async () => [],
    claudeExecutable: "claude",
    codexExecutable: "codex",
    grokExecutable: "grok",
    kimiExecutable: "kimi",
    opencodeExecutable: "opencode",
    sessiond: {
      prepareAgentCreation: async () => admission,
      admit: async () => null,
      terminalHost: {
        create: async () => {
          throw new Error("terminal creation stopped after prompt assembly");
        },
        inspect: async () => {
          throw new Error("not reached");
        },
        terminate: async () => {
          throw new Error("not reached");
        },
      },
    },
  });

  try {
    const admitted = await spawner.spawn({
      name: "maya",
      task: "Fix the flaky test",
      category: "simple_coding",
    });
    expect(admitted.status).toBe("spawning");
    const promptDirectory = join(home, "runtime", "prompts");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        (await readdir(promptDirectory).catch(() => [])).some((name) =>
          name.endsWith(".txt"),
        )
      ) {
        break;
      }
      await Bun.sleep(5);
    }
    const promptName = (await readdir(promptDirectory)).find((name) =>
      name.endsWith(".txt"),
    );
    expect(promptName).toBeDefined();
    if (promptName === undefined)
      throw new Error("launch prompt was not written");
    const prompt = await readFile(join(promptDirectory, promptName), "utf8");
    expect(prompt).toContain("fresh-primary-article");
    expect(prompt).not.toContain("stale-worktree-copy");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (db.getAgentById(admitted.id)?.status === "failed") break;
      await Bun.sleep(5);
    }
    const failed = db.getAgentById(admitted.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.worktreePath).toBeNull();
    expect(failed?.branch).toBeNull();
    expect(billingReads).toBe(1);
  } finally {
    db.close();
    if (previousHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  }
});
