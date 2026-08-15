// qa/repo-root.ts — the one place the QA tree's TypeScript works out which
// checkout it is in. The shell half is qa/repo-root.sh; two languages, two
// idiomatic mechanisms, one implementation each.
//
// It searches UPWARD for a real Hive checkout instead of counting directories,
// so nothing records how deep the tree sits. These two callers feed the u5
// isolation gate, which compares the running daemon's source root against this
// value: a silently wrong answer there does not fail a test, it weakens an
// isolation control, so this throws rather than returning a guess.

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The checkout root at or above `start`.
 *
 * @throws if no directory at or above `start` holds both `package.json` and
 * `src/cli.ts` — the pair a Hive checkout necessarily has and `<checkout>/docs`
 * necessarily does not.
 */
export function qaRepoRoot(start: string): string {
  let probe = realpathSync(start);
  for (;;) {
    if (
      existsSync(join(probe, "package.json")) &&
      existsSync(join(probe, "src", "cli.ts"))
    ) {
      return probe;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  throw new Error(
    `qa: no Hive checkout at or above ${start} ` +
      "(looked for a directory holding both package.json and src/cli.ts)",
  );
}
