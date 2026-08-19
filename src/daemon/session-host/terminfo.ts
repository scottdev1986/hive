import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { IS_RELEASE_BUILD } from "../../shared/version";
import {
  type ResolveSessiondBinaryOptions,
  resolveSessiondBinary,
} from "./sessiond-broker";

/**
 * Locate Hive's bundled xterm-ghostty terminfo tree.
 *
 * Point TERMINFO here. Do not copy the tree into machineHiveHome(): a named
 * instance's machine home is ~/.hive, and writing a new top-level name there
 * is an isolation leak against the live fleet and against `make qa-clean`.
 *
 * Release builds keep the tree next to hive-sessiond. Source checkouts keep
 * it at resources/terminfo in the repository.
 */
export function bundledTerminfoPath(
  options: ResolveSessiondBinaryOptions = {},
): string {
  const located = locateBundledTerminfo(options);
  if (located === null) {
    throw new Error(
      "Hive bundled terminfo not found. Expected resources/terminfo next to hive-sessiond or in repository.",
    );
  }
  return located;
}

function locateBundledTerminfo(
  options: ResolveSessiondBinaryOptions,
): string | null {
  const isRelease = options.isReleaseBuild ?? IS_RELEASE_BUILD;
  if (!isRelease) {
    const repoRoot = options.repoRoot ?? process.cwd();
    const repoTerminfo = join(repoRoot, "resources", "terminfo");
    if (isTerminfoTree(repoTerminfo)) return repoTerminfo;
  }

  const sessiondBin = resolveSessiondBinary(options);
  if (sessiondBin !== null) {
    const resourcesTerminfo = join(
      dirname(sessiondBin),
      "resources",
      "terminfo",
    );
    if (isTerminfoTree(resourcesTerminfo)) return resourcesTerminfo;
  }

  return null;
}

function isTerminfoTree(path: string): boolean {
  try {
    return statSync(join(path, "x", "xterm-ghostty")).isFile();
  } catch {
    return false;
  }
}
