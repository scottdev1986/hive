/** The environment every `git` invocation must run with. Git reads its own discovery inputs from the environment, so a caller's environment can redirect any git command at another repository. Verified: `GIT_DIR=/elsewhere/bare.git git -C /a/repo rev-parse --git-dir` reports the bare repo, not `/a/repo/.git`. Hive's daemon runs with whatever environment it inherited, so no git call that decides project identity, worktree membership, or landing may trust it. This lives beside the other vendor-tool adapters because it is a fact about driving the `git` binary, not about any one caller. Every layer that shells out to git can reach it from here. */
const HOSTILE_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
] as const;

export function sanitizedGitEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of HOSTILE_GIT_ENV) delete env[key];
  return env;
}
