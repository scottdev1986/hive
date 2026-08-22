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
