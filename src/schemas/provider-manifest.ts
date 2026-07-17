import { z } from "zod";
import {
  TERMINAL_DELIVERY_EVIDENCE,
  TERMINAL_PROVIDER_ADAPTERS,
} from "./message-envelope";

/**
 * WP8 early slice — provider adapter manifests and readiness/receipt evidence
 * types for terminal-stack-transition.html §25 / TG4.
 *
 * Scope: versioned manifests, readiness/receipt evidence collection, TG4 corpus.
 * Out of scope (typed seams only): sessiond arbiter, delivery scheduling,
 * communication ledger, status fusion.
 *
 * Rule: every claim carries prerequisites or degrades to a lower rung / unknown.
 * Never invent evidence meanings above what is proven.
 */

export const PROVIDER_SURFACE_IDS = TERMINAL_PROVIDER_ADAPTERS;
export type ProviderSurfaceId = (typeof PROVIDER_SURFACE_IDS)[number];
export const ProviderSurfaceIdSchema = z.enum(PROVIDER_SURFACE_IDS);

/** §25 terminal evidence ladder (landed in message-envelope). */
export const TERMINAL_RECEIPT_LEVELS = TERMINAL_DELIVERY_EVIDENCE;
export type TerminalReceiptLevel = (typeof TERMINAL_RECEIPT_LEVELS)[number];
export const TerminalReceiptLevelSchema = z.enum(TERMINAL_RECEIPT_LEVELS);

/**
 * Readiness classification from observed provider surfaces only.
 * Unknown/unclassified modals → blocked-unknown, never ready (§25, §18).
 * evidence-absent = missing/misspelled key ("no"), not a negative claim.
 * capability-absent = this surface cannot produce the evidence class.
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
 * Receipt ladder plus honest non-levels.
 * provider-observed requires a matching committed attempt (id + session +
 * after-injection time). attempt-in-doubt requires a committed attempt whose
 * proof boundary was lost. Without attempt context, receipt stays evidence-absent
 * (ceiling is transport-written only when sessiond/native commit is proven
 * elsewhere — this collector does not invent it).
 */
export const RECEIPT_EVIDENCE_KINDS = [
  ...TERMINAL_RECEIPT_LEVELS,
  "evidence-absent",
  "capability-absent",
] as const;
export type ReceiptEvidenceKind = (typeof RECEIPT_EVIDENCE_KINDS)[number];
export const ReceiptEvidenceKindSchema = z.enum(RECEIPT_EVIDENCE_KINDS);

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

/** Non-empty source citation list required on every grounded claim. */
export const SourceCitationsSchema = z.array(z.string().min(1)).min(1);
export type SourceCitations = z.infer<typeof SourceCitationsSchema>;

/** Wrap any value that must carry grounding citations. */
export function citedSchema<T extends z.ZodType>(valueSchema: T) {
  return z.strictObject({
    value: valueSchema,
    sourceCitations: SourceCitationsSchema,
  });
}

/**
 * Pinned supported binary version range (§25 version-support panel).
 * Outside the range: interactive may run, automatic features whose evidence
 * changed are disabled until classified.
 */
export const VersionRangeSchema = z.strictObject({
  /** Inclusive lower bound of supported automatic-delivery range. */
  supportedMin: z.string().min(1),
  /** Inclusive upper bound of supported automatic-delivery range. */
  supportedMax: z.string().min(1),
  /** In-repo measured examples that established the pin. */
  measuredExamples: z.array(z.string().min(1)).min(1),
  unknownVersionPolicy: z.literal(
    "interactive-ok-automatic-features-disabled-until-classified",
  ),
  versionProbeArgv: z.array(z.string().min(1)).min(1),
  sourceCitations: SourceCitationsSchema,
});

export const LaunchArgvContractSchema = z.strictObject({
  executable: z.string().min(1),
  spawnShape: z.array(z.string().min(1)).min(1),
  resumeShape: z.array(z.string().min(1)).min(1),
  sourceCitations: SourceCitationsSchema,
});

export const EventSchemaIdentifierSchema = z.strictObject({
  id: z.string().min(1),
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
    "session-identity",
    "process-health",
    "transcript-activity",
  ]),
  available: z.boolean(),
  sourceCitations: SourceCitationsSchema,
});

export const CancelSubmitEncodingSchema = z.strictObject({
  submit: z.strictObject({
    encoding: z.string().min(1),
    available: z.boolean(),
    sourceCitations: SourceCitationsSchema,
  }),
  cancel: z.strictObject({
    encoding: z.string().min(1),
    available: z.boolean(),
    sourceCitations: SourceCitationsSchema,
  }),
});

export const NativeEndpointAvailabilitySchema = z.strictObject({
  available: z.boolean(),
  endpoints: z.array(z.string().min(1)),
  sourceCitations: SourceCitationsSchema,
  note: z.string().min(1).optional(),
});

export const ProviderManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  surface: ProviderSurfaceIdSchema,
  fixtureSet: citedSchema(z.string().min(1)),
  versionRange: VersionRangeSchema,
  launchArgv: LaunchArgvContractSchema,
  eventSchemas: z.array(EventSchemaIdentifierSchema).min(1),
  readinessStates: citedSchema(z.array(ReadinessEvidenceKindSchema).min(1)),
  cancelSubmit: CancelSubmitEncodingSchema,
  nativeEndpoint: NativeEndpointAvailabilitySchema,
  strongestAutomaticReceipt: citedSchema(TerminalReceiptLevelSchema),
  unknownModalBlocksDelivery: citedSchema(z.literal(true)),
  capabilityAbsences: citedSchema(z.array(z.string().min(1))),
  laterSeams: z.array(z.string().min(1)).min(1),
});
export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;

/**
 * Matching attempt required for provider-observed / attempt-in-doubt (§25).
 * Absent or incomplete attempt context caps receipt below those levels.
 */
export const AttemptContextSchema = z.strictObject({
  attemptId: z.string().min(1),
  /** Transport or native endpoint has committed this attempt. */
  committed: z.boolean(),
  /** Exact provider session the attempt targeted. */
  providerSessionId: z.string().min(1),
  /** RFC3339 timestamp of commit; observation must be after this for receipt. */
  committedAt: z.string().min(1),
});
export type AttemptContext = z.infer<typeof AttemptContextSchema>;

export const ProviderEvidenceResultSchema = z.strictObject({
  surface: ProviderSurfaceIdSchema,
  readiness: ReadinessEvidenceKindSchema,
  receipt: ReceiptEvidenceKindSchema,
  observedPath: z.string().min(1),
  means: z.string().min(1),
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

/** Whether a probe surface comes from a provider adapter or Hive host state. */
export const PROVIDER_EVIDENCE_ORIGINS = ["adapter", "host"] as const;
export const ProviderEvidenceOriginSchema = z.enum(PROVIDER_EVIDENCE_ORIGINS);
export type ProviderEvidenceOrigin = z.infer<typeof ProviderEvidenceOriginSchema>;

export const ProviderConformanceReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedFor: z.literal("WP8-early-slice-TG4"),
  designRefs: z.array(z.string().min(1)).min(1),
  /** How rows were derived — must name the collector. */
  derivedFrom: z.string().min(1),
  surfaces: z.array(
    z.strictObject({
      surface: ProviderSurfaceIdSchema,
      readiness: z.array(
        z.strictObject({
          kind: ReadinessEvidenceKindSchema,
          status: ConformanceLevelStatusSchema,
          evidence: z.string().min(1),
          /** Observation path that produced this kind, if provable. */
          collectorPath: z.string().min(1).nullable(),
          /** Empty only when the row is unavailable. */
          evidenceOrigins: z.array(ProviderEvidenceOriginSchema),
        }),
      ),
      receipt: z.array(
        z.strictObject({
          level: TerminalReceiptLevelSchema,
          status: ConformanceLevelStatusSchema,
          evidence: z.string().min(1),
          collectorPath: z.string().min(1).nullable(),
          evidenceOrigins: z.array(ProviderEvidenceOriginSchema),
        }),
      ),
    }),
  ),
});
export type ProviderConformanceReport = z.infer<
  typeof ProviderConformanceReportSchema
>;
