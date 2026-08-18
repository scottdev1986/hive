import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeGrokAgentConfig } from "../../src/adapters/providers/grok-cli";
import { getAgentAdapter } from "../../src/adapters/providers/provider-registry";
import { provisionSkills } from "../../src/adapters/skills";
import {
  assessStrandedWork,
  createWorktree,
  listSettlementBranches,
  listStaleOwnerRefs,
  listWorktrees,
  markBranchPreserved,
  observedWorktreeFiles,
  reconcileOrphanedWorktrees,
  slugify,
  WORKTREE_SETTLING_INTERVAL_MS,
} from "../../src/adapters/worktrees";
import { hiveInstanceSuffix } from "../../src/hive-home/home";
import type { AgentRecord } from "../../src/schemas/agent";
import { CAPABILITY_PROVIDERS } from "../../src/schemas/capability";
import { errorMessage } from "../../src/shared/error-message";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";
import { releaseTestWorktree as removeWorktree } from "../support/worktree-cleanup";

let tempRoot = "";
let repoRoot = "";
let previousHiveHome: string | undefined;

async function git(...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", repoRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim());
  }
  return stdout.trim();
}

/** Runs git inside a worktree rather than the repo root. */
async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim());
  }
  return stdout.trim();
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-worktrees-"));
  repoRoot = join(tempRoot, "repo");
  await writeFile(join(tempRoot, ".keep"), "");

  await mkdir(repoRoot, { recursive: true });

  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");

  await git("init", "-b", "main");
  await git("config", "user.name", "Hive Test");
  await git("config", "user.email", "hive@example.test");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await git("add", "README.md");
  await git("commit", "-m", "initial");
});

afterAll(async () => {
  if (previousHiveHome === undefined) {
    delete Bun.env.HIVE_HOME;
  } else {
    Bun.env.HIVE_HOME = previousHiveHome;
  }
  if (tempRoot !== "") {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

describe("git worktree manager", () => {
  test("slugifies task names into bounded, non-empty branch components", () => {
    expect(slugify("  Fix OAuth / Callback!  ")).toEqual("fix-oauth-callback");
    expect(slugify("---")).toEqual("task");
    expect(slugify("ABCDEFGHIJKLMNOPQRSTUVWXYZ 1234567890")).toEqual(
      "abcdefghijklmnopqrstuvwxyz-123",
    );
    expect(slugify("Ends----------------After Limit").length <= 30).toEqual(
      true,
    );
  });

  test("creates, lists, and force-removes a worktree with untracked config", async () => {
    const created = await createWorktree(repoRoot, "agent-3", "auth-api");

    expect(created).toEqual({
      path: join(repoRoot, ".hive", "worktrees", "agent-3"),
      branch: "hive/agent-3-auth-api",
    });
    expect(await git("branch", "--show-current")).toEqual("main");

    const listed = await listWorktrees(repoRoot);
    expect(
      listed.some(
        (worktree) =>
          worktree.path.endsWith("/.hive/worktrees/agent-3") &&
          worktree.branch === created.branch,
      ),
    ).toEqual(true);

    await mkdir(join(created.path, ".claude"), { recursive: true });
    await writeFile(
      join(created.path, ".claude", "settings.local.json"),
      "{}\n",
    );

    await removeWorktree(repoRoot, created.path, { deleteBranch: true });
    expect(
      (await listWorktrees(repoRoot)).some(
        (worktree) => worktree.branch === created.branch,
      ),
    ).toEqual(false);
    expect((await git("branch", "--list", created.branch)).trim()).toEqual("");
  });

  test("does not export an unrestricted worktree remover", async () => {
    const adapter = await import("../../src/adapters/worktrees");
    expect("removeWorktree" in adapter).toBe(false);
  });

  test("unregisters and cleans up a branch after manual directory deletion", async () => {
    const created = await createWorktree(repoRoot, "agent-6", "manual-delete");
    await rm(created.path, { recursive: true, force: true });

    await removeWorktree(repoRoot, created.path, { deleteBranch: true });

    expect(
      (await listWorktrees(repoRoot)).some(
        (worktree) => worktree.path === created.path,
      ),
    ).toEqual(false);
    expect((await git("branch", "--list", created.branch)).trim()).toEqual("");
  });

  test("missing-worktree cleanup never unregisters a different missing worktree", async () => {
    const target = await createWorktree(repoRoot, "agent-target", "missing");
    const sibling = await createWorktree(repoRoot, "agent-other", "missing");
    const siblingPath = await realpath(sibling.path);
    await rm(target.path, { recursive: true, force: true });
    await rm(sibling.path, { recursive: true, force: true });

    try {
      await removeWorktree(repoRoot, target.path, { deleteBranch: true });
      expect(await listWorktrees(repoRoot)).toContainEqual({
        path: siblingPath,
        branch: sibling.branch,
      });
    } finally {
      await removeWorktree(repoRoot, sibling.path, {
        deleteBranch: true,
        branch: sibling.branch,
      });
    }
  });

  test("reports no stranded work for a clean, fully merged branch", async () => {
    const created = await createWorktree(repoRoot, "agent-7", "clean-landing");

    expect(
      await assessStrandedWork(repoRoot, created.path, created.branch),
    ).toEqual({ dirtyFiles: [], unmergedCommits: 0 });

    await removeWorktree(repoRoot, created.path, { deleteBranch: true });
  });

  test("work already cherry-picked onto main is not stranded", async () => {
    // The measurement is by patch id, not commit id. A cherry-pick keeps the
    // change and takes a new sha, so counting `main..branch` calls a branch
    // whose work fully landed stranded — and nothing about it ever changes, so
    // that worktree is kept forever and every reap needs a user to investigate.
    const created = await createWorktree(repoRoot, "agent-cherry", "picked");
    await writeFile(join(created.path, "landed.txt"), "the agent's work\n");
    await gitIn(created.path, "add", "-A");
    await gitIn(created.path, "commit", "-m", "the agent's work");
    const agentCommit = (await gitIn(created.path, "rev-parse", "HEAD")).trim();

    // main moves on, then takes the agent's change as a NEW commit.
    await writeFile(join(repoRoot, "unrelated.txt"), "main moved on\n");
    await git("add", "-A");
    await git("commit", "-m", "main moved on");
    await git("cherry-pick", agentCommit);

    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded).toEqual({ dirtyFiles: [], unmergedCommits: 0 });

    // A commit whose change main does NOT have still counts, so the patch-id
    // comparison cannot be used to wave work away.
    await writeFile(join(created.path, "kept.txt"), "not landed anywhere\n");
    await gitIn(created.path, "add", "-A");
    await gitIn(created.path, "commit", "-m", "still unmerged");
    const withUnmerged = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(withUnmerged.unmergedCommits).toBe(1);

    await removeWorktree(repoRoot, created.path, {
      deleteBranch: true,
      discardTracked: true,
    });
  });

  test("hive's own grok wiring is not the agent's work, and never blocks a reap", async () => {
    const created = await createWorktree(repoRoot, "agent-grok", "grok-wiring");
    await writeGrokAgentConfig(created.path, {
      daemonPort: 4711,
      name: "agent-grok",
      providerRunId: "018f1e90-7b5a-7cc0-8000-000000000225",
    });

    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded).toEqual({ dirtyFiles: [], unmergedCommits: 0 });

    // And the exclusion is exactly that one file -- it does not blind the
    // check to anything else under .grok/, which would be a way to lose work.
    await writeFile(join(created.path, ".grok", "notes.md"), "real work\n");
    const withWork = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(withWork.dirtyFiles).toEqual([".grok/notes.md"]);

    await removeWorktree(repoRoot, created.path, {
      deleteBranch: true,
      discardTracked: true,
    });
  });

  test("counts unmerged commits and lists dirty files as stranded work", async () => {
    const created = await createWorktree(repoRoot, "agent-8", "stranded");
    const worktreeGit = async (...args: string[]) => {
      const process = Bun.spawn(["git", "-C", created.path, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(stderr.trim());
      }
    };
    await writeFile(join(created.path, "committed.txt"), "landed nowhere\n");
    await worktreeGit("add", "committed.txt");
    await worktreeGit("commit", "-m", "stranded commit");
    await writeFile(join(created.path, "uncommitted.txt"), "dirty\n");
    await writeFile(join(created.path, "README.md"), "tracked edit\n");

    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded.unmergedCommits).toEqual(1);
    expect(stranded.dirtyFiles.sort()).toEqual([
      "README.md",
      "uncommitted.txt",
    ]);
    expect(
      await observedWorktreeFiles(repoRoot, created.path, created.branch),
    ).toEqual(["README.md", "committed.txt", "uncommitted.txt"]);

    await removeWorktree(repoRoot, created.path, {
      deleteBranch: true,
      discardTracked: true,
    });
  });

  test("marks an unmerged branch as intentionally preserved", async () => {
    const created = await createWorktree(repoRoot, "agent-preserved", "design");
    await writeFile(join(created.path, "design.md"), "kept deliberately\n");
    await git("-C", created.path, "add", "design.md");
    await git("-C", created.path, "commit", "-m", "preserved design");
    await markBranchPreserved(repoRoot, created.branch);
    expect(
      (await listSettlementBranches(repoRoot)).find(
        (entry) => entry.branch === created.branch,
      )?.preserved,
    ).toEqual(true);
    await removeWorktree(repoRoot, created.path, {
      deleteBranch: true,
      discardTracked: true,
    });
  });

  // Measured on the real agent dominic: its worktree directory was already
  // gone and its registration already pruned when the kill arrived, so
  // `git worktree list` had nothing to look up -- and a branch delete that can
  // only see that list deleted nothing, returned success, and left the branch
  // (1 unmerged commit) sitting in the repo while the caller recorded it as
  // removed. The branch the caller passes is the authority.
  test("deletes the branch even when the worktree registration is already gone", async () => {
    const created = await createWorktree(repoRoot, "agent-vanished", "gone");
    await writeFile(join(created.path, "wip.txt"), "unmerged\n");
    await git("-C", created.path, "add", "wip.txt");
    await git("-C", created.path, "commit", "-m", "unmerged wip");

    // The directory disappears and git forgets the worktree ever existed.
    await rm(created.path, { recursive: true, force: true });
    await git("worktree", "prune");
    expect(await listWorktrees(repoRoot)).not.toContainEqual(
      expect.objectContaining({ branch: created.branch }),
    );

    await removeWorktree(repoRoot, created.path, {
      deleteBranch: true,
      discardTracked: true,
      branch: created.branch,
    });

    expect((await git("branch", "--list", created.branch)).trim()).toEqual("");
  });

  test("refuses to remove a worktree owned by another Hive instance", async () => {
    const created = await createWorktree(repoRoot, "agent-sibling", "owned");
    const ownRef = `refs/hive-owner/${hiveInstanceSuffix()}/${created.branch}`;
    const siblingRef = `refs/hive-owner/sibling-instance/${created.branch}`;
    await git("update-ref", "-d", ownRef);
    await git("update-ref", siblingRef, created.branch);

    try {
      expect(
        removeWorktree(repoRoot, created.path, {
          deleteBranch: true,
          branch: created.branch,
        }),
      ).rejects.toThrow("another Hive instance");
      expect((await git("branch", "--list", created.branch)).trim()).toContain(
        created.branch,
      );
    } finally {
      await git("update-ref", "-d", siblingRef);
      if ((await git("branch", "--list", created.branch)).trim() !== "") {
        await git("update-ref", ownRef, created.branch);
        await removeWorktree(repoRoot, created.path, {
          deleteBranch: true,
          discardTracked: true,
          branch: created.branch,
        });
      }
    }
  });

  test("only the default instance may clean up ownerless legacy worktrees", async () => {
    const created = await createWorktree(repoRoot, "agent-legacy", "ownerless");
    const ownRef = `refs/hive-owner/${hiveInstanceSuffix()}/${created.branch}`;
    await git("update-ref", "-d", ownRef);

    expect(
      removeWorktree(repoRoot, created.path, {
        deleteBranch: true,
        branch: created.branch,
      }),
    ).rejects.toThrow("ownerless legacy branch outside the default");

    const namedHome = Bun.env.HIVE_HOME;
    Bun.env.HIVE_HOME = join(homedir(), ".hive");
    try {
      await removeWorktree(repoRoot, created.path, {
        deleteBranch: true,
        branch: created.branch,
      });
      expect((await git("branch", "--list", created.branch)).trim()).toBe("");
    } finally {
      if (namedHome === undefined) delete Bun.env.HIVE_HOME;
      else Bun.env.HIVE_HOME = namedHome;
    }
  });

  test("treats a deleted worktree directory and missing branch as nothing stranded", async () => {
    expect(
      await assessStrandedWork(
        repoRoot,
        join(repoRoot, ".hive", "worktrees", "gone"),
        "hive/gone-task",
      ),
    ).toEqual({ dirtyFiles: [], unmergedCommits: 0 });
  });

  test("surfaces git stderr", async () => {
    let message = "";
    try {
      await createWorktree(join(tempRoot, "not-a-repo"), "agent-4", "task");
    } catch (error) {
      message = errorMessage(error);
    }
    expect(message.includes("not a git repository")).toEqual(true);
  });
});

describe("owner-ref inventory (I8)", () => {
  test("finds this instance's stale owner refs and leaves mutation to settlement", async () => {
    const live = await createWorktree(repoRoot, "owner-live", "still-here");
    const liveRef = `refs/hive-owner/${hiveInstanceSuffix()}/${live.branch}`;
    // Fabricate a stale owner ref: point at HEAD tip under a branch name that
    // does not exist. The ref is the only thing left of a deleted branch.
    const staleBranch = "hive/owner-stale-gone";
    const staleRef = `refs/hive-owner/${hiveInstanceSuffix()}/${staleBranch}`;
    await git("update-ref", staleRef, "HEAD");
    // Sibling instance's stale ref must not be touched.
    const siblingStale = `refs/hive-owner/sibling-instance/${staleBranch}`;
    await git("update-ref", siblingStale, "HEAD");

    expect((await git("show-ref", "--verify", staleRef)).trim()).toContain(
      staleRef,
    );
    expect((await git("branch", "--list", staleBranch)).trim()).toBe("");

    const result = await listStaleOwnerRefs(repoRoot);
    expect(result.stale.map(({ ref }) => ref)).toEqual([staleRef]);
    expect(result.kept.map(({ ref }) => ref)).toContain(liveRef);

    // Inventory does not mutate any of the refs it measured.
    expect((await git("show-ref", "--verify", staleRef)).trim()).toContain(
      staleRef,
    );
    expect((await git("show-ref", "--verify", liveRef)).trim()).toContain(
      liveRef,
    );
    expect((await git("show-ref", "--verify", siblingStale)).trim()).toContain(
      siblingStale,
    );

    const second = await listStaleOwnerRefs(repoRoot);
    expect(second.stale.map(({ ref }) => ref)).toEqual([staleRef]);
    expect(second.kept.map(({ ref }) => ref)).toContain(liveRef);

    await git("update-ref", "-d", staleRef);
    await git("update-ref", "-d", siblingStale);
    await removeWorktree(repoRoot, live.path, {
      deleteBranch: true,
      branch: live.branch,
    });
  });
});

describe("settlement branch inventory", () => {
  test("finds a branch holding commits that never reached main", async () => {
    // A hive/* branch with a commit whose worktree is gone: the ref is the only
    // surviving trace.
    await git("branch", "hive/david-widgets", "main");
    const worktree = join(tempRoot, "david-wt");
    await git("worktree", "add", worktree, "hive/david-widgets");
    await writeFile(join(worktree, "widgets.ts"), "export const x = 1;\n");
    const inWorktree = async (...args: string[]) => {
      const process = Bun.spawn(["git", "-C", worktree, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await process.exited;
    };
    await inWorktree("add", "widgets.ts");
    await inWorktree("commit", "-m", "rescue david's widgets work");
    await git("worktree", "remove", "--force", worktree);

    const stranded = await listSettlementBranches(repoRoot);

    expect(stranded).toEqual([
      {
        branch: "hive/david-widgets",
        tip: await git("rev-parse", "hive/david-widgets"),
        unmergedCommits: 1,
      },
    ]);
  });

  test("reports a hive branch whose commits are already on main, holding nothing", async () => {
    await git("branch", "hive/landed-work", "main");

    const stranded = await listSettlementBranches(repoRoot);

    // Listed, not hidden: settlement is answerable for releasing this branch, and a branch left
    // out of the inventory has no case and is never released at all.
    expect(
      stranded.find((entry) => entry.branch === "hive/landed-work"),
    ).toMatchObject({ unmergedCommits: 0 });
  });

  test("does not report a false empty inventory when main does not exist", async () => {
    const bare = await mkdtemp(join(tmpdir(), "hive-no-main-"));
    const init = Bun.spawn(["git", "-C", bare, "init", "-b", "trunk"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await init.exited;
    try {
      // Which read refuses first does not matter; that one of them refuses does. An empty list
      // here would read as "no branch holds unlanded work" when nothing was measured at all.
      await expect(listSettlementBranches(bare)).rejects.toThrow();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("hive wiring", () => {
  test("is not counted as the agent's stranded work", async () => {
    const created = await createWorktree(repoRoot, "excluded", "hive wiring");

    await mkdir(join(created.path, ".kimi-code"), { recursive: true });
    await writeFile(join(created.path, ".kimi-code", "AGENTS.md"), "brief\n");
    await writeFile(join(created.path, ".kimi-code", "mcp.json"), "{}\n");
    await writeFile(join(created.path, ".mcp.json"), "{}\n");

    expect(
      await assessStrandedWork(repoRoot, created.path, created.branch),
    ).toEqual({ dirtyFiles: [], unmergedCommits: 0 });
  });

  test("does not hide real agent work beside it", async () => {
    const created = await createWorktree(repoRoot, "realwork", "hive wiring");

    await mkdir(join(created.path, ".kimi-code"), { recursive: true });
    await writeFile(join(created.path, ".kimi-code", "mcp.json"), "{}\n");
    await writeFile(join(created.path, ".kimi-code", "notes.md"), "work\n");

    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded.dirtyFiles).toEqual([".kimi-code/notes.md"]);
  });

  // The fixture repository has no .gitignore, which is the arbitrary project
  // Hive has to work on: every shipped skill is untracked there.
  test("discounts the config and skills every vendor spawn provisions", async () => {
    const instructionPath = join(tempRoot, "launch-prompt.txt");
    await writeFile(instructionPath, "brief\n");
    for (const tool of CAPABILITY_PROVIDERS) {
      const created = await createWorktree(repoRoot, tool, "hive wiring");
      await getAgentAdapter(tool).prepareRuntime({
        name: tool,
        model: "default",
        effort: "medium",
        worktreePath: created.path,
        daemonPort: 41_000,
        readOnly: false,
        dangerous: false,
        withCapability: true,
        instructionPath,
        providerRunId: "018f1e90-7b5a-7cc0-8000-000000000223",
      });
      await provisionSkills(
        repoRoot,
        created.path,
        { role: "agent", tool },
        join(tempRoot, "no-skills"),
      );

      const stranded = await assessStrandedWork(
        repoRoot,
        created.path,
        created.branch,
      );
      expect(stranded.dirtyFiles).toEqual([]);
    }
  });

  // User skills are symlinked in at every spawn under names only the user
  // knows. Those links must not count as stranded work, or the worktree never
  // sweeps.
  test("discounts the user's own skills every vendor spawn links in", async () => {
    // Uncommitted in the primary checkout — the usual shape of a dropped skill.
    for (const name of ["agent/zig-best-practices", "agent/grok/only-grok"]) {
      await mkdir(join(repoRoot, ".hive", "skills", name), { recursive: true });
      await writeFile(
        join(repoRoot, ".hive", "skills", name, "SKILL.md"),
        `# ${name}\n`,
      );
    }

    for (const tool of CAPABILITY_PROVIDERS) {
      const created = await createWorktree(repoRoot, `user-${tool}`, "hive");
      await provisionSkills(repoRoot, created.path, { role: "agent", tool });

      expect({
        tool,
        ...(await assessStrandedWork(repoRoot, created.path, created.branch)),
      }).toEqual({ tool, dirtyFiles: [], unmergedCommits: 0 });
    }
  });

  // Codex, Grok and Kimi share `.agents/skills`. A link the agent made itself
  // (pointing at a skill only Grok can see) is the agent's work — treating it
  // as Hive wiring lets reconciliation delete the worktree. Expectation is a
  // literal path list, not re-derived from the same roots the code under test
  // uses.
  test("does not adopt a foreign vendor's skill link as its own wiring", async () => {
    for (const name of ["agent/grok/grok-only", "agent/every-vendor"]) {
      await mkdir(join(repoRoot, ".hive", "skills", name), { recursive: true });
      await writeFile(
        join(repoRoot, ".hive", "skills", name, "SKILL.md"),
        `# ${name}\n`,
      );
    }

    const created = await createWorktree(
      repoRoot,
      "foreignlink",
      "hive wiring",
    );
    await provisionSkills(repoRoot, created.path, {
      role: "agent",
      tool: "codex",
    });
    // Made after the spawn, at a path Codex provisioning never wrote.
    await symlink(
      join(repoRoot, ".hive", "skills", "agent", "grok", "grok-only"),
      join(created.path, ".agents", "skills", "grok-only"),
      "dir",
    );

    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded.dirtyFiles).toEqual([".agents/skills/grok-only"]);
  });

  // A name belongs to the vendor bucket that owns it. Codex and Kimi share
  // `.agents/skills`, so one name has two sources, and Codex's correctly staged
  // link must not be read against Kimi's.
  test("keeps a link clean when another vendor owns the same skill name", async () => {
    for (const vendor of ["codex", "kimi"]) {
      await mkdir(
        join(repoRoot, ".hive", "skills", "agent", vendor, "review"),
        {
          recursive: true,
        },
      );
      await writeFile(
        join(
          repoRoot,
          ".hive",
          "skills",
          "agent",
          vendor,
          "review",
          "SKILL.md",
        ),
        `# ${vendor} review\n`,
      );
    }

    const created = await createWorktree(repoRoot, "namecollide", "hive");
    await provisionSkills(repoRoot, created.path, {
      role: "agent",
      tool: "codex",
    });

    expect(
      await readlink(join(created.path, ".agents", "skills", "review")),
    ).toBe(join(repoRoot, ".hive", "skills", "agent", "codex", "review"));
    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded.dirtyFiles).toEqual([]);
  });

  // Cleanup must know what provisioning did, not what it would do now. Deleting
  // a source leaves behind a link Hive really did create, and a worktree that
  // reads dirty forever is never reaped.
  test("keeps a provisioned link clean after its source is deleted", async () => {
    await mkdir(join(repoRoot, ".hive", "skills", "agent", "vanishing"), {
      recursive: true,
    });
    await writeFile(
      join(repoRoot, ".hive", "skills", "agent", "vanishing", "SKILL.md"),
      "# vanishing\n",
    );

    const created = await createWorktree(repoRoot, "vanishing", "hive");
    await provisionSkills(repoRoot, created.path, {
      role: "agent",
      tool: "claude",
    });
    await rm(join(repoRoot, ".hive", "skills", "agent", "vanishing"), {
      recursive: true,
      force: true,
    });

    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded.dirtyFiles).toEqual([]);
  });

  // A path Hive would have staged is not Hive's unless the thing there is that
  // link: an agent's own directory of the same name is still its work.
  test("does not hide agent work at a user skill's name", async () => {
    const created = await createWorktree(repoRoot, "skillname", "hive wiring");
    await mkdir(join(created.path, ".claude", "skills"), { recursive: true });
    await writeFile(
      join(created.path, ".claude", "skills", "zig-best-practices"),
      "mine\n",
    );

    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded.dirtyFiles).toEqual([".claude/skills/zig-best-practices"]);
  });

  test("does not hide agent work beside a provisioned skill", async () => {
    const created = await createWorktree(repoRoot, "skillwork", "hive wiring");
    await provisionSkills(
      repoRoot,
      created.path,
      { role: "agent", tool: "claude" },
      join(tempRoot, "no-skills"),
    );
    await writeFile(
      join(created.path, ".claude", "skills", "hive-claude", "notes.md"),
      "work\n",
    );

    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded.dirtyFiles).toEqual([
      ".claude/skills/hive-claude/notes.md",
    ]);
  });
});

describe("owner liveness input for orphaned worktree reconciliation", () => {
  // Missing agent rows must never authorize removal. The process probe is
  // three-valued; unknown and live both keep the worktree.

  test("keeps a missing-row worktree when the process probe reports live", async () => {
    const owned = await createWorktree(repoRoot, "rowless-live", "liveness");
    try {
      const report = await reconcileOrphanedWorktrees(repoRoot, [], "main", {
        now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
        probeOwnerLiveness: () => "live",
      });
      expect(
        report.worktrees.find((entry) => entry.path === owned.path),
      ).toMatchObject({ action: "kept", rule: "live-agent" });
    } finally {
      await removeWorktree(repoRoot, owned.path, {
        deleteBranch: true,
        branch: owned.branch,
      });
    }
  });

  test("keeps a missing-row worktree when the process probe is unknown", async () => {
    const owned = await createWorktree(repoRoot, "rowless-unk", "liveness");
    try {
      const report = await reconcileOrphanedWorktrees(repoRoot, [], "main", {
        now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
        probeOwnerLiveness: () => "unknown",
      });
      expect(
        report.worktrees.find((entry) => entry.path === owned.path),
      ).toMatchObject({
        action: "kept",
        rule: "assessment-failed",
        note: "owner liveness unknown (missing agent row; process probe unanswerable)",
      });
    } finally {
      await removeWorktree(repoRoot, owned.path, {
        deleteBranch: true,
        branch: owned.branch,
      });
    }
  });

  test("reports a clean orphan as eligible when the process probe reports dead", async () => {
    const clean = await createWorktree(repoRoot, "rowless-dead", "liveness");
    const report = await reconcileOrphanedWorktrees(repoRoot, [], "main", {
      now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
      probeOwnerLiveness: () => "dead",
    });
    expect(
      report.worktrees.find((entry) => entry.path === clean.path),
    ).toMatchObject({ action: "eligible", rule: "clean-orphan" });
    expect(existsSync(clean.path)).toBe(true);
    await removeWorktree(repoRoot, clean.path, {
      deleteBranch: true,
      branch: clean.branch,
    });
  });

  test("a live agent row still keeps its worktree as live-agent", async () => {
    const owned = await createWorktree(repoRoot, "row-live", "liveness");
    const row = {
      id: "agent-row-live",
      name: "row-live",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "default",
      status: "working",
      taskDescription: "live row",
      worktreePath: owned.path,
      branch: owned.branch,
      contextPct: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      lastEventAt: "2026-08-10T12:00:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;
    // If the row path asked the process probe, a "dead" answer would push it
    // toward release. It must stay live-agent from the row alone.
    try {
      const report = await reconcileOrphanedWorktrees(repoRoot, [row], "main", {
        now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
        probeOwnerLiveness: () => "dead",
      });
      expect(
        report.worktrees.find((entry) => entry.path === owned.path),
      ).toMatchObject({ action: "kept", rule: "live-agent" });
    } finally {
      await removeWorktree(repoRoot, owned.path, {
        deleteBranch: true,
        branch: owned.branch,
      });
    }
  });
});
