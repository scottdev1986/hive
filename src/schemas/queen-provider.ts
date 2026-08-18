import { z } from "zod";
import { ORCHESTRATOR_NAME } from "./agent";
import { CapabilityProviderSchema } from "./capability";
import {
  DecimalUint64Schema,
  domainUuidV7Schema,
  Rfc3339UtcMillisecondsSchema,
} from "./primitives";
import { OrchestratorStatusSchema } from "./status-envelope";

/** The Queen Provider control surface: which vendor runs the live Queen. This is the WHOLE client vocabulary, on purpose. Replacing the live Queen is a multi-step operation inside the daemon (terminate the running root, relaunch on the requested vendor, observe the result), and none of those steps exist here: a client sees one revisioned projection, one compare-and-set command, and one opaque change state. Adding a field that names an internal step (a generation, a checkpoint, a handoff, an attestation) would freeze that internal mechanism into the wire — the mechanism is expected to be replaced, the wire is not. The projection reports OBSERVATION, never intention. `liveProvider` is the provider of the root terminal's running foreground process as the daemon last observed it — not the value someone asked to launch. A queen that was requested but never came up reads as `liveProvider: null` with the change still `pending`, because that is what is true. */

/** The one root. Its identity never changes when its vendor does: same name, same instance, no agent row, no coding or landing rights. */
export const QueenRootIdentitySchema = z.strictObject({
  name: z.literal(ORCHESTRATOR_NAME),
  instanceId: z.string().min(1),
});
export type QueenRootIdentity = z.infer<typeof QueenRootIdentitySchema>;

/** What the root is doing, derived from its own turn-boundary events. Null is honest ignorance: no signal yet, or a record that cannot be trusted. The status words themselves have one authority: status-envelope.ts. */
export const QueenRootHealthSchema = OrchestratorStatusSchema;
export type QueenRootHealth = z.infer<typeof QueenRootHealthSchema>;

/** Can this vendor's CLI launch a queen on this machine right now. Observed by probing the executable, never assumed from configuration. */
export const QueenVendorCapabilitySchema = z.strictObject({
  available: z.boolean(),
});

/** The one change state a client ever sees. idle — no provider change is in flight. pending — a compare-and-set was accepted and the daemon has not yet OBSERVED the requested provider running as the root. failed — the last accepted change could not produce a running queen on the requested provider; the prior provider was preserved. The failure text says why. Sticky until the next accepted change. */
export const QUEEN_PROVIDER_CHANGE_STATES = [
  "idle",
  "pending",
  "failed",
] as const;
export const QueenProviderChangeSchema = z.strictObject({
  state: z.enum(QUEEN_PROVIDER_CHANGE_STATES),
  /** Bumped by every ACCEPTED setLiveQueenProvider, never by observation. The compare-and-set token: mutate with the revision you read or lose. */
  revision: DecimalUint64Schema,
  failure: z.string().nullable(),
});

export const QueenProviderProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  root: QueenRootIdentitySchema,
  /** The provider of the observed running root, or null when no root foreground process is currently observed. Never a launch argument. */
  liveProvider: CapabilityProviderSchema.nullable(),
  health: QueenRootHealthSchema.nullable(),
  /** True when the root's own event record is self-contradictory (a turn ended that never started), which also forces `health: null` — a record that lies about one thing does not get to vouch for another. */
  contradicted: z.boolean(),
  vendors: z.record(CapabilityProviderSchema, QueenVendorCapabilitySchema),
  change: QueenProviderChangeSchema,
  observedAt: Rfc3339UtcMillisecondsSchema,
});
export type QueenProviderProjection = z.infer<
  typeof QueenProviderProjectionSchema
>;

export const SetLiveQueenProviderRequestSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  expectedRevision: DecimalUint64Schema,
});

/** One receipt per accepted operation. The operation's outcome is never in the receipt — it is read back from the projection, where `pending` resolves to either the observed provider or a clear failure. */
export const QueenProviderReceiptSchema = z.strictObject({
  operationId: domainUuidV7Schema("qpo"),
  revision: DecimalUint64Schema,
});
export type QueenProviderReceipt = z.infer<typeof QueenProviderReceiptSchema>;

export const SetLiveQueenProviderResponseSchema = z.strictObject({
  receipt: QueenProviderReceiptSchema,
  projection: QueenProviderProjectionSchema,
});

/** A stale `expectedRevision` fails whole, with the projection at the revision that outran the caller: reload and decide again, in one round trip. Nothing was terminated, launched, or recorded. */
export const SetLiveQueenProviderConflictSchema = z.strictObject({
  error: z.string(),
  currentRevision: DecimalUint64Schema,
  projection: QueenProviderProjectionSchema,
});
