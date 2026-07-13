import { randomUUID } from "node:crypto";

import { evidenceMatches } from "./canonical";
import type { FsEvidence, ProjectKey, RebindReason } from "./types";

export type ProjectState = "READY" | "STOPPED" | "NEEDS_REBIND";

export interface ProjectRecord {
  hiveUuid: string;
  identityKey: string;
  /** The last path at which this Hive's directory was positively confirmed. */
  confirmedCanonicalPath: string;
  kind: ProjectKey["kind"];
  gitDir: string | null;
  gitCommonDir: string | null;
  repoFamilyKey: string | null;
  superprojectRoot: string | null;
  /** Plain Foundation bookmark, base64. Null when the helper was unavailable. */
  bookmark: string | null;
  evidence: FsEvidence;
  state: ProjectState;
  rebindReason: RebindReason | null;
}

export type TombstoneReason =
  /** The path's directory was replaced by a different one (delete+recreate, or an impostor). */
  | "RECREATED_OR_IMPOSTOR"
  /** An operator explicitly forgot the project. */
  | "FORGOTTEN";

export interface Tombstone {
  identityKey: string;
  formerHiveUuid: string;
  reason: TombstoneReason;
  /** The evidence that used to be at this path. Kept so an audit can explain the refusal. */
  formerEvidence: FsEvidence;
}
export interface ProjectRegistrySnapshot { records: ProjectRecord[]; tombstones: Tombstone[]; }

export class IdentityKeyOccupied extends Error {
  constructor(identityKey: string) {
    super(`identityKey already registered: ${identityKey}`);
    this.name = "IdentityKeyOccupied";
  }
}

/**
 * The Supervisor's `ProjectKey <-> HiveUUID` registry.
 *
 * Two invariants it exists to hold:
 *
 *  - `hiveUuid` is opaque and random. It is minted once and never derived from the
 *    path, because a path-derived id would make a recreated directory inherit the
 *    old Hive and would make a legitimate move look like a new project.
 *  - Nothing here attaches a Hive to a directory on matching evidence alone. Evidence
 *    is only ever used to refuse.
 */
export class ProjectRegistry {
  private readonly byUuid = new Map<string, ProjectRecord>();
  private readonly byIdentityKey = new Map<string, string>();
  private readonly tombstones = new Map<string, Tombstone>();

  get size(): number {
    return this.byUuid.size;
  }

  records(): ProjectRecord[] {
    return [...this.byUuid.values()];
  }
  snapshot(): ProjectRegistrySnapshot { return { records: structuredClone(this.records()), tombstones: structuredClone([...this.tombstones.values()]) }; }
  static hydrate(snapshot: ProjectRegistrySnapshot): ProjectRegistry {
    const registry = new ProjectRegistry();
    for (const record of snapshot.records) {
      if (registry.byUuid.has(record.hiveUuid) || registry.byIdentityKey.has(record.identityKey)) throw new Error("duplicate registry identity");
      registry.byUuid.set(record.hiveUuid, structuredClone(record)); registry.byIdentityKey.set(record.identityKey, record.hiveUuid);
    }
    for (const tombstone of snapshot.tombstones) registry.tombstones.set(tombstone.identityKey, structuredClone(tombstone));
    return registry;
  }

  findByIdentityKey(identityKey: string): ProjectRecord | null {
    const uuid = this.byIdentityKey.get(identityKey);
    return uuid ? (this.byUuid.get(uuid) ?? null) : null;
  }

  findByUuid(hiveUuid: string): ProjectRecord | null {
    return this.byUuid.get(hiveUuid) ?? null;
  }

  /**
   * Locate the record whose directory *is* the one described by `evidence`.
   *
   * This is the only reliable way to follow a move: a rename preserves inode and
   * birthtime, while a bookmark will abandon the moved directory the moment anything
   * reoccupies its old path. st_dev is deliberately excluded because mount device
   * numbers can change across reboots. Used to *offer a rebind*, never to attach silently.
   */
  findByEvidence(evidence: FsEvidence): ProjectRecord | null {
    for (const record of this.byUuid.values()) {
      if (evidenceMatches(record.evidence, evidence)) return record;
    }
    return null;
  }

  tombstoneFor(identityKey: string): Tombstone | null {
    return this.tombstones.get(identityKey) ?? null;
  }

  /** Explicit creation. Refuses to overwrite a live binding. */
  create(key: ProjectKey, evidence: FsEvidence, bookmark: string | null): ProjectRecord {
    if (this.byIdentityKey.has(key.identityKey)) throw new IdentityKeyOccupied(key.identityKey);
    const record: ProjectRecord = {
      hiveUuid: randomUUID(),
      identityKey: key.identityKey,
      confirmedCanonicalPath: key.canonicalPath,
      kind: key.kind,
      gitDir: key.gitDir,
      gitCommonDir: key.gitCommonDir,
      repoFamilyKey: key.repoFamilyKey,
      superprojectRoot: key.superprojectRoot,
      bookmark,
      evidence,
      state: "READY",
      rebindReason: null,
    };
    this.byUuid.set(record.hiveUuid, record);
    this.byIdentityKey.set(record.identityKey, record.hiveUuid);
    // Creating here clears the refusal; the operator has now made the decision.
    this.tombstones.delete(key.identityKey);
    return record;
  }

  /**
   * Explicit rebind of an existing Hive onto a new location. The operator, not the
   * resolver, decides that the directory now at `key` is the same project.
   */
  rebind(
    hiveUuid: string,
    key: ProjectKey,
    evidence: FsEvidence,
    bookmark: string | null,
  ): ProjectRecord {
    const record = this.byUuid.get(hiveUuid);
    if (!record) throw new Error(`unknown hiveUuid: ${hiveUuid}`);
    const occupant = this.byIdentityKey.get(key.identityKey);
    if (occupant !== undefined && occupant !== hiveUuid) throw new IdentityKeyOccupied(key.identityKey);

    this.byIdentityKey.delete(record.identityKey);
    record.identityKey = key.identityKey;
    record.confirmedCanonicalPath = key.canonicalPath;
    record.kind = key.kind;
    record.gitDir = key.gitDir;
    record.gitCommonDir = key.gitCommonDir;
    record.repoFamilyKey = key.repoFamilyKey;
    record.superprojectRoot = key.superprojectRoot;
    record.evidence = evidence;
    record.bookmark = bookmark;
    record.state = "READY";
    record.rebindReason = null;
    this.byIdentityKey.set(key.identityKey, hiveUuid);
    this.tombstones.delete(key.identityKey);
    return record;
  }

  /**
   * Break the path -> Hive binding and record why. The Hive itself survives: it may
   * still be alive at another path, and a later resolve there will offer a rebind.
   */
  tombstonePath(identityKey: string, reason: TombstoneReason): Tombstone | null {
    const record = this.findByIdentityKey(identityKey);
    if (!record) return null;
    const tombstone: Tombstone = {
      identityKey,
      formerHiveUuid: record.hiveUuid,
      reason,
      formerEvidence: record.evidence,
    };
    this.tombstones.set(identityKey, tombstone);
    this.byIdentityKey.delete(identityKey);
    return tombstone;
  }

  markNeedsRebind(hiveUuid: string, reason: RebindReason): void {
    const record = this.byUuid.get(hiveUuid);
    if (!record) return;
    record.state = "NEEDS_REBIND";
    record.rebindReason = reason;
  }
}
