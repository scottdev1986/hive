import { realpathSync } from "node:fs";

/**
 * Temp base for fixtures that must NOT sit inside a Git repository.
 *
 * The dev instance runs with `TMPDIR=<repo>/.dev/tmp` (Makefile `DEV_ENV`), and every
 * process it spawns inherits it, so everything `os.tmpdir()` hands out there is a path
 * inside this checkout's worktree. A fixture built at such a path *is* in a repository:
 * `git rev-parse` walks up to this repo, and an assertion of the form "this directory is
 * not a repo" silently measures this repo instead of the fixture. Resolved once, so a
 * fixture path compares equal to the physical path git reports back.
 */
export const OUTSIDE_REPO_TMPDIR = realpathSync.native("/tmp");
