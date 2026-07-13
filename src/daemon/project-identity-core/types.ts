/** Shared vocabulary for the project-identity resolver. */

/**
 * How the volume under a path treats names. Drives identity-key folding.
 *
 * Both flags default to `true` (sensitive) when undetermined. That is the safe
 * default: folding is only ever a *merge*, and merging two genuinely distinct
 * directories into one Hive is worse than the alternative. Declining to fold
 * falls back to plain realpath(2), which was measured to canonicalize case and
 * Unicode normalization on its own for paths that exist.
 */
export interface VolumeBehavior {
  /** st_dev of the volume. Name behavior is a volume property, so this is the cache key. */
  dev: number;
  caseSensitive: boolean;
  caseProvenance: Provenance;
  normalizationSensitive: boolean;
  normalizationProvenance: Provenance;
  /** From Foundation's volumeIsLocal. Null when the Swift helper is unavailable. */
  isLocal: boolean | null;
}

/** Where a fact came from. `assumed` never justifies a destructive decision. */
export type Provenance = "foundation" | "probed" | "assumed";

/**
 * Filesystem evidence for a directory.
 *
 * The blueprint is right that these are "evidence only ... not persistent,
 * non-reusable identities". The asymmetry that makes them useful:
 *
 *   matching inode + birthtime  -> necessary but NOT sufficient to prove identity
 *   differing inode or birthtime -> DISPOSITIVE proof of non-identity
 *
 * The resolver therefore only ever uses durable evidence to *refuse*, never to
 * *accept*. A differing dev alone is not durable evidence because mounts can be
 * renumbered across reboots.
 */
export interface FsEvidence {
  /** Current mount's device number. Useful diagnostically, but not stable across reboots. */
  dev: number;
  ino: number;
  birthtimeMs: number;
}

export type ProjectKind =
  /** Ordinary Git worktree: the primary checkout of a repository. */
  | "git-worktree"
  /** `git worktree add` checkout. Distinct project; shares git-common-dir with its family. */
  | "git-linked-worktree"
  /** A submodule checkout. Its own nearest project; own git-common-dir. */
  | "git-submodule"
  /** No enclosing repository. Exact canonical root only. */
  | "plain-directory"
  /** A Hive-managed worker worktree, per the authenticated Supervisor ledger. */
  | "managed-worktree";

/**
 * The identity of a project. `identityKey` carries the registry's unique constraint;
 * everything else is descriptive.
 */
export interface ProjectKey {
  /**
   * Folded canonical path. Two invocations that name the same directory must
   * produce the same `identityKey`; two distinct directories never may.
   */
  identityKey: string;
  /** realpath(2) of the project root: on-disk case and Unicode normalization. */
  canonicalPath: string;
  kind: ProjectKind;
  /** Absolute (`--path-format=absolute`). Null for plain directories. */
  gitDir: string | null;
  /** Absolute. Equals `gitDir` except in linked worktrees. Null for plain directories. */
  gitCommonDir: string | null;
  /**
   * realpath(gitCommonDir). Linked worktrees of one repository share this and must
   * therefore share a landing lease. Separate clones and submodules do not.
   */
  repoFamilyKey: string | null;
  /** Set only for a submodule: the superproject's working tree. */
  superprojectRoot: string | null;
  volume: VolumeBehavior;
}

export type RejectionReason =
  | "NO_SUCH_DIRECTORY"
  | "NOT_A_DIRECTORY"
  | "BARE_REPOSITORY"
  | "INSIDE_GIT_DIR"
  | "USE_PARENT_AFTER_REGISTRATION";

export type RebindReason =
  /** Confirmed path no longer holds the recorded directory; the directory was found elsewhere. */
  | "MOVED"
  /** Bookmark and confirmed path disagree while evidence still matches. */
  | "BOOKMARK_DISAGREEMENT"
  /** The recorded directory is gone and was not found anywhere. */
  | "LOST";

export type SetupReason =
  | "NEW_PROJECT"
  /** The path was previously bound to a Hive that no longer lives here. Never auto-inherit. */
  | "TOMBSTONED_PATH";

/** The resolver never mutates on ambiguity; it returns a state a human must resolve. */
export type Resolution =
  | { status: "RESOLVED"; key: ProjectKey; hiveUuid: string; evidence: FsEvidence }
  | {
      status: "NEEDS_REBIND";
      key: ProjectKey;
      reason: RebindReason;
      /** The Hive that owns this project, preserved across the rebind. */
      hiveUuid: string;
      confirmedCanonicalPath: string;
      detail: string;
    }
  | {
      status: "NEEDS_SETUP";
      key: ProjectKey;
      reason: SetupReason;
      evidence: FsEvidence;
      /** Set when a tombstone covers this path: the Hive that used to live here. */
      formerHiveUuid?: string;
      detail?: string;
    }
  | {
      status: "AMBIGUOUS_PLAIN_ANCESTOR";
      key: ProjectKey;
      ancestorPath: string;
      ancestorHiveUuid: string;
      detail: string;
    }
  | { status: "REJECTED"; reason: RejectionReason; path: string; detail: string };
