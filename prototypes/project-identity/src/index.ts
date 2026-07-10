export { canonicalizeDirectory, evidenceMatches, evidenceOf, foldIdentityKey, isAtOrBeneath } from "./canonical";
export { FoundationBookmarkProvider, NullBookmarkProvider } from "./bookmark";
export type { BookmarkProvider, BookmarkResolution } from "./bookmark";
export { isLinkedWorktree, probeGit, repoFamilyKeyOf, sanitizedGitEnv } from "./git";
export type { GitProbe } from "./git";
export {
  InMemoryManagedWorktreeLedger,
  LedgerCapability,
  UnauthenticatedLedgerAccess,
} from "./ledger";
export type { ManagedWorktree, ManagedWorktreeLedger } from "./ledger";
export { IdentityKeyOccupied, ProjectRegistry } from "./registry";
export type { ProjectRecord, ProjectState, Tombstone, TombstoneReason } from "./registry";
export { clearCreationLeases, resolveOrCreate, resolveProject } from "./resolver";
export type { ResolveOptions } from "./resolver";
export type {
  FsEvidence,
  ProjectKey,
  ProjectKind,
  Provenance,
  RebindReason,
  RejectionReason,
  Resolution,
  SetupReason,
  VolumeBehavior,
} from "./types";
export { clearVolumeCache, describeVolume, setVolumeHelperPath } from "./volume";
