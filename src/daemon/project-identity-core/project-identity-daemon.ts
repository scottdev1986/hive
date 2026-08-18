import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getHiveHome } from "../../hive-home/home";
import {
  InMemoryManagedWorktreeLedger,
  LedgerCapability,
  ProjectRegistry,
  type ProjectRegistrySnapshot,
  resolveOrCreate,
} from "./project-identity-service";

const path = (hiveHome: string) => join(hiveHome, "project-registry.json");

// The registry maps every project this install has ever resolved; treating a read failure as "no file yet" and then rewriting the file would silently reset all of them to just the current project. So: a missing file is the normal first boot, a corrupt file is moved aside (evidence preserved) before starting fresh, and any other IO error fails the handshake instead of clobbering state it never read.
function loadRegistry(hiveHome: string): ProjectRegistry {
  let raw: string;
  try {
    raw = readFileSync(path(hiveHome), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new ProjectRegistry();
    }
    throw error;
  }
  try {
    return ProjectRegistry.hydrate(JSON.parse(raw) as ProjectRegistrySnapshot);
  } catch (error) {
    const quarantine = `${path(hiveHome)}.corrupt-${Date.now()}`;
    try {
      renameSync(path(hiveHome), quarantine);
    } catch {
      // If even the rename fails the fresh write below still recovers the daemon; only the forensic copy is lost.
    }
    console.error(
      `Hive project registry was unreadable and has been moved to ${quarantine}; starting a fresh registry: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return new ProjectRegistry();
  }
}

export function resolveHandshakeProject(
  directory: string,
  hiveHome: string = getHiveHome(),
) {
  const registry = loadRegistry(hiveHome);
  const result = resolveOrCreate(
    directory,
    {
      registry,
      ledger: new InMemoryManagedWorktreeLedger(),
      ledgerCapability: LedgerCapability.issue("launcher"),
    },
    "launcher",
  );
  if (result.status !== "RESOLVED")
    throw new Error(`Project identity requires user action: ${result.status}`);
  persistRegistry(registry, hiveHome);
  return {
    hiveUuid: result.hiveUuid,
    identityKey: result.key.identityKey,
    repoFamilyKey: result.key.repoFamilyKey,
  };
}

/** The path an atomic registry write must land on. A dev home symlinks the registry into `~/.hive`; renaming onto the link itself would replace it and fork dev's identity from the later installed release, so the link is resolved first. A missing file (first boot) resolves to the path itself. Exported so the symlink-survival behaviour can be exercised directly rather than re-implemented by a caller that could drift from it. */
export function registryWritePath(target = path(getHiveHome())): string {
  try {
    return realpathSync.native(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
    throw error;
  }
}

function persistRegistry(registry: ProjectRegistry, hiveHome: string): void {
  mkdirSync(hiveHome, { recursive: true });
  const registryPath = registryWritePath(path(hiveHome));
  // Write-then-rename so a crash mid-write cannot leave a half-written file for the next boot's corruption path to quarantine. The temp name carries the pid: a fixed one is not a private staging file at all, and two processes resolving identity at the same moment would rename each other's temp out from under themselves — the second `renameSync` dying with ENOENT. A dev home symlinks this file into ~/.hive. Resolve that link before the atomic rename; renaming onto the link itself would replace it and fork dev's identity from the later installed release.
  const temp = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(registry.snapshot()));
  renameSync(temp, registryPath);
}
