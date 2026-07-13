import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { repairLegacyMountEvidence } from "../daemon/project-identity";
import { cliPath, currentLink, installRoot, versionsDir } from "./paths";

interface BootstrapDeps {
  readonly root?: string;
  readonly executablePath?: string;
  readonly cwd?: string;
  readonly realpath?: (path: string) => string;
  readonly repair?: (directory: string) => boolean;
}

/**
 * A pre-fix updater executes the staged binary only once, with `--version`,
 * before its own broken identity check blocks activation. Use that proof run as
 * a narrow compatibility bridge: only a non-current native binary, and only a
 * version probe, may refresh an existing record's mount-local evidence.
 */
export function repairIdentityFromStagedVersionProbe(
  argv: readonly string[],
  deps: BootstrapDeps = {},
): boolean {
  if (!argv.includes("--version") && !argv.includes("-v")) return false;

  const root = deps.root ?? installRoot();
  const executable = resolve(deps.executablePath ?? process.execPath);
  if (!executable.startsWith(resolve(versionsDir(root)) + sep)) return false;

  const realpath = deps.realpath ?? realpathSync.native;
  try {
    if (realpath(executable) === realpath(cliPath(currentLink(root)))) return false;
    return (deps.repair ?? repairLegacyMountEvidence)(deps.cwd ?? process.cwd());
  } catch {
    // Version reporting remains a pure liveness proof when no safe repair can
    // be made. The active updater will surface its own identity error next.
    return false;
  }
}
