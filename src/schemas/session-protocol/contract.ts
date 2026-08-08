import { CHECKPOINT_HEADER } from "./checkpoint-header";
import {
  FRAME_FLAGS,
  FRAME_HEADER,
  FRAME_TYPE_GROUPS,
  FRAME_TYPES,
  GHOSTTY_BRIDGE_EVENTS,
  RAW_BYTE_FRAME_TYPES,
  WIRE_ERROR_CODES,
} from "./frames";
import {
  INPUT_ARBITER_STATES,
  INPUT_ARBITER_TRANSITIONS,
  INPUT_EVIDENCE_CONTRACTS,
  INPUT_EVIDENCE_LEVELS,
} from "./input-arbiter";
import { TERMINAL_LIMITS } from "./limits";
import { SESSION_PROTOCOL_PATHS } from "./session-protocol-paths";
import { SESSION_PROTOCOL_VERSION } from "./session-protocol-version";

export const SESSION_HOST_PERMISSIONS = {
  inspect: ["authorized-instance"],
  list: ["authorized-instance"],
  captureMetadata: ["self", "user"],
  captureVisibleText: ["terminal:observe", "content-audit"],
  attach: ["authorized-viewer", "exact-generation"],
  resize: ["selected-viewer", "control-daemon"],
  automatedInput: [
    "communication-authorized-message",
    "exact-generation",
    "capability-epoch",
  ],
  terminate: [
    "authorized-lifecycle-intent",
    "terminal-close",
    "terminal-quit",
    "visibility-expiry",
  ],
  subscribe: ["authorized-instance", "retained-event-cursor"],
} as const;

export const SESSION_PROTOCOL_CONTRACT = {
  version: SESSION_PROTOCOL_VERSION,
  paths: SESSION_PROTOCOL_PATHS,
  limits: TERMINAL_LIMITS,
  frameHeader: FRAME_HEADER,
  frameFlags: FRAME_FLAGS,
  frameTypes: FRAME_TYPES,
  frameTypeGroups: FRAME_TYPE_GROUPS,
  rawByteFrameTypes: RAW_BYTE_FRAME_TYPES,
  errorCodes: WIRE_ERROR_CODES,
  inputArbiterStates: INPUT_ARBITER_STATES,
  inputArbiterTransitions: INPUT_ARBITER_TRANSITIONS,
  inputEvidenceLevels: INPUT_EVIDENCE_LEVELS,
  inputEvidenceContracts: INPUT_EVIDENCE_CONTRACTS,
  ghosttyBridgeEvents: GHOSTTY_BRIDGE_EVENTS,
  checkpointHeader: CHECKPOINT_HEADER,
  permissions: SESSION_HOST_PERMISSIONS,
} as const;
