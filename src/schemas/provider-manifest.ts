import { z } from "zod";
import {
  TERMINAL_DELIVERY_EVIDENCE,
  TERMINAL_PROVIDER_ADAPTERS,
} from "./message-envelope";

/**
 * WP8 early slice — provider adapter manifests and readiness/receipt evidence
 * types for terminal-stack-transition.html §25 / TG4.
 *
 * Scope (this package only):
 * - versioned adapter manifests
 * - readiness / receipt evidence collection
 * - TG4 fixture corpus targets
 *
 * Explicit seams (NOT implemented here — later WP4/WP7/full WP8):
 * - sessiond input arbiter
 * - delivery scheduling / injection
 * - communication ledger
 * - status fusion
 *
 * Never invent evidence meanings, timeouts, or states beyond §25 and the
 * landed receipt ladder in message-envelope.ts / session-protocol.ts.
 */

export const PROVIDER_SURFACE_IDS = TERMINAL_PROVIDER_ADAPTERS;
export type ProviderSurfaceId = (typeof PROVIDER_SURFACE_IDS)[number];

export const ProviderSurfaceIdSchema = z.enum(PROVIDER_SURFACE_IDS);

/** §25 terminal evidence ladder (landed in message-envelope). */
export const TERMINAL_RECEIPT_LEVELS = TERMINAL_DELIVERY_EVIDENCE;
export type TerminalReceiptLevel = (typeof TERMINAL_RECEIPT_LEVELS)[number];
export const TerminalReceiptLevelSchema = z.enum(TERMINAL_RECEIPT_LEVELS);

/**
 * Readiness classification derived from observed provider surfaces only.
 * Unknown/unclassified modals map to blocked-unknown — never ready (§25, §18).
 * evidence-absent is "no" (missing/misspelled key), not a negative claim.
 * capability-absent means this surface cannot produce the evidence class at all.
 */
export const READINESS_EVIDENCE_KINDS = [
  "ready",
  "busy",
  "turn-boundary",
  "awaiting-approval",
  "blocked-unknown",
  "disconnected",
  "restarting",
  "evidence-absent",
  "capability-absent",
] as const;
export type ReadinessEvidenceKind = (typeof READINESS_EVIDENCE_KINDS)[number];
export const ReadinessEvidenceKindSchema = z.enum(READINESS_EVIDENCE_KINDS);

/**
 * Receipt classification from a provider observation after an injection attempt.
 * transport-written is a sessiond/native-endpoint fact — provider hooks alone
 * do not prove it. provider-observed requires a matching boundary after attempt
 * under the same provider session. attempt-in-doubt when the proof boundary was
 * lost. Absent/capability fields never invent a receipt.
 */
export const RECEIPT_EVIDENCE_KINDS = [
  ...TERMINAL_RECEIPT_LEVELS,
  "evidence-absent",
  "capability-absent",
] as const;
export type ReceiptEvidenceKind = (typeof RECEIPT_EVIDENCE_KINDS)[number];
export const ReceiptEvidenceKindSchema = z.enum(RECEIPT_EVIDENCE_KINDS);

/** Exact meanings for the §25 ladder — mirrors message-envelope / design. */
export const TERMINAL_EVIDENCE_CONTRACTS = {
  "transport-written": {
    means:
      "sessiond transaction committed and fully written to the exact provider PTY, or native provider endpoint accepted the matching attempt",
    excludes: [
      "provider-observed",
      "agent-understood",
      "acknowledged",
      "applied",
    ],
  },
  "provider-observed": {
    means:
      "adapter-specific provider marker or boundary after the matching attempt under the same provider session",
    excludes: ["understood", "acknowledged", "applied"],
  },
  "attempt-in-doubt": {
    means:
      "proof boundary lost at or after commit; attempt outcome cannot be established",
    excludes: ["permission-to-repeat-body-automatically"],
  },
} as const satisfies Record<TerminalReceiptLevel, unknown>;

export const WP8_OUT_OF_SCOPE_SEAMS = {
  sessiondInputArbiter: {
    owner: "WP4",
    status: "unlanded",
    note: "Input claim/gesture/automation states live on sessiond; this slice does not schedule or authorize writes.",
  },
  deliverySchedulingAndInjection: {
    owner: "WP8-full + WP4",
    status: "unlanded",
    note: "Evidence collection only; no delivery decisions, retries, or paste injection.",
  },
  communicationLedger: {
    owner: "hive-communication.html",
    status: "external-contract",
    note: "Message lifecycle projection and retry/idempotency belong to the communication scheduler.",
  },
  statusFusion: {
    owner: "WP7",
    status: "unlanded",
    note: "turnState fusion and attention badges are status-spine work; adapters only supply evidence.",
  },
} as const;

export const VersionRangeSchema = z.strictObject({
  /** Versions measured in-repo against live CLIs (tests/comments). */
  measured: z.array(z.string().min(1)).min(1),
  /**
   * How an unknown version is treated at launch. §25: may run interactively if
   * containment is safe, but automatic delivery/status features whose evidence
   * changed are disabled. Adapters today probe via --version; they do not hard
   * reject unknown versions at spawn.
   */
  unknownVersionPolicy: z.literal(
    "interactive-ok-automatic-features-disabled-until-classified",
  ),
  /** Probe argv that prints version and exits (non-billable). */
  versionProbeArgv: z.array(z.string().min(1)).min(1),
});

export const LaunchArgvContractSchema = z.strictObject({
  /** Binary token or absolute path slot. */
  executable: z.string().min(1),
  /** Documented argv shape; not a full template engine. */
  spawnShape: z.array(z.string().min(1)).min(1),
  resumeShape: z.array(z.string().min(1)).min(1),
  /** Source file:line citations grounding each claim in existing adapters. */
  sourceCitations: z.array(z.string().min(1)).min(1),
});

export const EventSchemaIdentifierSchema = z.strictObject({
  id: z.string().min(1),
  /** Provider-native name when different from Hive kind. */
  providerName: z.string().min(1),
  role: z.enum([
    "session-start",
    "turn-start",
    "turn-end",
    "tool-boundary",
    "notification",
    "approval",
    "native-session",
    "native-turn",
    "process-health",
    "transcript-activity",
  ]),
  available: z.boolean(),
  sourceCitations: z.array(z.string().min(1)).min(1),
});

export const CancelSubmitEncodingSchema = z.strictObject({
  submit: z.strictObject({
    encoding: z.string().min(1),
    available: z.boolean(),
    sourceCitations: z.array(z.string().min(1)).min(1),
  }),
  cancel: z.strictObject({
    encoding: z.string().min(1),
    available: z.boolean(),
    sourceCitations: z.array(z.string().min(1)).min(1),
  }),
});

export const NativeEndpointAvailabilitySchema = z.strictObject({
  available: z.boolean(),
  endpoints: z.array(z.string().min(1)),
  sourceCitations: z.array(z.string().min(1)).min(1),
  /** Honest absence note when available is false. */
  note: z.string().min(1).optional(),
});

export const ProviderManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  surface: ProviderSurfaceIdSchema,
  /** TG4 fixture set name for this surface. */
  fixtureSet: z.string().min(1),
  versionRange: VersionRangeSchema,
  launchArgv: LaunchArgvContractSchema,
  eventSchemas: z.array(EventSchemaIdentifierSchema).min(1),
  readinessStates: z.array(ReadinessEvidenceKindSchema).min(1),
  cancelSubmit: CancelSubmitEncodingSchema,
  nativeEndpoint: NativeEndpointAvailabilitySchema,
  /**
   * Strongest automatic receipt this surface can prove when green.
   * Grounded in PROVIDER_ADAPTER_CONTRACTS / §25 table.
   */
  strongestAutomaticReceipt: TerminalReceiptLevelSchema,
  /**
   * When true, unknown notification/modal types block automated delivery
   * until classified (§25).
   */
  unknownModalBlocksDelivery: z.literal(true),
  /** Hooks or structured surfaces that do not exist on this adapter. */
  capabilityAbsences: z.array(z.string().min(1)),
  /** Pointers to seams left for later packages. */
  laterSeams: z.array(z.string().min(1)).min(1),
});
export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;

export const ProviderEvidenceResultSchema = z.strictObject({
  surface: ProviderSurfaceIdSchema,
  readiness: ReadinessEvidenceKindSchema,
  receipt: ReceiptEvidenceKindSchema,
  /** Field/event path that produced this classification. */
  observedPath: z.string().min(1),
  /** What this evidence means; never a delivery decision. */
  means: z.string().min(1),
  /** Claims this evidence must not be stretched into. */
  excludes: z.array(z.string().min(1)),
});
export type ProviderEvidenceResult = z.infer<typeof ProviderEvidenceResultSchema>;

export const TG4_SCENARIOS = [
  "idle",
  "busy",
  "approval",
  "modal",
  "disconnect",
  "restart",
] as const;
export type Tg4Scenario = (typeof TG4_SCENARIOS)[number];
export const Tg4ScenarioSchema = z.enum(TG4_SCENARIOS);

export const ConformanceLevelStatusSchema = z.enum([
  "provable-today",
  "unavailable",
]);
export type ConformanceLevelStatus = z.infer<typeof ConformanceLevelStatusSchema>;

export const ProviderConformanceReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedFor: z.literal("WP8-early-slice-TG4"),
  designRefs: z.array(z.string().min(1)).min(1),
  surfaces: z.array(
    z.strictObject({
      surface: ProviderSurfaceIdSchema,
      readiness: z.array(
        z.strictObject({
          kind: ReadinessEvidenceKindSchema,
          status: ConformanceLevelStatusSchema,
          evidence: z.string().min(1),
        }),
      ),
      receipt: z.array(
        z.strictObject({
          level: TerminalReceiptLevelSchema,
          status: ConformanceLevelStatusSchema,
          evidence: z.string().min(1),
        }),
      ),
    }),
  ),
});
export type ProviderConformanceReport = z.infer<
  typeof ProviderConformanceReportSchema
>;
