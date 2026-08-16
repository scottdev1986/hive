import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assessStrandedWork,
  createWorktree,
  listStewardshipRefs,
  listSettlementBranches,
  reconcileOrphanedWorktrees,
  WORKTREE_SETTLING_INTERVAL_MS,
} from "../../src/adapters/worktrees";
import { writeGrokAgentConfig } from "../../src/adapters/providers/grok-cli";
import {
  graphifyHookPath,
  writeGraphifyHook,
} from "../../src/adapters/providers/shared/graphify-hook";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { SettlementCaseStore } from "../../src/daemon/worktree-lifecycle-service/settlement-case-store";
import { measureAutomaticRelease } from "../../src/daemon/worktree-lifecycle-service/settlement-proof";
import { WorktreeLifecycleService } from "../../src/daemon/worktree-lifecycle-service/worktree-lifecycle-service";
import { hiveInstanceSuffix } from "../../src/hive-home/instance-identity";
import type { AgentRecord } from "../../src/schemas/agent";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";
import { deleteAgentRow } from "../support/daemon-test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], {
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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

type FixtureLiveness = "dead" | "live" | "unknown";

async function fixture(
  liveness: FixtureLiveness | (() => Promise<FixtureLiveness>) = "dead",
  clock: () => Date = () => new Date("2026-08-12T12:05:00.000Z"),
) {
  const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "settlement-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "README.md"), "# settlement\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  const worktree = await createWorktree(repo, "maya", "proof");
  const db = new HiveDatabase(":memory:");
  const agent = db.insertAgent({
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "complex_coding",
    status: "dead",
    taskDescription: "prove settlement",
    worktreePath: worktree.path,
    branch: worktree.branch,
    contextPct: null,
    createdAt: "2026-08-12T12:00:00.000Z",
    lastEventAt: "2026-08-12T12:00:00.000Z",
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: true,
  });
  const lifecycle = new WorktreeLifecycleService({
    db,
    repoRoot: repo,
    clock,
    publish: async () => {},
    assessStrandedWork,
    listSettlementBranches,
    reconcileOrphanedWorktrees,
    processLiveness: async () =>
      typeof liveness === "function" ? liveness() : liveness,
  });
  await lifecycle.openSettlementCase(
    agent,
    worktree,
    await git(repo, "rev-parse", "main"),
  );
  return { repo, worktree, db, agent, lifecycle };
}

async function settle(lifecycle: WorktreeLifecycleService, agent: AgentRecord) {
  return lifecycle.settleTeardownWorktree({
    agent,
    updated: agent,
    capture: await lifecycle.captureFinalWorkManifest(agent),
    at: "2026-08-12T12:05:00.000Z",
    removeWorktree: false,
  });
}

describe("worktree settlement proof", () => {
  test("stop rejects the complete public mutation surface while reads remain available", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      const capture = await lifecycle.captureFinalWorkManifest(agent);
      await lifecycle.stop();
      expect(await lifecycle.listSettlementCases()).toHaveLength(1);
      expect(() =>
        lifecycle.recordSettlementMeasurementFailure(new Error("late")),
      ).toThrow("worktree lifecycle service is stopped");
      const writes = [
        () => lifecycle.openSettlementCase(agent, worktree, null),
        () => lifecycle.updateSettlementDebt(),
        () =>
          lifecycle.settleTeardownWorktree({
            agent,
            updated: agent,
            capture,
            at: "2026-08-12T12:05:00.000Z",
            removeWorktree: false,
          }),
        () => lifecycle.reconcileOrphanedWorktrees(),
        () => lifecycle.releaseSalvageableRef("refs/hive-salvage/late"),
        () => lifecycle.keepSalvageableRef("refs/hive-salvage/late"),
        () =>
          lifecycle.mintDestructiveDecision({
            caseId: "0".repeat(32),
            revision: 1,
            evidenceDigest: "0".repeat(64),
            reason: "late decision",
            expiresAt: "2026-08-12T12:06:00.000Z",
            decisionOwner: "user",
          }),
        () => lifecycle.executeDestructiveDecision("0".repeat(32), "queen"),
        () => lifecycle.onLanded(agent, "a".repeat(40)),
        () => lifecycle.settleFailedSpawn(agent, worktree, true),
      ];
      for (const write of writes) {
        await expect(write()).rejects.toThrow(
          "worktree lifecycle service is stopped",
        );
      }
      expect(await new SettlementCaseStore(repo).list("main")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("a genuinely empty dead worktree releases without a caller override", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBe(worktree.path);
      expect(existsSync(worktree.path)).toBe(false);
      expect(await git(repo, "branch", "--list", worktree.branch)).toBe("");
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("an unverified liveness instrument keeps the case owned and due", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture("unknown");
    try {
      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBeNull();
      expect(existsSync(worktree.path)).toBe(true);
      const [stored] = await new SettlementCaseStore(repo).list("main");
      expect(stored?.record.state).toBe("measurement-blocked");
      expect(stored?.record.owner).toBe("settlement-service");
      expect(stored?.record.due.nextActionAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("graphify gates and instance-derived Grok hooks are Hive's own and release", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      const claudeHook = graphifyHookPath(worktree.path, ".claude");
      await writeGraphifyHook(claudeHook, "http://127.0.0.1:4321/mcp");
      await writeGrokAgentConfig(worktree.path, {
        daemonPort: 4321,
        graphifyUrl: "http://127.0.0.1:4322/mcp",
        name: "maya",
        providerRunId: crypto.randomUUID(),
      });
      await writeFile(`${claudeHook}.gate`, "");
      await writeFile(`${graphifyHookPath(worktree.path, ".grok")}.gate`, "");

      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBe(worktree.path);
      expect(existsSync(worktree.path)).toBe(false);
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("vendor directory granularity never hides an agent-owned file", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await mkdir(join(worktree.path, ".codex"), { recursive: true });
      await writeFile(
        join(worktree.path, ".codex", "agent-notes.txt"),
        "mine\n",
      );
      await writeFile(
        join(worktree.path, ".git", "info", "exclude"),
        ".codex/\n",
      ).catch(async () => {
        const gitDir = await git(worktree.path, "rev-parse", "--git-dir");
        await mkdir(join(gitDir, "info"), { recursive: true });
        await writeFile(join(gitDir, "info", "exclude"), ".codex/\n");
      });
      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBeNull();
      expect(result.stranded?.dirtyFiles).toContain(".codex/agent-notes.txt");
      expect(existsSync(worktree.path)).toBe(true);
      const [stored] = await new SettlementCaseStore(repo).list("main");
      expect(stored?.record.state).toBe("needs-integration");
    } finally {
      db.close();
    }
  });

  test("an agent file under a genuinely excluded vendor directory is named, then released", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      // The exclusion has to live in the common directory: git reads $GIT_COMMON_DIR/info/exclude
      // for a linked worktree and never the linked gitdir's own copy.
      await mkdir(join(repo, ".git", "info"), { recursive: true });
      await writeFile(join(repo, ".git", "info", "exclude"), ".codex/\n");
      await mkdir(join(worktree.path, ".codex"), { recursive: true });
      await writeFile(
        join(worktree.path, ".codex", "agent-notes.txt"),
        "mine\n",
      );

      const [stored] = await new SettlementCaseStore(repo).list("main");
      if (stored === undefined) throw new Error("missing settlement case");
      const proof = await measureAutomaticRelease(
        { repoRoot: repo, processLiveness: async () => "dead" },
        stored.record,
        agent,
        "main",
      );
      // The owner ruled that an ignore rule decides what is work. The record must still name the
      // file release destroys, so the cost of that ruling is never invisible.
      expect(proof.kind).toBe("safe");
      expect(proof.snapshot?.regenerable).toContain(".codex/agent-notes.txt");

      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBe(worktree.path);
      expect(existsSync(worktree.path)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("generated-directory patterns never hide a file created after launch", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await mkdir(join(worktree.path, ".dev"), { recursive: true });
      await writeFile(join(worktree.path, ".dev", "agent-notes.txt"), "mine\n");
      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBeNull();
      expect(result.stranded?.dirtyFiles).toContain(".dev/agent-notes.txt");
      expect(existsSync(worktree.path)).toBe(true);
      const [stored] = await new SettlementCaseStore(repo).list("main");
      expect(stored?.record.state).toBe("needs-integration");
    } finally {
      db.close();
    }
  });

  test("build output created after launch releases the bundle it never blocked", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await mkdir(join(repo, ".git", "info"), { recursive: true });
      await writeFile(join(repo, ".git", "info", "exclude"), ".dev/\n");
      await mkdir(join(worktree.path, ".dev"), { recursive: true });
      await writeFile(join(worktree.path, ".dev", "cache.json"), "{}\n");

      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBe(worktree.path);
      expect(result.stranded).toBeNull();
      expect(result.preserved).toBeNull();
      expect(existsSync(worktree.path)).toBe(false);
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
      expect(await listStewardshipRefs(repo)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("the case names the ignored inventory before any release is authorized", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await mkdir(join(repo, ".git", "info"), { recursive: true });
      await writeFile(join(repo, ".git", "info", "exclude"), ".dev/\n");
      await mkdir(join(worktree.path, ".dev"), { recursive: true });
      await writeFile(join(worktree.path, ".dev", "cache.json"), "{}\n");
      // Unignored work of the agent's own keeps the case open, so the record stays readable.
      await writeFile(join(worktree.path, "wip.ts"), "export {};\n");

      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBeNull();
      const [stored] = await new SettlementCaseStore(repo).list("main");
      expect(stored?.record.state).toBe("needs-integration");
      expect(stored?.record.regenerable).toEqual([".dev/cache.json"]);
    } finally {
      db.close();
    }
  });

  test("an ignored directory holding only empty directories measures and releases", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await mkdir(join(repo, ".git", "info"), { recursive: true });
      await writeFile(join(repo, ".git", "info", "exclude"), ".dev/\n");
      await mkdir(join(worktree.path, ".dev", "tmp"), { recursive: true });

      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBe(worktree.path);
      expect(existsSync(worktree.path)).toBe(false);
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a nested repository inside an ignored directory is named and released, not blocked forever", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await mkdir(join(repo, ".git", "info"), { recursive: true });
      await writeFile(join(repo, ".git", "info", "exclude"), ".dev/\n");
      await mkdir(join(worktree.path, ".dev", "landing-proof", "source"), {
        recursive: true,
      });
      await git(join(worktree.path, ".dev", "landing-proof", "source"), "init");

      const [stored] = await new SettlementCaseStore(repo).list("main");
      if (stored === undefined) throw new Error("missing settlement case");
      const proof = await measureAutomaticRelease(
        {
          repoRoot: repo,
          processLiveness: async () => "dead",
        },
        stored.record,
        agent,
        "main",
      );
      expect(proof.kind).toBe("safe");
      expect(proof.snapshot?.residue).toEqual([]);
      expect(proof.snapshot?.regenerable).toContain(
        ".dev/landing-proof/source/",
      );

      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBe(worktree.path);
      expect(existsSync(worktree.path)).toBe(false);
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("tracked, staged and untracked content blocks release while ignored output is recorded", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "README.md"), "changed\n");
      await writeFile(join(worktree.path, ".gitignore"), "ignored.txt\n");
      await writeFile(join(worktree.path, "staged.txt"), "staged\n");
      await git(worktree.path, "add", ".gitignore", "staged.txt");
      await writeFile(join(worktree.path, "untracked.txt"), "untracked\n");
      await writeFile(join(worktree.path, "ignored.txt"), "ignored\n");

      const [stored] = await new SettlementCaseStore(repo).list("main");
      if (stored === undefined) throw new Error("missing settlement case");
      const proof = await measureAutomaticRelease(
        {
          repoRoot: repo,
          processLiveness: async () => "dead",
        },
        stored.record,
        agent,
        "main",
      );
      expect(proof.kind).toBe("kept");
      expect(proof.snapshot?.residue).toEqual([
        ".gitignore",
        "README.md",
        "staged.txt",
        "untracked.txt",
      ]);
      expect(proof.snapshot?.regenerable).toEqual(["ignored.txt"]);

      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBeNull();
      expect(existsSync(worktree.path)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("detached HEAD is unprovable and never releases", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await git(worktree.path, "checkout", "--detach");
      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBeNull();
      expect(existsSync(worktree.path)).toBe(true);
      const [stored] = await new SettlementCaseStore(repo).list("main");
      expect(stored?.record.state).toBe("measurement-blocked");
    } finally {
      db.close();
    }
  });

  test("an in-progress git operation keeps the case in settling", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      const gitDir = await git(
        worktree.path,
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
      );
      await mkdir(join(gitDir, "rebase-merge"));

      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBeNull();
      expect(existsSync(worktree.path)).toBe(true);
      const [stored] = await new SettlementCaseStore(repo).list("main");
      expect(stored?.record.state).toBe("settling");
    } finally {
      db.close();
    }
  });

  test("residue appearing during proof revalidation prevents release", async () => {
    let livenessReads = 0;
    let latePath: string | null = null;
    const testFixture = await fixture(async () => {
      livenessReads += 1;
      if (livenessReads === 2 && latePath !== null) {
        await writeFile(latePath, "late residue\n");
      }
      return "dead";
    });
    const { worktree, db, agent, lifecycle } = testFixture;
    latePath = join(worktree.path, "late.txt");
    try {
      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBeNull();
      expect(livenessReads).toBe(2);
      expect(existsSync(worktree.path)).toBe(true);
      expect(existsSync(latePath)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("case revision drift during proof revalidation prevents release", async () => {
    let livenessReads = 0;
    let mutateCase: (() => Promise<void>) | null = null;
    const testFixture = await fixture(async () => {
      livenessReads += 1;
      if (livenessReads === 2) await mutateCase?.();
      return "dead";
    });
    const { repo, worktree, db, agent, lifecycle } = testFixture;
    const cases = new SettlementCaseStore(repo);
    mutateCase = async () => {
      const [current] = await cases.list("main");
      if (current === undefined) throw new Error("missing settlement case");
      await cases.update(current, {
        ...current.record,
        reason: "concurrent settlement update",
      });
    };
    try {
      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBeNull();
      expect(livenessReads).toBe(2);
      expect(existsSync(worktree.path)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a worktree proven absent is measured as gone, not as an unreadable instrument", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      // Both instruments that could name this worktree now answer "nothing here": the directory
      // and its registration. Before, requiring exactly one registration read that as a broken
      // instrument and the case could never leave measurement-blocked.
      await git(repo, "worktree", "remove", "--force", worktree.path);
      expect(existsSync(worktree.path)).toBe(false);
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(
        worktree.path,
      );

      const result = await settle(lifecycle, agent);
      expect(result.cleaned.branch).toBe(worktree.branch);
      expect(await git(repo, "branch", "--list", worktree.branch)).toBe("");
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a case whose worktree and branch are both gone settles instead of blocking", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await git(repo, "worktree", "remove", "--force", worktree.path);
      await git(repo, "branch", "-D", worktree.branch);

      const [stored] = await new SettlementCaseStore(repo).list("main");
      if (stored === undefined) throw new Error("missing settlement case");
      const proof = await measureAutomaticRelease(
        { repoRoot: repo, processLiveness: async () => "dead" },
        stored.record,
        agent,
        "main",
      );
      expect(proof.kind).toBe("safe");
      expect(proof.snapshot?.accountedBy).toBe("nothing-remains");

      const result = await settle(lifecycle, agent);
      expect(result.stranded).toBeNull();
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a gone bundle still holding a stewardship ref is not treated as empty", async () => {
    const { repo, worktree, db, agent } = await fixture();
    try {
      const tip = await git(repo, "rev-parse", worktree.branch);
      await git(
        repo,
        "update-ref",
        `refs/hive-salvage/${worktree.branch}`,
        tip,
      );
      await git(repo, "worktree", "remove", "--force", worktree.path);
      await git(repo, "branch", "-D", worktree.branch);
      const cases = new SettlementCaseStore(repo);
      const [opened] = await cases.list("main");
      if (opened === undefined) throw new Error("missing settlement case");
      await cases.update(opened, {
        ...opened.record,
        salvageRef: `refs/hive-salvage/${worktree.branch}`,
      });

      const [stored] = await cases.list("main");
      if (stored === undefined) throw new Error("missing settlement case");
      const proof = await measureAutomaticRelease(
        { repoRoot: repo, processLiveness: async () => "dead" },
        stored.record,
        agent,
        "main",
      );
      expect(proof.kind).toBe("kept");
      expect(proof.snapshot?.accountedBy).toBeNull();
      expect(
        await git(repo, "rev-parse", `refs/hive-salvage/${worktree.branch}`),
      ).toBe(tip);
    } finally {
      db.close();
    }
  });

  test("a branch that exists but proves no owner is never deleted on a guess", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await git(repo, "worktree", "remove", "--force", worktree.path);
      for (const ref of (
        await git(
          repo,
          "for-each-ref",
          "--format=%(refname)",
          "refs/hive-owner/**",
        )
      ).split("\n")) {
        if (ref !== "") await git(repo, "update-ref", "-d", ref);
      }

      const result = await settle(lifecycle, agent);
      expect(result.cleaned.branch).toBeNull();
      expect(await git(repo, "branch", "--list", worktree.branch)).not.toBe("");
      const [stored] = await new SettlementCaseStore(repo).list("main");
      expect(stored?.record.state).toBe("needs-integration");
      expect(stored?.record.reason).toContain("branch ownership is unprovable");
      expect(stored?.record.evidenceDigest).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("a branch-only case whose commits are already on main by patch releases", async () => {
    const { repo, db, lifecycle } = await fixture();
    const landed = await createWorktree(repo, "elmer", "integrate");
    try {
      await writeFile(join(landed.path, "landed.txt"), "work\n");
      await git(landed.path, "add", "landed.txt");
      await git(landed.path, "commit", "-m", "work that landed");
      const tip = await git(landed.path, "rev-parse", "HEAD");
      await git(repo, "worktree", "remove", "--force", landed.path);
      // Squashed and rebased landings are how work reaches main here: the change is on main under
      // a new sha, so the branch is not an ancestor of it and never will be. Main moves first, or
      // the replay would reproduce the original commit byte for byte and prove nothing.
      await writeFile(join(repo, "other.txt"), "elsewhere\n");
      await git(repo, "add", "other.txt");
      await git(repo, "commit", "-m", "unrelated landing");
      await git(repo, "cherry-pick", tip);
      expect(
        await git(repo, "rev-list", "--count", `main..${landed.branch}`),
      ).toBe("1");
      expect(
        await git(
          repo,
          "rev-list",
          "--count",
          "--cherry-pick",
          "--right-only",
          `main...${landed.branch}`,
        ),
      ).toBe("0");

      await lifecycle.reconcileOrphanedWorktrees();
      expect(await git(repo, "branch", "--list", landed.branch)).toBe("");
      const open = await new SettlementCaseStore(repo).list("main");
      expect(open.map(({ record }) => record.branch)).not.toContain(
        landed.branch,
      );
    } finally {
      db.close();
    }
  });

  test("a branch-only case still holding unlanded work stays with its resolver", async () => {
    const { repo, db, lifecycle } = await fixture();
    const stranded = await createWorktree(repo, "elmer", "integrate");
    try {
      await writeFile(join(stranded.path, "unlanded.txt"), "work\n");
      await git(stranded.path, "add", "unlanded.txt");
      await git(stranded.path, "commit", "-m", "work nobody landed");
      await git(repo, "worktree", "remove", "--force", stranded.path);

      await lifecycle.reconcileOrphanedWorktrees();
      expect(await git(repo, "branch", "--list", stranded.branch)).not.toBe("");
      const [open] = (await new SettlementCaseStore(repo).list("main")).filter(
        ({ record }) => record.branch === stranded.branch,
      );
      expect(open?.record.state).toBe("needs-integration");
      expect(open?.record.reason).toBe(
        "1 commit(s) are not accounted for on main",
      );
    } finally {
      db.close();
    }
  });

  test("a target branch change remeasures the case before rendering its reason", async () => {
    const { repo, worktree, db, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "first.txt"), "first\n");
      await git(worktree.path, "add", "first.txt");
      await git(worktree.path, "commit", "-m", "first unlanded commit");
      const first = await git(worktree.path, "rev-parse", "HEAD");
      await writeFile(join(worktree.path, "second.txt"), "second\n");
      await git(worktree.path, "add", "second.txt");
      await git(worktree.path, "commit", "-m", "second unlanded commit");
      const second = await git(worktree.path, "rev-parse", "HEAD");
      await git(repo, "branch", "dev", first);

      // The two targets deliberately disagree. If the sweep only rewrites the sentence,
      // it will say dev while retaining main's two-commit evidence.
      expect(
        await git(repo, "rev-list", "--count", `main..${worktree.branch}`),
      ).toBe("2");
      expect(
        await git(repo, "rev-list", "--count", `dev..${worktree.branch}`),
      ).toBe("1");

      await lifecycle.reconcileOrphanedWorktrees();
      const cases = new SettlementCaseStore(repo);
      const [measuredOnMain] = await cases.list("main");
      expect(measuredOnMain?.record.residue?.targetRef).toBe("refs/heads/main");
      expect(
        measuredOnMain?.record.residue?.unaccountedCommitOids,
      ).toHaveLength(2);

      await git(repo, "checkout", "dev");
      await lifecycle.reconcileOrphanedWorktrees();

      const [measuredOnDev] = await cases.list("dev");
      expect(measuredOnDev?.record.residue?.targetRef).toBe("refs/heads/dev");
      expect(measuredOnDev?.record.residue?.targetOid).toBe(first);
      expect(measuredOnDev?.record.residue?.unaccountedCommitOids).toEqual([
        second,
      ]);
      expect(measuredOnDev?.record.reason).toBe(
        "1 commit(s) are not accounted for on dev",
      );
    } finally {
      db.close();
    }
  });

  test("target movement refreshes an owner decision without closing it", async () => {
    const { repo, worktree, db, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "work.txt"), "work\n");
      await git(worktree.path, "add", "work.txt");
      await git(worktree.path, "commit", "-m", "work awaiting integration");
      const tip = await git(worktree.path, "rev-parse", "HEAD");

      await lifecycle.reconcileOrphanedWorktrees();
      const cases = new SettlementCaseStore(repo);
      const [measured] = await cases.list("main");
      if (measured === undefined || measured.record.residue === null) {
        throw new Error("missing measured settlement case");
      }
      expect(measured.record.residue.unaccountedCommitOids).toEqual([tip]);
      const held = await cases.update(measured, {
        ...measured.record,
        state: "owner-decision",
        owner: "user",
        reason:
          "1 commit(s) are not accounted for on main; only an owner decision can settle it",
        due: { nextActionAt: null, watchedTrigger: "owner-decision" },
        blockedOn: null,
        reviewAt: null,
        proofDigest: null,
      });

      // Landing the exact commit makes a stale read maximally loud: the old evidence says one
      // commit is unaccounted, while a fresh measurement says none is.
      await git(repo, "merge", "--ff-only", worktree.branch);
      expect(
        await git(repo, "rev-list", "--count", `main..${worktree.branch}`),
      ).toBe("0");

      await lifecycle.reconcileOrphanedWorktrees();

      const refreshed = await cases.read(held.record.caseId);
      expect(refreshed?.record.revision).toBeGreaterThan(held.record.revision);
      expect(refreshed?.record.state).toBe("owner-decision");
      expect(refreshed?.record.owner).toBe("user");
      expect(refreshed?.record.residue?.targetRef).toBe("refs/heads/main");
      expect(refreshed?.record.residue?.targetOid).toBe(tip);
      expect(refreshed?.record.residue?.unaccountedCommitOids).toEqual([]);
      expect(refreshed?.record.reason).toBe(
        "exact content accounted for on main; owner decision retained after target remeasurement",
      );
    } finally {
      db.close();
    }
  });

  test("a failed target remeasurement marks owner evidence stale and undecidable", async () => {
    const { repo, worktree, db, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "notes.txt"), "reviewed residue\n");
      await lifecycle.reconcileOrphanedWorktrees();
      const cases = new SettlementCaseStore(repo);
      const [measured] = await cases.list("main");
      if (
        measured === undefined ||
        measured.record.residue === null ||
        measured.record.evidenceDigest === null
      ) {
        throw new Error("missing measured settlement case");
      }
      const held = await cases.update(measured, {
        ...measured.record,
        state: "owner-decision",
        owner: "user",
        reason: "the owner is reviewing notes.txt",
        due: { nextActionAt: null, watchedTrigger: "owner-decision" },
        blockedOn: null,
        reviewAt: null,
        proofDigest: null,
      });

      await writeFile(join(repo, "target-moved.txt"), "new target tip\n");
      await git(repo, "add", "target-moved.txt");
      await git(repo, "commit", "-m", "move the landing target");
      const movedTargetOid = await git(repo, "rev-parse", "main");
      expect(held.record.residue?.targetOid).not.toBe(movedTargetOid);
      const gitDir = await git(
        worktree.path,
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
      );
      await mkdir(join(gitDir, "rebase-merge"));

      await lifecycle.reconcileOrphanedWorktrees();

      const stale = await cases.read(held.record.caseId);
      expect(stale?.record.state).toBe("owner-decision");
      expect(stale?.record.residue).toEqual(held.record.residue);
      expect(stale?.record.evidenceDigest).toBeNull();
      expect(stale?.record.evidenceFormat).toBeNull();
      expect(stale?.record.reason).toBe(
        "settlement evidence is stale after the landing target moved to main; remeasurement failed: git operation is in progress",
      );
      await expect(
        lifecycle.mintDestructiveDecision({
          caseId: held.record.caseId,
          revision: held.record.revision,
          evidenceDigest: measured.record.evidenceDigest,
          reason: "the user reviewed and chose to discard notes.txt",
          expiresAt: "2026-08-12T12:06:00.000Z",
          decisionOwner: "user",
        }),
      ).rejects.toThrow(
        "no evidence digest and cannot be decided until remeasured",
      );
    } finally {
      db.close();
    }
  });

  test("reconciler eligibility is released only through the settlement proof", async () => {
    const { repo, worktree, db, lifecycle } = await fixture(
      "dead",
      () => new Date(Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1),
    );
    try {
      const report = await lifecycle.reconcileOrphanedWorktrees();
      expect(
        report.worktrees.find((entry) => entry.path === worktree.path),
      ).toMatchObject({ action: "released" });
      expect(existsSync(worktree.path)).toBe(false);
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a missing agent row reaches owner decision once and stops re-measuring", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture(
      "dead",
      () => new Date(Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1),
    );
    try {
      expect(deleteAgentRow(db, agent.id)).toBe(true);
      const report = await lifecycle.reconcileOrphanedWorktrees();
      expect(
        report.worktrees.find((entry) => entry.path === worktree.path),
      ).toMatchObject({ action: "kept", rule: "assessment-failed" });
      expect(existsSync(worktree.path)).toBe(true);
      const cases = new SettlementCaseStore(repo);
      const [first] = await cases.list("main");
      if (first === undefined) throw new Error("missing settlement case");

      await lifecycle.reconcileOrphanedWorktrees();
      const [second] = await cases.list("main");
      if (second === undefined) throw new Error("missing settlement case");

      expect(second.record.revision).toBe(first.record.revision);
      expect(first.record.agentId).toBe(agent.id);
      expect(first.record.state).toBe("owner-decision");
      expect(first.record.owner).toBe("user");
      expect(first.record.due).toEqual({
        nextActionAt: null,
        watchedTrigger: "owner-decision",
      });
      expect(first.record.evidenceFormat).toBe("disposition-v1");
      expect(first.record.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(first.record.residue).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("unknown liveness retries when the measurement can still change", async () => {
    let liveness: FixtureLiveness = "unknown";
    let livenessReads = 0;
    const { repo, worktree, db, lifecycle } = await fixture(
      async () => {
        livenessReads += 1;
        return liveness;
      },
      () => new Date(Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1),
    );
    try {
      await lifecycle.reconcileOrphanedWorktrees();
      const [blocked] = await new SettlementCaseStore(repo).list("main");
      if (blocked === undefined) throw new Error("missing settlement case");
      expect(blocked.record.state).toBe("measurement-blocked");
      expect(blocked.record.due.nextActionAt).not.toBeNull();
      const readsWhileBlocked = livenessReads;

      liveness = "dead";
      await lifecycle.reconcileOrphanedWorktrees();

      expect(livenessReads).toBeGreaterThan(readsWhileBlocked);
      expect(existsSync(worktree.path)).toBe(false);
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a landing receipt naming work that is not the case's own never accounts for it", async () => {
    const { repo, worktree, db, agent } = await fixture();
    try {
      await writeFile(join(worktree.path, "unlanded.txt"), "work\n");
      await git(worktree.path, "add", "unlanded.txt");
      await git(worktree.path, "commit", "-m", "work nobody landed");
      // Another branch's commit, genuinely on the landing target. A receipt asserting it is both
      // the source and the target says "this case's work is exactly the target tip" — which reads
      // as accounted-for unless the proof checks that the receipt names THIS case's work. It is
      // what a receipt written from a branch ref already reset to the target records, and it is
      // the shape found live on agent horace's case: source == target == another branch's commit.
      await writeFile(join(repo, "elsewhere.txt"), "someone else's landing\n");
      await git(repo, "add", "elsewhere.txt");
      await git(repo, "commit", "-m", "another branch's landing");
      const foreignOid = await git(repo, "rev-parse", "main");
      const ownOid = await git(worktree.path, "rev-parse", "HEAD");
      expect(foreignOid).not.toBe(ownOid);

      const cases = new SettlementCaseStore(repo);
      const measureWithReceipt = async () => {
        const [open] = await cases.list("main");
        if (open === undefined) throw new Error("missing settlement case");
        const updated = await cases.update(open, {
          ...open.record,
          landingReceipt: {
            sourceOid: foreignOid,
            targetOid: foreignOid,
            targetBranch: "main",
            recordedAt: "2026-08-12T12:04:00.000Z",
          },
        });
        return measureAutomaticRelease(
          { repoRoot: repo, processLiveness: async () => "dead" },
          updated.record,
          agent,
          "main",
        );
      };

      const wrong = await measureWithReceipt();
      expect(wrong.kind).toBe("kept");
      expect(wrong.snapshot?.accountedBy).toBeNull();

      // Positive control: the same case, same receipt, releases once its own commit genuinely
      // reaches the target. Without this the assertion above would hold just as well if this
      // worktree could never be released for any reason. The accounting reason is the unlanded
      // count rather than the receipt, because a source the receipt could vouch for has to be
      // accounted for on the target already, and that is the question the count just answered.
      await git(repo, "cherry-pick", ownOid);
      const right = await measureWithReceipt();
      expect(right.kind).toBe("safe");
      expect(right.snapshot?.accountedBy).toBe("unlanded-count");
    } finally {
      db.close();
    }
  });

  test("the sweep reaches an open case that no branch, worktree or ref still names", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture(
      "dead",
      () => new Date(Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1),
    );
    try {
      // The bundle is gone in every direction at once: no directory, no registration, no branch,
      // no stewardship ref. Only the case survives, holding a stale instrument failure recorded
      // while the worktree still existed. Each sweep pass is driven by something the live world
      // still names, so a case it names nothing of is reached by none of them and keeps that
      // reason forever — the settlement service breaking its own rule that no open case may lack
      // a trigger that fires.
      await git(repo, "worktree", "remove", "--force", worktree.path);
      await git(repo, "branch", "-D", worktree.branch);
      db.upsertAgent({ ...agent, worktreePath: null, branch: null });

      const cases = new SettlementCaseStore(repo);
      const [opened] = await cases.list("main");
      if (opened === undefined) throw new Error("missing settlement case");
      const blocked = await cases.update(opened, {
        ...opened.record,
        state: "measurement-blocked",
        owner: "settlement-service",
        reason: "an instrument failed while the worktree was still there",
      });
      // Positive control: the reader that must later report this case gone can see it now, so an
      // empty list at the end is a settlement rather than a reader that never found anything.
      expect(blocked.record.state).toBe("measurement-blocked");

      await lifecycle.reconcileOrphanedWorktrees();

      expect(await cases.list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("an owner decision is revision-bound and invalidated by residue drift", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "notes.txt"), "reviewed residue\n");
      const result = await settle(lifecycle, agent);
      expect(result.cleaned.worktreePath).toBeNull();
      const [stored] = await new SettlementCaseStore(repo).list("main");
      expect(stored?.record.state).toBe("needs-integration");
      expect(stored?.record.evidenceDigest).not.toBeNull();
      if (stored?.record.evidenceDigest === null || stored === undefined) {
        throw new Error("settlement case has no measured evidence");
      }
      await writeFile(join(repo, "unrelated.txt"), "first landing\n");
      await git(repo, "add", "unrelated.txt");
      await git(repo, "commit", "-m", "unrelated landing before decision");
      await expect(
        lifecycle.mintDestructiveDecision({
          caseId: stored.record.caseId,
          revision: stored.record.revision,
          evidenceDigest: "0".repeat(64),
          reason: "the user reviewed and chose to discard notes.txt",
          expiresAt: "2026-08-12T12:06:00.000Z",
          decisionOwner: "user",
        }),
      ).rejects.toThrow("revision or evidence digest changed");
      const decision = await lifecycle.mintDestructiveDecision({
        caseId: stored.record.caseId,
        revision: stored.record.revision,
        evidenceDigest: stored.record.evidenceDigest,
        reason: "the user reviewed and chose to discard notes.txt",
        expiresAt: "2026-08-12T12:06:00.000Z",
        decisionOwner: "user",
      });
      expect(decision.residue).toEqual(["notes.txt"]);

      await writeFile(join(repo, "later.txt"), "second landing\n");
      await git(repo, "add", "later.txt");
      await git(repo, "commit", "-m", "unrelated landing after decision");
      await writeFile(join(worktree.path, "late.txt"), "not reviewed\n");
      await expect(
        lifecycle.executeDestructiveDecision(decision.decisionId, "queen"),
      ).rejects.toThrow("evidence changed");
      expect(existsSync(worktree.path)).toBe(true);

      await rm(join(worktree.path, "late.txt"));
      const executed = await lifecycle.executeDestructiveDecision(
        decision.decisionId,
        "queen",
      );
      expect(executed.executedBy).toBe("queen");
      expect(executed.removedPaths).toEqual([worktree.path]);
      expect(existsSync(worktree.path)).toBe(false);
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a case with no measured evidence digest is refused by name, not remeasured", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "notes.txt"), "reviewed residue\n");
      await settle(lifecycle, agent);
      const cases = new SettlementCaseStore(repo);
      const [measured] = await cases.list("main");
      if (measured?.record.evidenceDigest === null || measured === undefined) {
        throw new Error("settlement case has no measured evidence");
      }
      // Positive control: with its measured digest, the identical case mints. The
      // refusal asserted below is specific to the null digest, not a fixture that
      // could never mint at all.
      const decision = await lifecycle.mintDestructiveDecision({
        caseId: measured.record.caseId,
        revision: measured.record.revision,
        evidenceDigest: measured.record.evidenceDigest,
        reason: "the user reviewed and chose to discard notes.txt",
        expiresAt: "2026-08-12T12:06:00.000Z",
        decisionOwner: "user",
      });
      expect(decision.evidenceDigest).toBe(measured.record.evidenceDigest);

      // A case can carry a null digest between measurements (evidenceFormat migration,
      // an in-flight remeasurement). Minting must refuse it by name so "unmeasured" is
      // never reported as the generic "revision or evidence digest changed".
      const [unmeasured] = await cases.list("main");
      if (unmeasured === undefined) throw new Error("missing settlement case");
      await cases.update(unmeasured, {
        ...unmeasured.record,
        evidenceDigest: null,
        evidenceFormat: null,
      });
      await expect(
        lifecycle.mintDestructiveDecision({
          caseId: unmeasured.record.caseId,
          revision: unmeasured.record.revision,
          evidenceDigest: "0".repeat(64),
          reason: "the user reviewed and chose to discard notes.txt",
          expiresAt: "2026-08-12T12:06:00.000Z",
          decisionOwner: "user",
        }),
      ).rejects.toThrow(
        "no evidence digest and cannot be decided until remeasured",
      );
    } finally {
      db.close();
    }
  });

  test("an accounting verdict change invalidates the listed digest", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "work.txt"), "unlanded work\n");
      await git(worktree.path, "add", "work.txt");
      await git(worktree.path, "commit", "-m", "work awaiting integration");
      const tip = await git(worktree.path, "rev-parse", "HEAD");
      await writeFile(join(worktree.path, "notes.txt"), "reviewed residue\n");
      await settle(lifecycle, agent);
      const [listed] = await lifecycle.listSettlementCases();
      if (listed?.evidenceDigest === null || listed === undefined) {
        throw new Error("listed settlement case has no measured evidence");
      }

      await git(repo, "cherry-pick", tip);
      await expect(
        lifecycle.mintDestructiveDecision({
          caseId: listed.caseId,
          revision: listed.revision,
          evidenceDigest: listed.evidenceDigest,
          reason: "the user reviewed the unlanded commit and residue",
          expiresAt: "2026-08-12T12:06:00.000Z",
          decisionOwner: "user",
        }),
      ).rejects.toThrow("settlement evidence changed before decision minting");
      expect(existsSync(worktree.path)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a sweep replaces legacy evidence before the case is offered for decision", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture(
      "dead",
      () => new Date(Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1),
    );
    try {
      await writeFile(join(worktree.path, "notes.txt"), "reviewed residue\n");
      await settle(lifecycle, agent);
      const cases = new SettlementCaseStore(repo);
      const [measured] = await cases.list("main");
      if (measured === undefined) throw new Error("missing settlement case");
      const legacyDigest = "0".repeat(64);
      await cases.update(measured, {
        ...measured.record,
        evidenceDigest: legacyDigest,
        evidenceFormat: null,
      });

      await lifecycle.reconcileOrphanedWorktrees();
      const [listed] = await lifecycle.listSettlementCases();
      expect(listed?.evidenceFormat).toBe("disposition-v1");
      expect(listed?.evidenceDigest).not.toBe(legacyDigest);
    } finally {
      db.close();
    }
  });

  test("an unowned branch mints and executes only through a listed owner decision", async () => {
    const { repo, worktree, db, lifecycle } = await fixture();
    try {
      await git(repo, "worktree", "remove", "--force", worktree.path);
      await git(
        repo,
        "update-ref",
        "-d",
        `refs/hive-owner/${hiveInstanceSuffix()}/${worktree.branch}`,
      );
      await lifecycle.reconcileOrphanedWorktrees();
      const [listed] = (await lifecycle.listSettlementCases()).filter(
        (candidate) => candidate.branch === worktree.branch,
      );
      if (listed?.evidenceDigest === null || listed === undefined) {
        throw new Error("unowned settlement case has no measured evidence");
      }

      const decision = await lifecycle.mintDestructiveDecision({
        caseId: listed.caseId,
        revision: listed.revision,
        evidenceDigest: listed.evidenceDigest,
        reason: "the user approved discarding the unowned branch",
        expiresAt: "2026-08-12T12:06:00.000Z",
        decisionOwner: "user",
      });
      const executed = await lifecycle.executeDestructiveDecision(
        decision.decisionId,
        "queen",
      );

      expect(executed.executedBy).toBe("queen");
      expect(await git(repo, "branch", "--list", worktree.branch)).toBe("");
      expect(await new SettlementCaseStore(repo).list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("acquiring an owner invalidates an unowned branch decision", async () => {
    const { repo, worktree, db, lifecycle } = await fixture();
    try {
      await git(repo, "worktree", "remove", "--force", worktree.path);
      await git(
        repo,
        "update-ref",
        "-d",
        `refs/hive-owner/${hiveInstanceSuffix()}/${worktree.branch}`,
      );
      await lifecycle.reconcileOrphanedWorktrees();
      const [listed] = (await lifecycle.listSettlementCases()).filter(
        (candidate) => candidate.branch === worktree.branch,
      );
      if (listed?.evidenceDigest === null || listed === undefined) {
        throw new Error("unowned settlement case has no measured evidence");
      }
      const decision = await lifecycle.mintDestructiveDecision({
        caseId: listed.caseId,
        revision: listed.revision,
        evidenceDigest: listed.evidenceDigest,
        reason: "the user approved discarding the unowned branch",
        expiresAt: "2026-08-12T12:06:00.000Z",
        decisionOwner: "user",
      });

      await git(
        repo,
        "update-ref",
        `refs/hive-owner/sibling-instance/${worktree.branch}`,
        worktree.branch,
      );
      await expect(
        lifecycle.executeDestructiveDecision(decision.decisionId, "queen"),
      ).rejects.toThrow("settlement evidence changed");
      expect(await git(repo, "branch", "--list", worktree.branch)).not.toBe("");
    } finally {
      db.close();
    }
  });

  test("stale owner refs are released only through the settlement boundary", async () => {
    const { repo, db, lifecycle } = await fixture();
    try {
      const staleBranch = "hive/stale-owner-proof";
      const staleRef = `refs/hive-owner/${hiveInstanceSuffix()}/${staleBranch}`;
      await git(repo, "update-ref", staleRef, "main");

      await lifecycle.reconcileOrphanedWorktrees();

      await expect(
        git(repo, "show-ref", "--verify", staleRef),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });
});
