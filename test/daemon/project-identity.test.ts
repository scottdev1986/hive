import { afterAll, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

import {
  evidenceMatches,
  InMemoryManagedWorktreeLedger,
  LedgerCapability,
  ProjectRegistry,
  resolveOrCreate,
} from "../../src/daemon/project-identity-core";
import { repairLegacyMountEvidence, resolveHandshakeProject } from "../../src/daemon/project-identity";

const originalHiveHome = process.env.HIVE_HOME;
const root = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-project-identity-"));
const hiveHome = join(root, "home");
const project = join(root, "project");
mkdirSync(hiveHome);
mkdirSync(project);
process.env.HIVE_HOME = hiveHome;

afterAll(() => {
  if (originalHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHiveHome;
  rmSync(root, { recursive: true, force: true });
});

describe("durable project identity", () => {
  test("a changed mount device number does not require project setup", () => {
    const registry = new ProjectRegistry();
    const created = resolveOrCreate(project, {
      registry,
      ledger: new InMemoryManagedWorktreeLedger(),
      ledgerCapability: LedgerCapability.issue("test"),
    }, "seed");
    expect(created.status).toBe("RESOLVED");
    if (created.status !== "RESOLVED") throw new Error("project was not created");

    const snapshot = registry.snapshot();
    snapshot.records[0]!.evidence.dev += 1;
    writeFileSync(join(hiveHome, "project-registry.json"), JSON.stringify(snapshot));

    expect(resolveHandshakeProject(project).hiveUuid).toBe(created.hiveUuid);
    const persisted = JSON.parse(
      readFileSync(join(hiveHome, "project-registry.json"), "utf8"),
    );
    expect(persisted.tombstones).toEqual([]);
    expect(persisted.records[0].evidence.dev).toBe(statSync(project).dev);
  });

  test("a staged fixed binary repairs evidence for a pre-fix updater", () => {
    const registry = new ProjectRegistry();
    const created = resolveOrCreate(project, {
      registry,
      ledger: new InMemoryManagedWorktreeLedger(),
      ledgerCapability: LedgerCapability.issue("test"),
    }, "legacy-seed");
    if (created.status !== "RESOLVED") throw new Error("project was not created");

    const snapshot = registry.snapshot();
    snapshot.records[0]!.evidence.dev += 1;
    writeFileSync(join(hiveHome, "project-registry.json"), JSON.stringify(snapshot));
    const current = {
      dev: statSync(project).dev,
      ino: statSync(project).ino,
      birthtimeMs: statSync(project).birthtimeMs,
    };
    const legacyMatches = (left: typeof current, right: typeof current) =>
      left.dev === right.dev && left.ino === right.ino &&
      left.birthtimeMs === right.birthtimeMs;
    expect(legacyMatches(snapshot.records[0]!.evidence, current)).toBe(false);

    expect(repairLegacyMountEvidence(project)).toBe(true);
    const repaired = JSON.parse(
      readFileSync(join(hiveHome, "project-registry.json"), "utf8"),
    );
    expect(legacyMatches(repaired.records[0].evidence, current)).toBe(true);
    expect(repaired.records[0].hiveUuid).toBe(created.hiveUuid);
    expect(repaired.tombstones).toEqual([]);
  });

  test("an atomic registry write preserves a dev-home symlink", () => {
    const registryPath = join(hiveHome, "project-registry.json");
    const sharedHome = join(root, "shared-home");
    const sharedRegistry = join(sharedHome, "project-registry.json");
    mkdirSync(sharedHome, { recursive: true });
    writeFileSync(sharedRegistry, '{"records":[],"tombstones":[]}');
    rmSync(registryPath, { force: true });
    symlinkSync(sharedRegistry, registryPath);

    resolveHandshakeProject(project);

    expect(lstatSync(registryPath).isSymbolicLink()).toBe(true);
    const persisted = JSON.parse(readFileSync(sharedRegistry, "utf8"));
    expect(persisted.records).toHaveLength(1);
    expect(persisted.tombstones).toEqual([]);
  });

  test("inode or birth-time changes still prove directory replacement", () => {
    const evidence = { dev: 10, ino: 20, birthtimeMs: 30 };
    expect(evidenceMatches(evidence, { ...evidence, dev: 11 })).toBe(true);
    expect(evidenceMatches(evidence, { ...evidence, ino: 21 })).toBe(false);
    expect(evidenceMatches(evidence, { ...evidence, birthtimeMs: 31 })).toBe(false);
  });
});
