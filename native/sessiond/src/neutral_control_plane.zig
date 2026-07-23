//! Frozen A0 LIST/INSPECT/TERMINATE projection for the neutral host seam.
//!
//! Hive locator and visibility policy never crosses this module. Controller
//! operations address only an exact neutral SessionRef and preserve measured
//! partial/unavailable evidence when a live host cannot be reached.

const neutral_evidence = @import("neutral_evidence");
const neutral_ops = @import("neutral_operations");

pub const Completeness = neutral_evidence.Completeness;
pub const WireProcessIdentity = neutral_evidence.WireProcessIdentity;
pub const WireWindowSize = neutral_evidence.WireWindowSize;
pub const WireJobControlEvidence = neutral_evidence.WireJobControlEvidence;
pub const WireExitStatus = neutral_evidence.WireExitStatus;
pub const WireReapEvidence = neutral_evidence.WireReapEvidence;
pub const WireCheckpoint = neutral_evidence.WireCheckpoint;
pub const WireInputClaim = neutral_evidence.WireInputClaim;
pub const WireSurvivor = neutral_evidence.WireSurvivor;
pub const WireInspection = neutral_evidence.WireInspection;
pub const WireInspectionPayload = neutral_evidence.WireInspectionPayload;
const InspectRequest = neutral_evidence.InspectRequest;
const TerminateRequest = neutral_evidence.TerminateRequest;
pub const WireAppliedResizePayload = neutral_evidence.WireAppliedResizePayload;
pub const WireStaleResizePayload = neutral_evidence.WireStaleResizePayload;
pub const WireUnknownResizePayload = neutral_evidence.WireUnknownResizePayload;
pub const AppliedResize = neutral_evidence.AppliedResize;
pub const TerminalResize = neutral_evidence.TerminalResize;
pub const TerminalProvider = neutral_evidence.TerminalProvider;
pub const WireTerminationResult = neutral_evidence.WireTerminationResult;
pub const WireTerminationPayload = neutral_evidence.WireTerminationPayload;
pub const CheckpointSnapshot = neutral_evidence.CheckpointSnapshot;
pub const LiveEvidence = neutral_evidence.LiveEvidence;
pub const EvidenceProvider = neutral_evidence.EvidenceProvider;
pub const EvidenceClock = neutral_evidence.EvidenceClock;
const makeCheckpoint = neutral_evidence.makeCheckpoint;
const buildInspection = neutral_evidence.buildInspection;
const canonicalTermination = neutral_evidence.canonicalTermination;
pub const HostOperations = neutral_ops.HostOperations;
pub const Controller = neutral_ops.Controller;
