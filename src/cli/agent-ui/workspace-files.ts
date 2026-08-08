import { execFile } from "node:child_process";

/** The files a person can @-mention: everything git tracks plus untracked files it does not ignore. Ignored and generated trees stay out of the picker for the same reason they stay out of the repo. A worktree that is not a git checkout yields an empty list and the picker simply never opens. */
export function listWorkspaceFiles(cwd: string): Promise<readonly string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          resolve([]);
          return;
        }
        resolve(stdout.split("\n").filter((line) => line !== ""));
      },
    );
  });
}
