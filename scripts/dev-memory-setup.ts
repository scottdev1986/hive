// `make run` dev-home memory sharing (user ruling, 2026-07-23: "when we test
// hive using dev it has the lessons that were learned in live and we don't
// lose anything"). The dev daemon runs with HIVE_HOME=/tmp/hv-<tag> so its
// RUNTIME state (daemon.port, credentials, runtime/, logs/, hive.db) stays
// isolated — but its MEMORY state must be the same memory the installed
// (prod) hive writes. This script links the four memory paths of the real
// user home ($HOME/.hive) into the dev home:
//
//   memory/                global wiki (~/.hive/memory — adapters/memory.ts)
//   projects/              per-project episodic stores (project-state.ts)
//   project-registry.json  repo→hiveUuid mapping (project-identity.ts) —
//                          without sharing it, dev mints a different uuid and
//                          the episodic stores diverge from prod's
//   models/                embedding model cache (memory-embeddings.ts)
//
// Everything else in the dev home stays per-home. The link set is a
// WHITELIST: runtime state is never linked, whatever the real home contains.
//
// Rules (tested in dev-memory-setup.test.ts):
//   - The real memory/ and projects/ dirs are created when absent, so dev
//     can write them into being on a fresh machine.
//   - models/ and project-registry.json are linked only when the real path
//     already exists (prod creates them on first use; a fresh machine has
//     nothing to share yet).
//   - A dev path that already exists as a REAL directory/file is never
//     deleted or merged: a non-empty one (pre-existing dev-only memory)
//     gets a loud warning with manual reconcile steps and stays untouched.
//   - A stale symlink (pointing anywhere other than the real path) is
//     refreshed; a correct one is left alone.
//
// Clean-safety: the dev-home entries are symlinks, and `make clean` deletes
// the dev home with `rm -rf` — which unlinks symlinks without following
// them, so the real ~/.hive is unreachable from clean (audited 2026-07-23;
// see the comment on the clean target).
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The whitelist: the only dev-home entries that may point at the real
 * home. Runtime state (daemon.port, credentials, runtime/, logs/, hive.db,
 * quota.db, instances/, tools/) is deliberately absent — it must stay
 * isolated per home. */
export const SHARED_STATE_NAMES = [
  "memory",
  "projects",
  "project-registry.json",
  "models",
] as const;

/** Real-home entries created when absent, so dev can write them into
 * being. */
export const REAL_DIRS_CREATED = ["memory", "projects"] as const;

export interface ShareResult {
  /** Names now symlinked dev → real (already correct counts). */
  linked: string[];
  /** Stale symlinks repointed at the real path. */
  refreshed: string[];
  /** Real paths that do not exist (yet) — nothing linked. */
  skipped: string[];
  /** Loud, human-actionable lines (pre-existing dev-only state). */
  warnings: string[];
}

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Link the real home's memory state into `devHome` per the header's rules.
 * Never deletes real-directory content; never throws for an occupied dev
 * path — the warning is the contract. Throws only on genuine IO failure.
 */
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
      // Stale link (an older real-home spelling, a moved home, a dangling
      // target): the link itself is dev-home metadata, safe to repoint.
      await rm(devPath);
      await symlink(realPath, devPath);
      result.refreshed.push(name);
      continue;
    }
    // A real directory/file in the dev home. Never delete, never merge:
    // this may be dev-only memory the user cares about, and only a human
    // knows which side wins.
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

/** The operator-facing summary `make run` prints. */
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
  if (result.linked.includes("projects") || result.refreshed.includes("projects")) {
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
