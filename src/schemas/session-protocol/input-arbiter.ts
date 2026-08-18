import { z } from "zod";

export const INPUT_ARBITER_STATES = [
  "FREE",
  "USER_GESTURE",
  "AUTOMATION_BUFFERING",
  "AUTOMATION_COMMITTED",
  "TERMINATING",
  "CLOSED",
] as const;

export const InputArbiterStateSchema = z.enum(INPUT_ARBITER_STATES);

export const INPUT_ARBITER_TRANSITIONS = [
  { from: "FREE", event: "USER_INPUT", through: [], to: "FREE" },
  {
    from: "FREE",
    event: "GESTURE_INPUT",
    through: ["USER_GESTURE"],
    to: "FREE",
  },
  {
    from: "FREE",
    event: "AUTOMATION_BEGIN",
    through: [],
    to: "AUTOMATION_BUFFERING",
  },
  {
    from: "AUTOMATION_BUFFERING",
    event: "AUTOMATION_COMMIT",
    through: ["AUTOMATION_COMMITTED"],
    to: "FREE",
  },
  { from: "*", event: "TERMINATE", through: ["TERMINATING"], to: "CLOSED" },
] as const;

export const INPUT_EVIDENCE_LEVELS = [
  "buffered",
  "committed",
  "written",
  "provider-observed",
] as const;

export const InputEvidenceLevelSchema = z.enum(INPUT_EVIDENCE_LEVELS);

export const INPUT_EVIDENCE_CONTRACTS = {
  buffered: {
    means: "length-and-digest-verified",
    excludes: ["authorized", "ready", "injected", "read"],
  },
  committed: {
    means: "host-write-queue-owns-contiguous-range",
    excludes: ["kernel-consumed", "provider-consumed"],
  },
  written: {
    means: "pty-master-accepted-complete-range-in-order",
    excludes: ["provider-ui-accepted", "agent-read"],
  },
  "provider-observed": {
    means: "matching-provider-boundary-after-attempt",
    excludes: ["understood", "acknowledged", "applied"],
  },
} as const satisfies Record<(typeof INPUT_EVIDENCE_LEVELS)[number], unknown>;

export const INPUT_RECEIPT_STATES = [
  "submitted",
  "foreground-changed",
  "input-busy",
  "unknown",
] as const;
