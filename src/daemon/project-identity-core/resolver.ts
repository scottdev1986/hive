import { realpathSync } from "node:fs";
import { dirname } from "node:path";

import { canonicalizeDirectory, evidenceMatches, foldIdentityKey, isAtOrBeneath } from "./canonical";
import { isLinkedWorktree, probeGit, repoFamilyKeyOf } from "./git";
import type { BookmarkProvider } from "./bookmark";
import { NullBookmarkProvider } from "./bookmark";
import type { LedgerCapability, ManagedWorktreeLedger } from "./ledger";
import type { ProjectRegistry } from "./registry";
import type { FsEvidence, ProjectKey, Resolution } from "./types";

export interface ResolveOptions {
  registry: ProjectRegistry;
  ledger: ManagedWorktreeLedger;
  ledgerCapability: LedgerCapability;
  bookmarks?: BookmarkProvider;
  /**
   * Ephemeral "Use Parent" override for a nested repository or submodule. Legal only
   * while the child is unregistered; afterwards the child owns its root permanently.
   */
  useParent?: boolean;
}

function reject(
  reason: Extract<Resolution, { status: "REJECTED" }>["reason"],
  path: string,
  detail: string,
): Resolution {
  return { status: "REJECTED", reason, path, detail };
}

/**
 * Steps 1-6 of the blueprint's resolver order, then reconciliation against the registry.
 * The function is pure with respect to the filesystem: it reads, and it never creates,
 * moves, or deletes anything.
 */
export function resolveProject(directory: string, options: ResolveOptions): Resolution {
  const bookmarks = options.bookmarks ?? new NullBookmarkProvider();

  // Step 1 -- canonicalize the existing invocation directory.
  const canonical = canonicalizeDirectory(directory);
  if (!canonical.ok) {
    return reject(canonical.error, directory, `cannot canonicalize ${directory}`);
  }
  const { canonicalPath: invocationPath, volume } = canonical.value;

  // Step 2 -- authenticated managed-worktree ownership, before any repository is read.
  const managed = options.ledger.lookup(invocationPath, options.ledgerCapability);
  if (managed) {
    const probe = probeGit(invocationPath);
    const key: ProjectKey = {
      identityKey: foldIdentityKey(invocationPath, volume),
      canonicalPath: invocationPath,
      kind: "managed-worktree",
      gitDir: probe.gitDir,
      gitCommonDir: probe.gitCommonDir,
      repoFamilyKey: probe.gitCommonDir ? repoFamilyKeyOf(probe.gitCommonDir) : null,
      superprojectRoot: probe.superprojectRoot,
      volume,
    };
    // A managed worktree routes to its owning Hive; it is never its own project.
    return {
      status: "RESOLVED",
      key,
      hiveUuid: managed.owningHiveUuid,
      evidence: canonical.value.evidence,
    };
  }

  // Step 3 -- discover the nearest Git worktree.
  const probe = probeGit(invocationPath);

  if (probe.isBare) {
    return reject("BARE_REPOSITORY", invocationPath, "a bare repository has no worktree to own");
  }
  if (probe.isInsideGitDir) {
    return reject("INSIDE_GIT_DIR", invocationPath, "the Git directory is not a project root");
  }

  const key = probe.isRepository
    ? gitProjectKey(probe, volume, options)
    : plainProjectKey(invocationPath, volume);

  if (key === null) {
    return reject(
      "USE_PARENT_AFTER_REGISTRATION",
      invocationPath,
      "the nested project is already registered; Use Parent is no longer available",
    );
  }

  // Steps 4-6 produced a root. Everything below is registry reconciliation.
  const rootCanonical = canonicalizeDirectory(key.canonicalPath);
  if (!rootCanonical.ok) return reject(rootCanonical.error, key.canonicalPath, "root vanished");
  const evidence = rootCanonical.value.evidence;

  if (key.kind === "plain-directory") {
    const ancestor = findRegisteredPlainAncestor(options.registry, key, volume);
    if (ancestor) {
      return {
        status: "AMBIGUOUS_PLAIN_ANCESTOR",
        key,
        ancestorPath: ancestor.confirmedCanonicalPath,
        ancestorHiveUuid: ancestor.hiveUuid,
        detail:
          "a registered plain-directory project encloses this path; attach to it or " +
          "deliberately create a nested project",
      };
    }
  }

  return reconcile(key, evidence, options.registry, bookmarks);
}

function gitProjectKey(
  probe: ReturnType<typeof probeGit>,
  volume: ProjectKey["volume"],
  options: ResolveOptions,
): ProjectKey | null {
  const topLevel = probe.topLevel;
  const gitDir = probe.gitDir;
  const gitCommonDir = probe.gitCommonDir;
  if (!topLevel || !gitDir || !gitCommonDir) return null;

  // Step 4 -- the canonical physical worktree root is the boundary. Nested paths and
  // symlink aliases arrive here already collapsed onto it by realpath + rev-parse.
  const root = realpathSync.native(topLevel);

  if (options.useParent) {
    // Only legal before the child is registered. The child is whatever rev-parse just found.
    const childKey = foldIdentityKey(root, volume);
    if (options.registry.findByIdentityKey(childKey)) return null;

    const parentProbe = probeGit(dirname(root));
    if (parentProbe.topLevel && parentProbe.gitCommonDir && parentProbe.gitDir) {
      return keyFromProbe(realpathSync.native(parentProbe.topLevel), parentProbe, volume);
    }
    // No enclosing repository: Use Parent has nothing to select, so fall through.
  }

  return keyFromProbe(root, probe, volume);
}

function keyFromProbe(
  root: string,
  probe: ReturnType<typeof probeGit>,
  volume: ProjectKey["volume"],
): ProjectKey {
  const gitDir = probe.gitDir as string;
  const gitCommonDir = probe.gitCommonDir as string;

  // Step 5 -- a user-created linked worktree is a distinct writable project even
  // though it shares git-common-dir. A submodule is its own nearest project and has
  // its own common dir. Separate clones differ by common dir and so are distinct.
  const linked = isLinkedWorktree(probe);
  const kind: ProjectKey["kind"] = probe.superprojectRoot
    ? "git-submodule"
    : linked
      ? "git-linked-worktree"
      : "git-worktree";

  return {
    identityKey: foldIdentityKey(root, volume),
    canonicalPath: root,
    kind,
    gitDir,
    gitCommonDir,
    repoFamilyKey: repoFamilyKeyOf(gitCommonDir),
    superprojectRoot: probe.superprojectRoot ? realpathSync.native(probe.superprojectRoot) : null,
    volume,
  };
}

/** Step 6 -- a plain directory uses its exact canonical root. */
function plainProjectKey(canonicalPath: string, volume: ProjectKey["volume"]): ProjectKey {
  return {
    identityKey: foldIdentityKey(canonicalPath, volume),
    canonicalPath,
    kind: "plain-directory",
    gitDir: null,
    gitCommonDir: null,
    repoFamilyKey: null,
    superprojectRoot: null,
    volume,
  };
}

function findRegisteredPlainAncestor(
  registry: ProjectRegistry,
  key: ProjectKey,
  volume: ProjectKey["volume"],
) {
  for (const record of registry.records()) {
    if (record.kind !== "plain-directory") continue;
    if (record.confirmedCanonicalPath === key.canonicalPath) continue;
    if (isAtOrBeneath(key.canonicalPath, record.confirmedCanonicalPath, volume)) return record;
  }
  return null;
}

/**
 * Compare what is on disk with what the registry believes.
 *
 * The ordering matters. Evidence is checked *before* the bookmark, because a plain
 * Foundation bookmark resolves path-first: once any directory reoccupies a project's
 * old path, the bookmark points at that impostor and agrees with the confirmed path.
 * A resolver that trusted "resolved path == confirmed path" would attach the wrong
 * directory. Only the inode/birthtime mismatch catches it, and only by refusing.
 */
function reconcile(
  key: ProjectKey,
  evidence: FsEvidence,
  registry: ProjectRegistry,
  bookmarks: BookmarkProvider,
): Resolution {
  const existing = registry.findByIdentityKey(key.identityKey);

  if (existing) {
    if (!evidenceMatches(existing.evidence, evidence)) {
      // The directory standing at this path is not the one we registered. It may be a
      // recreation of a deleted project, or an unrelated directory that took the path
      // while the real project moved away. Never inherit; break the binding and refuse.
      registry.tombstonePath(key.identityKey, "RECREATED_OR_IMPOSTOR");
      registry.markNeedsRebind(existing.hiveUuid, "LOST");
      return {
        status: "NEEDS_SETUP",
        key,
        reason: "TOMBSTONED_PATH",
        evidence,
        formerHiveUuid: existing.hiveUuid,
        detail:
          "a different directory now occupies this path; the previous Hive is tombstoned " +
          "here and requires an explicit create or rebind",
      };
    }

    // Same inode. Corroborate with the bookmark, which can still disagree if the
    // directory is reachable at two paths (for example a stale hardlinked mount).
    if (existing.bookmark && bookmarks.available) {
      const resolved = bookmarks.resolve(existing.bookmark);
      if (resolved) {
        const resolvedReal = safeRealpath(resolved.path);
        if (resolvedReal !== null && resolvedReal !== existing.confirmedCanonicalPath) {
          registry.markNeedsRebind(existing.hiveUuid, "BOOKMARK_DISAGREEMENT");
          return {
            status: "NEEDS_REBIND",
            key,
            reason: "BOOKMARK_DISAGREEMENT",
            hiveUuid: existing.hiveUuid,
            confirmedCanonicalPath: existing.confirmedCanonicalPath,
            detail: `bookmark resolved to ${resolvedReal}, confirmed path is ${existing.confirmedCanonicalPath}`,
          };
        }
      }
    }

    // `dev` is useful current-mount evidence even though it is not durable
    // identity. Refresh it after inode + birth time have positively matched so
    // pre-fix launchers can consume a registry repaired by a newer binary.
    registry.refreshEvidence(existing.hiveUuid, evidence);
    return { status: "RESOLVED", key, hiveUuid: existing.hiveUuid, evidence };
  }

  // No record at this path. Is a registered project's *directory* standing here? A
  // rename preserves dev, ino and birthtime, so this is how a move is detected. A
  // cross-volume move copies, producing a new inode, and is correctly a new project.
  const moved = registry.findByEvidence(evidence);
  if (moved) {
    registry.markNeedsRebind(moved.hiveUuid, "MOVED");
    return {
      status: "NEEDS_REBIND",
      key,
      reason: "MOVED",
      hiveUuid: moved.hiveUuid,
      confirmedCanonicalPath: moved.confirmedCanonicalPath,
      detail: `the directory registered at ${moved.confirmedCanonicalPath} is now at ${key.canonicalPath}`,
    };
  }

  const tombstone = registry.tombstoneFor(key.identityKey);
  if (tombstone) {
    return {
      status: "NEEDS_SETUP",
      key,
      reason: "TOMBSTONED_PATH",
      evidence,
      formerHiveUuid: tombstone.formerHiveUuid,
      detail: `this path was previously bound to ${tombstone.formerHiveUuid} (${tombstone.reason})`,
    };
  }

  return { status: "NEEDS_SETUP", key, reason: "NEW_PROJECT", evidence };
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** In-flight creation leases, keyed by identityKey, then by idempotency key. */
const leases = new Map<string, string>();

/**
 * `resolveOrCreate(ProjectKey, idempotencyKey)`: N simultaneous starts for one root
 * yield one HiveUUID. The unique constraint lives in the registry; the lease exists so
 * concurrent callers observe the same answer rather than racing to create.
 */
export function resolveOrCreate(
  directory: string,
  options: ResolveOptions,
  idempotencyKey: string,
): Resolution {
  const first = resolveProject(directory, options);
  if (first.status !== "NEEDS_SETUP" || first.reason !== "NEW_PROJECT") return first;

  const leaseKey = `${first.key.identityKey} ${idempotencyKey}`;
  const held = leases.get(leaseKey);
  if (held) {
    const record = options.registry.findByUuid(held);
    if (record) return { status: "RESOLVED", key: first.key, hiveUuid: held, evidence: first.evidence };
  }

  const existing = options.registry.findByIdentityKey(first.key.identityKey);
  if (existing) {
    return { status: "RESOLVED", key: first.key, hiveUuid: existing.hiveUuid, evidence: first.evidence };
  }

  const bookmarks = options.bookmarks ?? new NullBookmarkProvider();
  const bookmark = bookmarks.available ? bookmarks.create(first.key.canonicalPath) : null;
  const record = options.registry.create(first.key, first.evidence, bookmark);
  leases.set(leaseKey, record.hiveUuid);
  return { status: "RESOLVED", key: first.key, hiveUuid: record.hiveUuid, evidence: first.evidence };
}

export function clearCreationLeases(): void {
  leases.clear();
}
