import {
  lstat,
  mkdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEV_SHARED_WITH_DEFAULT_HOME } from "../../src/hive-home/variant";

/** The whitelist, under the name this script's callers have always imported. The list itself is a field of the dev variant's record, because the installer that creates these links and the uninstaller that must not follow them need the same four names. */
export const SHARED_STATE_NAMES = DEV_SHARED_WITH_DEFAULT_HOME;

export const REAL_DIRS_CREATED = ["memory", "projects", "models"] as const;

export interface ShareResult {
  linked: string[];
  /** Stale symlinks repointed at the real path. */
  refreshed: string[];
  /** Real paths that do not exist (yet) — nothing linked. */
  skipped: string[];
  warnings: string[];
}

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

const isEexist = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "EEXIST";

/** Link the real home's memory state into `devHome` per the header's rules. Never deletes real-directory content; never throws for an occupied dev path — the warning is the contract. Throws only on genuine IO failure. */
export async function shareMemoryState(
  devHome: string,
  realHome: string,
): Promise<ShareResult> {
  const result: ShareResult = {
    linked: [],
    refreshed: [],
    skipped: [],
    warnings: [],
  };
  await mkdir(devHome, { recursive: true });
  for (const name of REAL_DIRS_CREATED) {
    await mkdir(join(realHome, name), { recursive: true });
  }
  await writeFile(
    join(realHome, "project-registry.json"),
    '{"records":[],"tombstones":[]}',
    { flag: "wx" },
  ).catch((error: unknown) => {
    if (!isEexist(error)) throw error;
  });
  for (const name of SHARED_STATE_NAMES) {
    const realPath = join(realHome, name);
    const devPath = join(devHome, name);
    const realStat = await lstat(realPath).catch((error: unknown) => {
      if (isEnoent(error)) return null;
      throw error;
    });
    if (realStat === null) {
      result.skipped.push(name);
      continue;
    }
    const devStat = await lstat(devPath).catch((error: unknown) => {
      if (isEnoent(error)) return null;
      throw error;
    });
    if (devStat === null) {
      await symlink(realPath, devPath);
      result.linked.push(name);
      continue;
    }
    if (devStat.isSymbolicLink()) {
      const target = await readlink(devPath);
      if (target === realPath) {
        result.linked.push(name);
        continue;
      }
      // Stale link (an older real-home spelling, a moved home, a dangling target): the link itself is dev-home metadata, safe to repoint.
      await rm(devPath);
      await symlink(realPath, devPath);
      result.refreshed.push(name);
      continue;
    }
    // A real directory/file in the dev home. Never delete, never merge: this may be dev-only memory the user cares about, and only a user knows which side wins.
    result.warnings.push(
      `WARNING: ${devPath} exists as a real ${devStat.isDirectory() ? "directory" : "file"} ` +
        `and was NOT linked to ${realPath} — dev memory is private until you reconcile it.\n` +
        `  To adopt the real home's state:  mv "${devPath}" "${devPath}.dev-backup" ` +
        `&& re-run \`make run\`\n` +
        `  To merge dev state into live first: copy its contents into ${realPath} by hand, ` +
        `then remove ${devPath} and re-run \`make run\``,
    );
  }
  return result;
}

export function formatShareSummary(
  devHome: string,
  realHome: string,
  result: ShareResult,
): string[] {
  const lines = [
    `make run: sharing memory state ${realHome} -> ${devHome}`,
    `  linked:    ${result.linked.length === 0 ? "(none)" : result.linked.join(", ")}`,
  ];
  if (result.refreshed.length > 0) {
    lines.push(`  refreshed stale links: ${result.refreshed.join(", ")}`);
  }
  if (result.skipped.length > 0) {
    lines.push(
      `  skipped (absent in the real home): ${result.skipped.join(", ")}`,
    );
  }
  if (
    result.linked.includes("projects") ||
    result.refreshed.includes("projects")
  ) {
    lines.push(
      "  note: dev and prod daemons share episodic stores (projects/<uuid>/episodic.db); " +
        "both running at once is expected — SQLite WAL + busy_timeout mediates concurrent access",
    );
  }
  lines.push(
    "  runtime state (daemon.port, credentials, runtime/, logs/, hive.db) stays per-home",
  );
  return lines;
}

if (import.meta.main) {
  const [devHome, realHome = join(homedir(), ".hive")] = process.argv.slice(2);
  if (devHome === undefined) {
    console.error("usage: dev-memory-setup <dev-home> [real-home]");
    process.exitCode = 2;
  } else {
    try {
      const result = await shareMemoryState(devHome, realHome);
      for (const line of formatShareSummary(devHome, realHome, result)) {
        console.log(line);
      }
      for (const warning of result.warnings) {
        console.error(warning);
      }
    } catch (error) {
      console.error(
        `dev-memory-setup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
    }
  }
}
