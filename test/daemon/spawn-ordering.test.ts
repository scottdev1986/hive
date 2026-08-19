import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createWorktree,
  reconcileOrphanedWorktrees,
  WORKTREE_SETTLING_INTERVAL_MS,
} from "../../src/adapters/worktrees";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import type { WorktreeCreator } from "../../src/daemon/spawn/hive-spawner-contract";
import { HiveSpawner } from "../../src/daemon/spawn/spawner-impl";
import type { RoutingPolicy } from "../../src/schemas/routing-policy";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

const policy: RoutingPolicy = {
  schemaVersion: 3,
  revision: 1,
  updatedAt: "2026-08-10T12:00:00.000Z",
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

async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Hive Test",
      GIT_AUTHOR_EMAIL: "hive@example.test",
      GIT_COMMITTER_NAME: "Hive Test",
      GIT_COMMITTER_EMAIL: "hive@example.test",
    },
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
}

async function fixture(
  create: (context: { db: HiveDatabase; repoRoot: string }) => WorktreeCreator,
  options: {
    readonly terminalCreate?: () => Promise<never>;
  } = {},
) {
  const repoRoot = await mkdtemp(
    join(OUTSIDE_REPO_TMPDIR, "hive-spawn-ordering-repo-"),
  );
  const hiveHome = await mkdtemp(
    join(OUTSIDE_REPO_TMPDIR, "hive-spawn-ordering-home-"),
  );
  await copyFile(
    join(import.meta.dir, "../../AGENT_STANDARDS.md"),
    join(repoRoot, "AGENT_STANDARDS.md"),
  );
  const previousHiveHome = process.env.HIVE_HOME;
  process.env.HIVE_HOME = hiveHome;
  const db = new HiveDatabase(":memory:");
  const spawner = new HiveSpawner({
    db,
    repoRoot,
    port: 4_317,
    config: {},
    readRoutingPolicy: () => policy,
    isModelEnabled: async () => true,
    readBilling: async () => null,
    createWorktree: create({ db, repoRoot }),
    unavailableAgentNames: async () => new Set(),
    stopSession: async () => ({ killed: [], survivors: [] }),
    claudeExecutable: "claude",
    codexExecutable: "codex",
    grokExecutable: "grok",
    kimiExecutable: "kimi",
    opencodeExecutable: "opencode",
    sessiond: {
      prepareAgentCreation: async () => ({
        engineBuildId: "engine-test",
        visibility: {
          workspaceSessionId: "workspace-test",
          workspacePid: 123,
          workspaceStartToken: "123:1",
          openTerminalRevision: "1",
        },
      }),
      admit: async () => null,
      terminalHost: {
        create:
          options.terminalCreate ??
          (async () => {
            throw new Error("terminal creation must not be reached");
          }),
        inspect: async () => {
          throw new Error("terminal inspection must not be reached");
        },
        terminate: async () => {
          throw new Error("terminal termination must not be reached");
        },
      },
    },
  });
  return {
    db,
    repoRoot,
    spawner,
    cleanup: async () => {
      db.close();
      if (previousHiveHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHiveHome;
      await Promise.all([
        rm(repoRoot, { recursive: true, force: true }),
        rm(hiveHome, { recursive: true, force: true }),
      ]);
    },
  };
}

const request = {
  task: "Exercise spawn ordering",
  category: "simple_coding",
} as const;

test("the spawning row and name reservation exist before worktree creation", async () => {
  let observedCreate = false;
  let selectedName = "";
  const state = await fixture(({ db, repoRoot }) => async (_root, name) => {
    observedCreate = true;
    selectedName = name;
    expect(db.getLiveAgentByName(name)).toMatchObject({
      name,
      status: "spawning",
      worktreePath: join(repoRoot, ".hive", "worktrees", name),
      branch: null,
    });
    expect(db.isAgentNameReserved(name)).toBeTrue();
    expect(db.reserveAgentName(name)).toBeFalse();
    throw new Error("stop inside worktree creation");
  });
  try {
    await expect(state.spawner.spawn(request)).rejects.toThrow(
      "stop inside worktree creation",
    );
    expect(observedCreate).toBeTrue();
    expect(selectedName).not.toBe("");
    expect(state.db.reserveAgentName(selectedName)).toBeTrue();
    expect(state.db.releaseAgentName(selectedName)).toBeTrue();
  } finally {
    await state.cleanup();
  }
});

test("worktree creation failure discards the provisional row without touching git", async () => {
  let provisionalAgentId: string | null = null;
  const state = await fixture(({ db }) => async (_root, name) => {
    provisionalAgentId = db.getAgentByName(name)?.id ?? null;
    throw new Error("worktree creation failed");
  });
  try {
    await expect(state.spawner.spawn(request)).rejects.toThrow(
      "worktree creation failed",
    );
    expect(provisionalAgentId).not.toBeNull();
    expect(state.db.listAgents()).toEqual([]);
  } finally {
    await state.cleanup();
  }
});

test("a reconciliation inside worktree creation sees the live spawning owner", async () => {
  const reconciliationRules: string[] = [];
  const state = await fixture(({ db, repoRoot }) => async (...args) => {
    await git(repoRoot, "init", "-b", "main");
    await writeFile(join(repoRoot, "README.md"), "# test\n");
    await git(repoRoot, "add", "README.md");
    await git(repoRoot, "commit", "-m", "initial");
    const created = await createWorktree(...args);
    const report = await reconcileOrphanedWorktrees(
      repoRoot,
      db.listAgents(),
      "main",
      { now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1 },
    );
    const rule = report.worktrees.find(
      (entry) => entry.path === created.path,
    )?.rule;
    if (rule !== undefined) reconciliationRules.push(rule);
    throw new Error("stop after reconciliation");
  });
  try {
    await expect(state.spawner.spawn(request)).rejects.toThrow(
      "stop after reconciliation",
    );
    expect(reconciliationRules).toEqual(["live-agent"]);
  } finally {
    await state.cleanup();
  }
});

test("the name remains reserved until background launch settles", async () => {
  let rejectCreate: (error: Error) => void = () => {};
  let creationStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    creationStarted = resolve;
  });
  const pendingCreate = new Promise<never>((_resolve, reject) => {
    rejectCreate = reject;
  });
  const state = await fixture(
    ({ repoRoot }) =>
      async (...args) => {
        await git(repoRoot, "init", "-b", "main");
        await git(repoRoot, "add", "AGENT_STANDARDS.md");
        await git(repoRoot, "commit", "-m", "initial");
        return await createWorktree(...args);
      },
    {
      terminalCreate: async () => {
        creationStarted();
        return await pendingCreate;
      },
    },
  );
  try {
    const record = await state.spawner.spawn(request);
    await started;

    expect(state.db.isAgentNameReserved(record.name)).toBeTrue();
    expect(state.db.reserveAgentName(record.name)).toBeFalse();

    rejectCreate(new Error("injected terminal launch failure"));
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!state.db.isAgentNameReserved(record.name)) break;
      await Bun.sleep(10);
    }
    expect(state.db.isAgentNameReserved(record.name)).toBeFalse();
  } finally {
    await state.cleanup();
  }
});
