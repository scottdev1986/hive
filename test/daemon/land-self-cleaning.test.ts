import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assessStrandedWork,
  branchOwner,
  createWorktree,
  listSettlementBranches,
  reconcileOrphanedWorktrees,
} from "../../src/adapters/worktrees";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  classifyNothingToLand,
  landBranch,
} from "../../src/daemon/landing/landing-service";
import { WorktreeLifecycleService } from "../../src/daemon/worktree-lifecycle-service/worktree-lifecycle-service";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...processEnv,
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

const processEnv = { ...process.env };

test("a landed branch is reset for clean follow-up work and can land again", async () => {
  const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-reland-"));
  const previousHiveHome = Bun.env.HIVE_HOME;
  try {
    Bun.env.HIVE_HOME = join(root, "hive-home");
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await writeFile(join(repo, "README.md"), "# test\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    const writer = await createWorktree(repo, "writer", "two lands");
    const db = new HiveDatabase(":memory:");
    const agent = db.insertAgent({
      id: "agent-writer",
      name: "writer",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "complex_coding",
      status: "working",
      taskDescription: "land twice",
      worktreePath: writer.path,
      branch: writer.branch,
      contextPct: null,
      createdAt: "2026-08-12T12:00:00.000Z",
      lastEventAt: "2026-08-12T12:00:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    });
    const lifecycle = new WorktreeLifecycleService({
      db,
      repoRoot: repo,
      clock: () => new Date("2026-08-12T12:00:00.000Z"),
      publish: async () => {},
      assessStrandedWork,
      listSettlementBranches,
      reconcileOrphanedWorktrees,
    });
    await lifecycle.openSettlementCase(
      agent,
      writer,
      await git(repo, "rev-parse", "main"),
    );
    expect(
      classifyNothingToLand(await lifecycle.landingEvidence(agent, null)),
    ).toBe("no-commits");

    await writeFile(join(writer.path, "first.ts"), "export const first = 1;\n");
    await git(writer.path, "add", "first.ts");
    await git(writer.path, "commit", "-m", "first land");
    const first = await landBranch(repo, writer.branch);
    await lifecycle.onLanded(agent, first.commit);

    expect(db.getAgentById(agent.id)).toMatchObject({
      landedCommit: first.commit,
      landedAt: "2026-08-12T12:00:00.000Z",
    });

    expect(
      classifyNothingToLand(await lifecycle.landingEvidence(agent, null)),
    ).toBe("already-landed");
    expect(await git(writer.path, "rev-parse", "HEAD")).toBe(first.commit);
    expect(await git(repo, "rev-parse", writer.branch)).toBe(first.commit);
    expect(await branchOwner(repo, writer.branch)).toBeDefined();

    await writeFile(
      join(writer.path, "second.ts"),
      "export const second = 2;\n",
    );
    await git(writer.path, "add", "second.ts");
    await git(writer.path, "commit", "-m", "follow-up land");
    const second = await landBranch(repo, writer.branch);
    await lifecycle.onLanded(agent, second.commit);

    expect(second.commit).not.toBe(first.commit);
    expect(db.getAgentById(agent.id)).toMatchObject({
      landedCommit: second.commit,
      landedAt: "2026-08-12T12:00:00.000Z",
    });
    expect(await git(repo, "rev-parse", "main")).toBe(second.commit);
    expect(await git(repo, "rev-parse", writer.branch)).toBe(second.commit);
    expect(await Bun.file(join(writer.path, "second.ts")).text()).toContain(
      "second",
    );
    db.close();
  } finally {
    if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
    else Bun.env.HIVE_HOME = previousHiveHome;
    await rm(root, { recursive: true, force: true });
  }
});
