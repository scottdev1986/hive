import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureWipSalvage,
  keepStewardshipRef,
  listStewardshipRefs,
  markBranchPreserved,
} from "../../src/adapters/worktrees";
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
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return stdout.trim();
}

async function snapshotWorktree(path: string): Promise<{
  status: string;
  index: string;
  readme: string;
}> {
  return {
    status: await git(path, "status", "--porcelain", "-uall"),
    index: await git(path, "write-tree"),
    readme: await readFile(join(path, "README.md"), "utf8"),
  };
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-salvage-"));
  repoRoot = join(tempRoot, "repo");
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");

  await git(tempRoot, "init", "-b", "main", "repo");
  await git(repoRoot, "config", "user.name", "Hive Test");
  await git(repoRoot, "config", "user.email", "hive@example.test");
  await writeFile(join(repoRoot, "README.md"), "# salvage base\n");
  await git(repoRoot, "add", "README.md");
  await git(repoRoot, "commit", "-m", "initial");
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

describe("WIP salvage capture", () => {
  test("captures tracked+untracked WIP via alt index without changing worktree/index", async () => {
    const branch = "hive/salvage-agent-wip";
    const worktree = join(repoRoot, ".hive", "worktrees", "salvage-agent");
    await git(repoRoot, "worktree", "add", "-b", branch, worktree);
    try {
      await writeFile(join(worktree, "README.md"), "# tracked dirty\n");
      await writeFile(join(worktree, "scratch.tmp"), "untracked wip\n");
      const before = await snapshotWorktree(worktree);

      const captured = await captureWipSalvage(repoRoot, worktree, branch, {
        agentName: "salvage-agent",
        preservedAt: "2026-08-01T00:00:00.000Z",
      });
      expect(captured).not.toBeNull();
      if (captured === null) throw new Error("expected a WIP salvage capture");
      expect(captured.ref).toBe(`refs/hive-salvage/${branch}`);

      const after = await snapshotWorktree(worktree);
      expect(after).toEqual(before);

      const files = (
        await git(
          repoRoot,
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          `${captured.tip}^`,
          captured.tip,
        )
      )
        .split("\n")
        .filter((line) => line !== "")
        .sort();
      expect(files).toEqual(["README.md", "scratch.tmp"]);
      // git helper trims stdout; content is still the WIP we wrote.
      expect(await git(repoRoot, "show", `${captured.tip}:scratch.tmp`)).toBe(
        "untracked wip",
      );
      expect(await git(repoRoot, "show", `${captured.tip}:README.md`)).toBe(
        "# tracked dirty",
      );
    } finally {
      await git(repoRoot, "worktree", "remove", "--force", worktree).catch(
        () => undefined,
      );
      await git(repoRoot, "branch", "-D", branch).catch(() => undefined);
      await git(
        repoRoot,
        "update-ref",
        "-d",
        `refs/hive-salvage/${branch}`,
      ).catch(() => undefined);
    }
  });
});

describe("stewardship list/keep", () => {
  test("lists rowless preserved refs; keep leaves tip byte-identical", async () => {
    const branch = "hive/rowless-residue";
    // Create a tip commit that is not on main, then preserve without any agent row.
    await git(repoRoot, "checkout", "-b", branch);
    await writeFile(
      join(repoRoot, "residue.ts"),
      "export const residue = 1;\n",
    );
    await git(repoRoot, "add", "residue.ts");
    await git(repoRoot, "commit", "-m", "rowless residue");
    const tip = await git(repoRoot, "rev-parse", "HEAD");
    await git(repoRoot, "checkout", "main");
    // Drop the branch name so only the preserved ref holds the tip — rowless residue.
    await git(repoRoot, "branch", "-D", branch);
    await git(repoRoot, "update-ref", `refs/hive-preserved/${branch}`, tip);

    // No meta yet: first list records observation without inventing preservedAt.
    const listed = await listStewardshipRefs(repoRoot, "main", {
      now: () => Date.parse("2026-08-10T12:00:00.000Z"),
    });
    const entry = listed.find(
      (item) => item.ref === `refs/hive-preserved/${branch}`,
    );
    expect(entry).toMatchObject({
      kind: "preserved",
      branch,
      tip,
      agentName: null,
      preservedAt: null,
      observedAt: "2026-08-10T12:00:00.000Z",
    });

    // keep leaves the tip byte-identical
    const kept = await keepStewardshipRef(
      repoRoot,
      `refs/hive-preserved/${branch}`,
      "2026-08-10T12:05:00.000Z",
    );
    expect(kept.tip).toBe(tip);
    expect(
      (
        await git(repoRoot, "rev-parse", `refs/hive-preserved/${branch}`)
      ).trim(),
    ).toBe(tip);

    await git(repoRoot, "update-ref", "-d", `refs/hive-preserved/${branch}`);
  });

  test("merged preserved ref survives reconcile classification until explicit release", async () => {
    const branch = "hive/merged-steward";
    await git(repoRoot, "branch", branch, "main");
    await markBranchPreserved(repoRoot, branch, {
      agentName: "steward",
      preservedAt: "2026-07-01T00:00:00.000Z",
    });
    const tipBefore = await git(
      repoRoot,
      "rev-parse",
      `refs/hive-preserved/${branch}`,
    );
    // Fully merged: still present until explicit release.
    const listed = await listStewardshipRefs(repoRoot, "main");
    expect(
      listed.some((item) => item.ref === `refs/hive-preserved/${branch}`),
    ).toBe(true);
    expect(tipBefore).toBe(await git(repoRoot, "rev-parse", "main"));
    await git(repoRoot, "update-ref", "-d", `refs/hive-preserved/${branch}`);
    expect(
      await git(
        repoRoot,
        "show-ref",
        "--verify",
        `refs/hive-preserved/${branch}`,
      ).catch(() => "absent"),
    ).toBe("absent");
  });
});
