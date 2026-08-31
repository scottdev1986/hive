import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { definedFields } from "../../src/shared/defined-fields";
import { HiveSpawner } from "../../src/daemon/spawn/spawner-impl";
import type { CapabilityRecord } from "../../src/schemas/capability";
import { known, unknown } from "../../src/schemas/capability";
import type { RoutingPolicy } from "../../src/schemas/routing-policy";

/**
 * The Ghostty launch path: the spawner writes a launch spec and nothing on
 * this machine execs it except a Workspace pane. These tests pin that the
 * daemon MEASURES that gap — an agent is working only once something answered
 * (a lifecycle event, the pane process itself), and a spec no pane ever ran
 * fails the launch instead of minting a working agent out of a file write.
 */

const AT = "2026-08-31T09:00:00.000Z";
const REPO_ROOT = resolve(import.meta.dir, "../..");
const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function policyWithCodex(): RoutingPolicy {
  return {
    schemaVersion: 3,
    revision: 1,
    updatedAt: AT,
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
}

const codexRecord: CapabilityRecord = {
  provider: "codex",
  accountFingerprint: "codex:pane-readiness",
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

async function fixture(options: {
  newestAgentEventSeq?: (agentId: string) => string | null;
  ps?: () => Promise<string>;
}) {
  const root = await mkdtemp(join(tmpdir(), "hive-pane-readiness-"));
  const home = await mkdtemp(join(tmpdir(), "hive-pane-readiness-home-"));
  const worktree = join(root, "pane-agent");
  await mkdir(worktree, { recursive: true });
  tempRoots.push(root, home);
  process.env.HIVE_HOME = home;
  await copyFile(
    join(REPO_ROOT, "AGENT_STANDARDS.md"),
    join(root, "AGENT_STANDARDS.md"),
  );
  const db = new HiveDatabase(":memory:");
  const spawner = new HiveSpawner({
    db,
    repoRoot: root,
    port: 4317,
    config: {},
    readRoutingPolicy: () => policyWithCodex(),
    isModelEnabled: async () => true,
    discoverCapabilities: async (provider) =>
      provider === "codex"
        ? {
            status: "ok",
            records: [codexRecord],
            effectiveDefault: {
              provider: "codex",
              model: unknown("field-absent", "codex.config/read", AT),
              effort: unknown("field-absent", "codex.config/read", AT),
            },
          }
        : { status: "unavailable", reason: "not in fixture" },
    readBilling: async () => null,
    createWorktree: async () => ({
      path: worktree,
      branch: "hive/pane-agent",
    }),
    unavailableAgentNames: async () => new Set(),
    stopSession: async () => ({ killed: [], survivors: [] }),
    listCodexMcpServers: async () => [],
    claudeExecutable: "claude",
    codexExecutable: "codex",
    grokExecutable: "grok",
    kimiExecutable: "kimi",
    opencodeExecutable: "opencode",
    // No seam override: the real launch-spec write runs, which is what routes
    // monitorReadiness onto the pane watch under test.
    sleep: async () => {},
    ps: options.ps ?? (async () => ""),
    ...definedFields({ newestAgentEventSeq: options.newestAgentEventSeq }),
    sessiond: {
      prepareAgentCreation: async () => ({
        engineBuildId: "engine-pane-readiness",
        visibility: {
          workspaceSessionId: "workspace-pane-readiness",
          workspacePid: 123,
          workspaceStartToken: "123:1",
          openTerminalRevision: "1",
        },
      }),
      admit: async () => null,
      terminalHost: {
        create: async () => {
          throw new Error("sessiond create is not part of the Ghostty path");
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
  return { db, spawner };
}

async function settled(db: HiveDatabase, name: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (!db.isAgentNameReserved(name)) return;
    await Bun.sleep(5);
  }
  throw new Error("background launch never settled");
}

test("a lifecycle event after the baseline proves the pane and the agent starts", async () => {
  let calls = 0;
  const { db, spawner } = await fixture({
    // First read is the baseline; anything later is a genuinely new event.
    newestAgentEventSeq: () => (calls++ === 0 ? null : "7"),
  });
  try {
    const admitted = await spawner.spawn({
      task: "prove life over the pane path",
      category: "simple_coding",
    });
    await settled(db, admitted.name);
    expect(db.getAgentById(admitted.id)?.status).toBe("working");
  } finally {
    db.close();
  }
});

test("the frontend process carrying the run id is proof enough for a quiet pane", async () => {
  let launchedDb: HiveDatabase | null = null;
  let launchedAgentId: string | null = null;
  const { db, spawner } = await fixture({
    ps: async () => {
      // The run id exists nowhere but this launch's frontend argv, so a table
      // row carrying it is this pane and no other.
      const runId =
        launchedAgentId === null
          ? null
          : (launchedDb?.getActiveProviderRunForAgent(launchedAgentId)?.runId ??
            null);
      return runId === null
        ? ""
        : ` 4100  4000  2048 bun hive agent-ui --provider-run-id ${runId}`;
    },
  });
  launchedDb = db;
  try {
    const admitted = await spawner.spawn({
      task: "wait quietly at the composer",
      category: "simple_coding",
    });
    launchedAgentId = admitted.id;
    await settled(db, admitted.name);
    expect(db.getAgentById(admitted.id)?.status).toBe("working");
  } finally {
    db.close();
  }
});

test("a spec no pane ever ran fails the launch instead of minting a working agent", async () => {
  const { db, spawner } = await fixture({
    // A readable table that never contains the run id: the Workspace is not
    // running, so nothing ever execed the spec.
    ps: async () => " 4000     1  1024 /bin/zsh",
  });
  try {
    const admitted = await spawner.spawn({
      task: "spawn with no Workspace open",
      category: "simple_coding",
    });
    await settled(db, admitted.name);
    // No terminal ever reported dead, so cleanup is not authorized: the record
    // is preserved as "unknown" — never "working" — and the failure is on the run.
    const record = db.getAgentById(admitted.id);
    expect(record?.status).toBe("unknown");
    expect(db.listRunOutcomes()).toMatchObject([{ outcome: "launch-failed" }]);
  } finally {
    db.close();
  }
});
