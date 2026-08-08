import { expect } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentStandards } from "../../src/daemon/spawn/agent-standards";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  HiveSpawner,
  memoryIndexDigest,
  standardsDigest,
} from "../../src/daemon/spawn/spawner-impl";
import {
  buildMemoryIndex,
  listMemoryFacts,
  writeMemoryFact,
} from "../../src/memory-service/memory-store";
import {
  type CapabilityRecord,
  known,
  unknown,
} from "../../src/schemas/capability";
import type { RoutingPolicy } from "../../src/schemas/routing-policy";

const AT = "2026-08-05T00:00:00.000Z";

const unmeasuredCodexRecord: CapabilityRecord = {
  provider: "codex",
  accountFingerprint: "codex:spawn-test",
  cliVersion: "test",
  canonicalId: "gpt-test",
  variant: null,
  launchToken: "gpt-test",
  displayName: "gpt-test",
  aliases: [],
  entitled: known(true, "codex.model/list", AT),
  hidden: known(false, "codex.model/list", AT),
  supportsEffort: unknown("surface-silent", "codex.model/list", AT),
  supportedEffortLevels: unknown("surface-silent", "codex.model/list", AT),
  defaultEffort: unknown("surface-silent", "codex.model/list", AT),
  observedAt: AT,
};

export async function assertSpawnMemoryIndexAccounting(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-spawner-memory-primary-"));
  const home = await mkdtemp(join(tmpdir(), "hive-spawner-memory-home-"));
  const worktree = join(root, "maya");
  await mkdir(worktree, { recursive: true });
  // A spawn reads the repo's agent standards before it does anything else.
  await copyFile(
    join(import.meta.dir, "../../AGENT_STANDARDS.md"),
    join(root, "AGENT_STANDARDS.md"),
  );
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
    status: "unverified" as const,
    kind: "article" as const,
    supersedes: [],
    date: "2026-07-25",
  };
  await writeMemoryFact(root, {
    ...memoryInput,
    id: "fresh-primary-article",
    title: "Fresh primary article",
  });
  for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
    await writeMemoryFact(root, {
      ...memoryInput,
      id: `prompt-accounting-${ordinal}`,
      title: `Prompt accounting ${ordinal}`,
    });
  }
  await writeMemoryFact(worktree, {
    ...memoryInput,
    id: "stale-worktree-copy",
    title: "Stale worktree copy",
  });
  const policy: RoutingPolicy = {
    schemaVersion: 3,
    revision: 1,
    updatedAt: "2026-07-25T00:00:00.000Z",
    provisional: false,
    providers: {},
    models: [],
    global: null,
    categories: {
      simple_coding: {
        mode: "user-weighted",
        candidates: [
          {
            provider: "codex",
            model: "gpt-test",
            effort: { mode: "provider-controlled" },
            weight: 1,
          },
        ],
      },
    },
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
    discoverCapabilities: async (provider) =>
      provider === "codex"
        ? {
            status: "ok",
            records: [unmeasuredCodexRecord],
            effectiveDefault: {
              provider: "codex",
              model: unknown("field-absent", "codex.config/read", AT),
              effort: unknown("field-absent", "codex.config/read", AT),
            },
          }
        : { status: "unavailable", reason: "not in fixture" },
    readBilling: async () => {
      billingReads += 1;
      return null;
    },
    createWorktree: async () => ({
      path: worktree,
      branch: "hive/maya-memory",
    }),
    unavailableAgentNames: async () => new Set(),
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
    expect(prompt).toContain("## Knowledge index data");
    const encoded = prompt.match(
      /knowledgeIndexData: ("(?:[^"\\]|\\.)*")/,
    )?.[1];
    expect(encoded).toBeDefined();
    const payload = JSON.parse(encoded ?? '""') as string;
    const delivered = payload
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- [")).length;
    const records = JSON.parse(
      prompt.match(/records: (\{.*?\})/)?.[1] ?? "{}",
    ) as { omitted?: number };
    const omitted = records.omitted ?? 0;
    expect(prompt).toContain("CAP CROSSED:");
    const corpus = (await listMemoryFacts(root)).length;
    expect(delivered).toBe(30);
    expect(omitted).toBe(1);
    expect(delivered + omitted).toBe(corpus);
    // The launched prompt names the index it carries, and the name matches an
    // index rebuilt from the primary checkout with this agent's own brief —
    // the ranking depends on the brief, so a stamp is only comparable against
    // an index built the same way.
    expect(prompt).toContain(
      `Memory index digest sha256:${memoryIndexDigest(
        await buildMemoryIndex(root, { brief: "Fix the flaky test" }),
      )}`,
    );
    // The same claim for the rules: a daemon that loaded the standards before
    // the last edit launches agents whose prompts still stamp the old text, so
    // a stamp that matches the standards read from the checkout right now is
    // what says this spawn and this repo are the same generation.
    expect(prompt).toContain(
      `Standards digest sha256:${standardsDigest(
        await loadAgentStandards(root),
      )}`,
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!db.isAgentNameReserved(admitted.name)) break;
      await Bun.sleep(5);
    }
    const retained = db.getAgentById(admitted.id);
    expect(retained?.status).toBe("unknown");
    expect(retained?.worktreePath).toBe(worktree);
    expect(retained?.branch).toBe("hive/maya-memory");
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
}
