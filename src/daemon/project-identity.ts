import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHiveHome } from "./db";
import { InMemoryManagedWorktreeLedger, LedgerCapability, ProjectRegistry, resolveOrCreate, type ProjectRegistrySnapshot } from "../../prototypes/project-identity/src/index";

const path = () => join(getHiveHome(), "project-registry.json");

// The registry maps every project this install has ever resolved; treating a
// read failure as "no file yet" and then rewriting the file would silently
// reset all of them to just the current project. So: a missing file is the
// normal first boot, a corrupt file is moved aside (evidence preserved) before
// starting fresh, and any other IO error fails the handshake instead of
// clobbering state it never read.
function loadRegistry(): ProjectRegistry {
  let raw: string;
  try {
    raw = readFileSync(path(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new ProjectRegistry();
    }
    throw error;
  }
  try {
    return ProjectRegistry.hydrate(JSON.parse(raw) as ProjectRegistrySnapshot);
  } catch (error) {
    const quarantine = `${path()}.corrupt-${Date.now()}`;
    try {
      renameSync(path(), quarantine);
    } catch {
      // If even the rename fails the fresh write below still recovers the
      // daemon; only the forensic copy is lost.
    }
    console.error(
      `Hive project registry was unreadable and has been moved to ${quarantine}; starting a fresh registry: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return new ProjectRegistry();
  }
}

export function resolveHandshakeProject(directory: string) {
  const registry = loadRegistry();
  const result = resolveOrCreate(directory, { registry, ledger: new InMemoryManagedWorktreeLedger(), ledgerCapability: LedgerCapability.issue("launcher") }, "launcher");
  if (result.status !== "RESOLVED") throw new Error(`Project identity requires operator action: ${result.status}`);
  mkdirSync(getHiveHome(), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a half-written file
  // for the next boot's corruption path to quarantine.
  const temp = `${path()}.tmp`;
  writeFileSync(temp, JSON.stringify(registry.snapshot()));
  renameSync(temp, path());
  return { hiveUuid: result.hiveUuid, identityKey: result.key.identityKey, repoFamilyKey: result.key.repoFamilyKey };
}
