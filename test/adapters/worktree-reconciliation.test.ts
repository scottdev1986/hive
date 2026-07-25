import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createWorktree,
  markBranchPreserved,
  reconcileOrphanedWorktrees,
  unavailableAgentNames,
} from "../../src/adapters/worktrees";
import { selectAgentName } from "../../src/daemon/spawner-impl";
import type { AgentRecord } from "../../src/schemas";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

let tempRoot = "";
let repoRoot = "";
let previousHiveHome: string | undefined;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

function agent(
  name: string,
  status: AgentRecord["status"],
  worktreePath: string,
  branch: string,
  failureReason?: string,
): AgentRecord {
  return {
    id: `agent-${name}`,
    name,
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "default",
    status,
    taskDescription: `${name} task`,
    worktreePath,
    branch,
    contextPct: null,
    createdAt: "2026-07-25T12:00:00.000Z",
    lastEventAt: "2026-07-25T12:00:00.000Z",
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...(failureReason === undefined ? {} : { failureReason }),
  };
}

beforeAll(async () => {
  tempRoot = await mkdtemp(
    join(OUTSIDE_REPO_TMPDIR, "hive-worktree-reconcile-"),
  );
  repoRoot = join(tempRoot, "repo");
  await mkdir(repoRoot, { recursive: true });
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");
  await git(repoRoot, "init", "-b", "main");
  await git(repoRoot, "config", "user.name", "Hive Test");
  await git(repoRoot, "config", "user.email", "hive@example.test");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await git(repoRoot, "add", "README.md");
  await git(repoRoot, "commit", "-m", "initial");
});

afterAll(async () => {
  if (previousHiveHome === undefined) {
    delete Bun.env.HIVE_HOME;
  } else {
    Bun.env.HIVE_HOME = previousHiveHome;
  }
  if (tempRoot !== "") await rm(tempRoot, { recursive: true, force: true });
});

describe("orphaned worktree reconciliation", () => {
  test("removes only ownerless clean worktrees and fully merged preservation refs", async () => {
    const clean = await createWorktree(repoRoot, "clean", "no-op");
    await writeFile(join(clean.path, "opencode.json"), "{}\n");
    const live = await createWorktree(repoRoot, "live", "active");
    const preserved = await createWorktree(repoRoot, "preserved", "decision");
    const dirty = await createWorktree(repoRoot, "dirty", "user skill");
    await mkdir(join(dirty.path, ".opencode", "skills"), { recursive: true });
    const userSkill = join(tempRoot, "user-skill");
    await mkdir(userSkill);
    await symlink(
      userSkill,
      join(dirty.path, ".opencode", "skills", "user-skill"),
    );
    const stale = await createWorktree(repoRoot, "stale", "missing directory");
    await rm(stale.path, { recursive: true, force: true });
    const unmerged = await createWorktree(repoRoot, "unmerged", "real commit");
    await writeFile(join(unmerged.path, "work.ts"), "export {};\n");
    await git(unmerged.path, "add", "work.ts");
    await git(unmerged.path, "commit", "-m", "unmerged work");
    const diskOnlyName = selectAgentName([]);
    const unregistered = join(repoRoot, ".hive", "worktrees", diskOnlyName);
    await mkdir(unregistered);

    for (const worktree of [clean, live, preserved, dirty, stale, unmerged]) {
      await markBranchPreserved(repoRoot, worktree.branch, true);
    }

    expect(
      await unavailableAgentNames(repoRoot, ["clean", diskOnlyName, "unused"]),
    ).toEqual(new Set(["clean", diskOnlyName]));
    expect(
      selectAgentName(
        [],
        await unavailableAgentNames(repoRoot, [diskOnlyName]),
      ),
    ).not.toBe(diskOnlyName);

    const report = await reconcileOrphanedWorktrees(repoRoot, [
      agent("live", "working", live.path, live.branch),
      agent(
        "preserved",
        "dead",
        preserved.path,
        preserved.branch,
        "awaiting user decision",
      ),
    ]);
    const byName = new Map(
      report.worktrees.map((outcome) => [
        outcome.path.split("/").at(-1),
        outcome,
      ]),
    );

    expect(byName.get("clean")?.rule).toBe("clean-orphan");
    expect(byName.get("clean")?.action).toBe("removed");
    expect(byName.get("stale")?.rule).toBe("clean-orphan");
    expect(byName.get("stale")?.action).toBe("removed");
    expect(byName.get("live")?.rule).toBe("live-agent");
    expect(byName.get("preserved")?.rule).toBe("preserved-agent");
    expect(byName.get("dirty")?.rule).toBe("stranded-work");
    expect(byName.get("dirty")?.dirtyFiles).toEqual([
      ".opencode/skills/user-skill",
    ]);
    expect(byName.get("unmerged")?.rule).toBe("stranded-work");
    expect(byName.get("unmerged")?.unmergedCommits).toBe(1);
    expect(byName.get(diskOnlyName)?.rule).toBe("unregistered-path");

    expect(
      report.preservedRefs.removed.map((ref) => ref.branch).sort(),
    ).toEqual(
      [clean, dirty, live, preserved, stale]
        .map((worktree) => worktree.branch)
        .sort(),
    );
    expect(report.preservedRefs.kept).toEqual([
      {
        branch: unmerged.branch,
        tip: await git(repoRoot, "rev-parse", unmerged.branch),
        unmergedCommits: 1,
      },
    ]);
  });
  // `git rebase` leaves a worktree on a DETACHED HEAD, and the landing protocol
  // tells every agent to run `git rebase main`, so an agent interrupted
  // mid-rebase holds commits on no branch at all. The sweep counted unmerged
  // commits by branch name, so those worktrees reported 0 unconditionally, the
  // unmerged guard could not fire, and the commits were deleted irrecoverably.
  test("keeps a detached worktree holding commits, which is where a rebase leaves one", async () => {
    const detachedRoot = await mkdtemp(
      join(OUTSIDE_REPO_TMPDIR, "hive-worktree-detached-"),
    );
    try {
      const repo = join(detachedRoot, "repo");
      await mkdir(repo, { recursive: true });
      await git(repo, "init", "-b", "main");
      await git(repo, "config", "user.name", "Hive Test");
      await git(repo, "config", "user.email", "hive@example.test");
      await writeFile(join(repo, "README.md"), "# test\n");
      await git(repo, "add", "README.md");
      await git(repo, "commit", "-m", "initial");

      const victim = join(repo, ".hive", "worktrees", "victim");
      await mkdir(join(repo, ".hive", "worktrees"), { recursive: true });
      await git(repo, "worktree", "add", "--detach", victim, "HEAD");
      await git(victim, "config", "user.name", "Hive Test");
      await git(victim, "config", "user.email", "hive@example.test");
      await writeFile(join(victim, "precious.ts"), "export {};\n");
      await git(victim, "add", "precious.ts");
      await git(
        victim,
        "commit",
        "-m",
        "work an interrupted rebase left behind",
      );
      const tip = await git(victim, "rev-parse", "HEAD");

      // No agent owns it: without the fix this is rule "clean-orphan" / removed.
      const report = await reconcileOrphanedWorktrees(repo, []);
      const outcome = report.worktrees.find((entry) =>
        entry.path.endsWith("/victim"),
      );
      expect(outcome?.action).toBe("kept");
      expect(outcome?.rule).toBe("stranded-work");
      expect(outcome?.unmergedCommits).toBe(1);
      expect(outcome?.branch).toBeNull();

      // The commit itself must still be findable, which is the property that
      // actually matters — an outcome label is not evidence the work survived.
      const reachable = await git(repo, "rev-list", "--all", "--reflog");
      expect(reachable).toContain(tip);
    } finally {
      await rm(detachedRoot, { recursive: true, force: true });
    }
  });
});
