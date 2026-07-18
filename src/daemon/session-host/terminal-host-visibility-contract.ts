import type {
  Completeness,
  CreateRequest,
  CreateResult,
  ProcessIdentity,
  Sequence,
  SessionRef,
  TerminalHost,
} from "./terminal-host-contract";

/**
 * Project-neutral visibility extension for terminal hosts whose process
 * lifetime is authorized by a live external representation.
 */
export const TERMINAL_HOST_VISIBILITY_CONTRACT_VERSION = "1.0.0" as const;

export type VisibilitySourceIdentity = Readonly<{
  sessionId: string;
  process: ProcessIdentity;
}>;

export type VisibilityRequest = Readonly<{
  source: VisibilitySourceIdentity;
  inventoryRevision: Sequence;
}>;

export type VisibilityLease = Readonly<{
  session: SessionRef;
  source: VisibilitySourceIdentity;
  acceptedRevision: Sequence;
  state: "active";
  issuedAt: string;
  expiresAt: string;
}>;

export type VisibilityRejectionReason =
  | "invalid-revision"
  | "stale-revision"
  | "unverified-revision"
  | "source-identity-mismatch"
  | "source-not-live"
  | "session-not-represented"
  | "duplicate-session-owner"
  | "session-generation-mismatch"
  | "lease-expired";

export type VisibilityRejected = Readonly<{
  state: "rejected";
  reason: VisibilityRejectionReason;
  completeness: "complete";
  currentRevision: Sequence | null;
  diagnostic: string;
}>;

export type VisibilityUnknown = Readonly<{
  state: "unknown";
  completeness: Exclude<Completeness, "complete">;
  currentRevision: Sequence | null;
  diagnostic: string;
}>;

export type VisibilityCreateRequest = Readonly<{
  terminal: CreateRequest;
  visibility: VisibilityRequest;
}>;

type VisibilityCreateFailurePostconditions = Readonly<{
  createInvoked: false;
  session: null;
  lease: null;
}>;

export type VisibilityCreateResult =
  | Readonly<{
      state: "created";
      result: CreateResult;
      lease: VisibilityLease;
    }>
  | ((VisibilityRejected | VisibilityUnknown) & VisibilityCreateFailurePostconditions);

export type VisibilityRenewalRequest = Readonly<{
  session: SessionRef;
  visibility: VisibilityRequest;
}>;

type VisibilityRenewalFailurePostconditions = Readonly<{
  renewed: false;
}>;

export type VisibilityRenewalResult =
  | Readonly<{ state: "active"; lease: VisibilityLease }>
  | ((VisibilityRejected | VisibilityUnknown) & VisibilityRenewalFailurePostconditions);

export interface VisibilityAdmissionHost {
  create(request: VisibilityCreateRequest): Promise<VisibilityCreateResult>;
  renewVisibility(request: VisibilityRenewalRequest): Promise<VisibilityRenewalResult>;
}

/**
 * Required host profile for visibility-backed creation. Its `create` replaces
 * the unguarded base operation; all other A0 operations retain their shape.
 */
export type VisibilityTerminalHost =
  Omit<TerminalHost, "create"> & VisibilityAdmissionHost;
