import { z } from "zod";

export const FRAME_HEADER = {
  bytes: 32,
  magic: "HVT1",
  magicBytes: [0x48, 0x56, 0x54, 0x31],
  byteOrder: "network",
  widths: {
    magic: 4,
    major: 1,
    minor: 1,
    type: 2,
    flags: 2,
    reserved: 2,
    payloadLength: 4,
    requestId: 8,
    streamSeq: 8,
  },
  offsets: {
    magic: 0,
    major: 4,
    minor: 5,
    type: 6,
    flags: 8,
    reserved: 10,
    payloadLength: 12,
    requestId: 16,
    streamSeq: 24,
  },
  optionalTypeBit: 0x8000,
  unknownOptionalType: "ignore",
  unknownRequiredType: "UNSUPPORTED_FRAME",
} as const;

export const FRAME_FLAGS = {
  response: 1 << 0,
  final: 1 << 1,
  error: 1 << 2,
  contentSensitive: 1 << 3,
  allowedMask: 0x000f,
} as const;

export const FRAME_TYPES = {
  HELLO: 0x0001,
  WELCOME: 0x0002,
  ERROR: 0x0003,
  PING: 0x0004,
  PONG: 0x0005,
  LIST: 0x0110,
  LISTED: 0x0111,
  INSPECT: 0x0112,
  INSPECTED: 0x0113,
  TERMINATE: 0x0114,
  TERMINATED: 0x0115,
  VISIBILITY_RENEW: 0x0116,
  RENEWED: 0x0117,
  ATTACH_REQUEST: 0x0200,
  ATTACH_GRANT: 0x0201,
  HOST_ATTACH: 0x0202,
  SNAPSHOT_BEGIN: 0x0203,
  SNAPSHOT_BYTES: 0x0204,
  OUTPUT: 0x0205,
  APPLIED: 0x0206,
  RESIZE: 0x0207,
  DETACH: 0x0208,
  EVENT: 0x0209,
  ATTACH_READY: 0x020a,
  USER_INPUT: 0x0302,
  GESTURE_INPUT: 0x0304,
  INPUT_SUBMIT: 0x0305,
  AUTOMATION_BEGIN: 0x0310,
  AUTOMATION_CHUNK: 0x0311,
  AUTOMATION_COMMIT: 0x0312,
  AUTOMATION_RESULT: 0x0313,
  AUTOMATION_CANCEL: 0x0314,
  HOST_REGISTER: 0x0400,
  HOST_ADOPT: 0x0401,
  GRANT_REGISTER: 0x0402,
  HOST_CAPTURE: 0x0403,
  HOST_CAPTURED: 0x0404,
} as const;

export type FrameTypeName = keyof typeof FRAME_TYPES;

export const FRAME_TYPE_GROUPS = [
  {
    names: ["HELLO", "WELCOME", "ERROR"],
    direction: "bidirectional",
    purpose: "handshake-identity-limits-error",
  },
  {
    names: ["PING", "PONG"],
    direction: "bidirectional",
    purpose: "connection-liveness",
  },
  {
    names: ["LIST", "LISTED"],
    direction: "daemon-broker-bidirectional",
    purpose: "instance-inventory",
  },
  {
    names: ["INSPECT", "INSPECTED"],
    direction: "client-endpoint-bidirectional",
    purpose: "exact-locator-inspection",
  },
  {
    names: ["TERMINATE", "TERMINATED"],
    direction: "daemon-broker-host-bidirectional",
    purpose: "termination-positive-readback",
  },
  {
    names: ["VISIBILITY_RENEW", "RENEWED"],
    direction: "daemon-broker-host-bidirectional",
    purpose: "visibility-lease-renewal",
  },
  {
    names: ["ATTACH_REQUEST", "ATTACH_GRANT", "HOST_ATTACH", "ATTACH_READY"],
    direction: "workspace-broker-host-bidirectional",
    purpose: "one-use-viewer-attach-and-explicit-readiness",
  },
  {
    names: ["SNAPSHOT_BEGIN", "SNAPSHOT_BYTES"],
    direction: "host-to-viewer",
    purpose: "checkpoint-stream",
  },
  {
    names: ["OUTPUT", "APPLIED"],
    direction: "host-viewer-bidirectional",
    purpose: "ordered-output-and-high-water",
  },
  {
    names: ["RESIZE", "DETACH", "EVENT"],
    direction: "bidirectional",
    purpose: "geometry-transport-detach-session-event",
  },
  {
    names: ["USER_INPUT", "GESTURE_INPUT", "INPUT_SUBMIT"],
    direction: "viewer-to-host",
    purpose: "ordered-user-input",
  },
  {
    names: [
      "AUTOMATION_BEGIN",
      "AUTOMATION_CHUNK",
      "AUTOMATION_COMMIT",
      "AUTOMATION_RESULT",
      "AUTOMATION_CANCEL",
    ],
    direction: "daemon-host-bidirectional",
    purpose: "idempotent-buffered-automation",
  },
  {
    names: [
      "HOST_REGISTER",
      "HOST_ADOPT",
      "GRANT_REGISTER",
      "HOST_CAPTURE",
      "HOST_CAPTURED",
    ],
    direction: "broker-host-bidirectional",
    purpose: "authenticated-internal-lifecycle",
  },
] as const satisfies readonly Readonly<{
  names: readonly FrameTypeName[];
  direction: string;
  purpose: string;
}>[];

export const RAW_BYTE_FRAME_TYPES = [
  "SNAPSHOT_BYTES",
  "OUTPUT",
  "USER_INPUT",
  "AUTOMATION_CHUNK",
] as const satisfies readonly FrameTypeName[];

export const WIRE_ERROR_CODES = [
  "PROTOCOL_MISMATCH",
  "UNSUPPORTED_FRAME",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INSTANCE_MISMATCH",
  "GENERATION_MISMATCH",
  "GENERATION_GONE",
  "NOT_FOUND",
  "NOT_READY",
  "ALREADY_EXISTS",
  "INPUT_BUSY",
  "REBASE_REQUIRED",
  "SNAPSHOT_REQUIRED",
  "CHECKPOINT_UNAVAILABLE",
  "ENGINE_MISMATCH",
  "PAYLOAD_TOO_LARGE",
  "FRAME_TOO_LARGE",
  "MALFORMED_FRAME",
  "IN_DOUBT",
  "VERIFICATION_UNKNOWN",
  "CAPACITY_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "INTERNAL",
] as const;

export const WireErrorCodeSchema = z.enum(WIRE_ERROR_CODES);
export type WireErrorCode = z.infer<typeof WireErrorCodeSchema>;

export const GHOSTTY_BRIDGE_EVENTS = {
  INVALIDATE: 1,
  TITLE: 2,
  PWD: 3,
  BELL: 4,
  CLIPBOARD_DENIED: 5,
  CLOSE_REQUEST: 6,
} as const;
