export type { BookmarkProvider, BookmarkResolution } from "./bookmark";
export { FoundationBookmarkProvider, NullBookmarkProvider } from "./bookmark";
export {
  canonicalizeDirectory,
  evidenceMatches,
  evidenceOf,
  foldIdentityKey,
  isAtOrBeneath,
} from "./canonical";
export type { GitProbe } from "./git";
export {
  isLinkedWorktree,
  probeGit,
  repoFamilyKeyOf,
  sanitizedGitEnv,
} from "./git";
export type { ManagedWorktree, ManagedWorktreeLedger } from "./ledger";
export {
  InMemoryManagedWorktreeLedger,
  LedgerCapability,
  UnauthenticatedLedgerAccess,
} from "./ledger";
export type {
  ProjectRecord,
  ProjectRegistrySnapshot,
  ProjectState,
  Tombstone,
  TombstoneReason,
} from "./registry";
export { IdentityKeyOccupied, ProjectRegistry } from "./registry";
export type { ResolveOptions } from "./resolver";
export {
  clearCreationLeases,
  resolveOrCreate,
  resolveProject,
} from "./resolver";
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
export {
  clearVolumeCache,
  describeVolume,
  setVolumeHelperPath,
} from "./volume";
