import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Temp base for fixtures that must NOT sit inside a Git repository.
 *
 * The bounded test runner supplies a TMPDIR outside the checkout. A fixture
 * built below the dev instance's `<repo>/.dev/tmp` would still be in this Git
 * repository, so `git rev-parse` would silently measure the checkout instead.
 * Resolved once so fixture paths equal the physical paths Git reports back.
 */
export const OUTSIDE_REPO_TMPDIR = realpathSync.native(tmpdir());
