// Child process for the git-env sanitization test.
//
// It must be a separate process because Bun snapshots the environment when it
// starts: mutating `process.env` in the parent never reaches a `Bun.spawn`
// child, so a same-process test of these call sites passes whether or not they
// sanitize. The hostile variables have to be in this process's real environ,
// which only the spawning test can arrange.
//
// Prints one JSON object of what each call site resolved; the test asserts none
// of them followed the decoy.
import { repositoryRootForWorktree } from "../../src/adapters/providers/grok-cli";
import { listWorktrees } from "../../src/adapters/worktrees";
import { runGit } from "../../src/adapters/git";
import { projectStateDir } from "../../src/daemon/project-identity-core/state";

const repo = process.argv[2];
if (repo === undefined) throw new Error("usage: git-env-probe.fixture <repo>");

const landing = await runGit(repo, [
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
]);

process.stdout.write(
  JSON.stringify({
    landingCommonDir: landing.stdout.trim(),
    landingExitCode: landing.exitCode,
    grokRepositoryRoot: repositoryRootForWorktree(repo),
    worktreePaths: (await listWorktrees(repo)).map((tree) => tree.path),
    projectStateDir: projectStateDir(repo),
  }),
);
