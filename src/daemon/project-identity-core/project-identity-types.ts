export interface VolumeBehavior {
  dev: number;
  caseSensitive: boolean;
  caseProvenance: Provenance;
  normalizationSensitive: boolean;
  normalizationProvenance: Provenance;
  isLocal: boolean | null;
}

/** Where a fact came from. `assumed` never justifies a destructive decision. */
export type Provenance = "foundation" | "probed" | "assumed";

/** Filesystem evidence for a directory. The blueprint is right that these are "evidence only ... not persistent, non-reusable identities". The asymmetry that makes them useful: matching inode + birthtime -> necessary but NOT sufficient to prove identity differing inode or birthtime -> DISPOSITIVE proof of non-identity The resolver therefore only ever uses durable evidence to *refuse*, never to *accept*. A differing dev alone is not durable evidence because mounts can be renumbered across reboots. */
export interface FsEvidence {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

export type ProjectKind =
  /** Ordinary Git worktree: the primary checkout of a repository. */
  | "git-worktree"
  /** `git worktree add` checkout. Distinct project; shares git-common-dir with its family. */
  | "git-linked-worktree"
  | "git-submodule"
  | "plain-directory"
  /** A Hive-managed worker worktree, per the authenticated Supervisor ledger. */
  | "managed-worktree";

export interface ProjectKey {
  /** Folded canonical path. Two invocations that name the same directory must produce the same `identityKey`; two distinct directories never may. */
  identityKey: string;
  canonicalPath: string;
  kind: ProjectKind;
  gitDir: string | null;
  gitCommonDir: string | null;
  /** realpath(gitCommonDir). Linked worktrees of one repository share this and must therefore share a landing lease. Separate clones and submodules do not. */
  repoFamilyKey: string | null;
  superprojectRoot: string | null;
  volume: VolumeBehavior;
}

export type RejectionReason =
  | "NO_SUCH_DIRECTORY"
  | "NOT_A_DIRECTORY"
  | "BARE_REPOSITORY"
  | "INSIDE_GIT_DIR"
  | "USE_PARENT_AFTER_REGISTRATION";

export type RebindReason = "MOVED" | "BOOKMARK_DISAGREEMENT" | "LOST";

export type SetupReason =
  | "NEW_PROJECT"
  /** The path is bound to a Hive that no longer lives here. Never auto-inherit. */
  | "TOMBSTONED_PATH";

/** The resolver never mutates on ambiguity; it returns a state a user must resolve. */
export type Resolution =
  | {
      status: "RESOLVED";
      key: ProjectKey;
      hiveUuid: string;
      evidence: FsEvidence;
    }
  | {
      status: "NEEDS_REBIND";
      key: ProjectKey;
      reason: RebindReason;
      hiveUuid: string;
      confirmedCanonicalPath: string;
      detail: string;
    }
  | {
      status: "NEEDS_SETUP";
      key: ProjectKey;
      reason: SetupReason;
      evidence: FsEvidence;
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
  | {
      status: "REJECTED";
      reason: RejectionReason;
      path: string;
      detail: string;
    };
