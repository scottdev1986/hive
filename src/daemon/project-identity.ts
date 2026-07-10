import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHiveHome } from "./db";
import { InMemoryManagedWorktreeLedger, LedgerCapability, ProjectRegistry, resolveOrCreate, type ProjectRegistrySnapshot } from "../../prototypes/project-identity/src/index";

const path = () => join(getHiveHome(), "project-registry.json");
export function resolveHandshakeProject(directory: string) {
  let registry: ProjectRegistry;
  try { registry = ProjectRegistry.hydrate(JSON.parse(readFileSync(path(), "utf8")) as ProjectRegistrySnapshot); }
  catch { registry = new ProjectRegistry(); }
  const result = resolveOrCreate(directory, { registry, ledger: new InMemoryManagedWorktreeLedger(), ledgerCapability: LedgerCapability.issue("launcher") }, "launcher");
  if (result.status !== "RESOLVED") throw new Error(`Project identity requires operator action: ${result.status}`);
  mkdirSync(getHiveHome(), { recursive: true }); writeFileSync(path(), JSON.stringify(registry.snapshot()));
  return { hiveUuid: result.hiveUuid, identityKey: result.key.identityKey, repoFamilyKey: result.key.repoFamilyKey };
}
