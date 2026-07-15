// Wire schemas for the project-profile MCP tools and gate/bypass routes.
//
// These are the *stable* shapes the daemon returns to a profiler, an operator,
// or an orchestrator, and the shapes those callers send back. The profile
// service (`src/daemon/project-profile.ts`) owns the storage; this file owns the
// contract the daemon speaks over MCP/HTTP, so a client never has to import a
// daemon-internal type to read a status or a gate.
//
// The daemon authors everything a profiler could otherwise spoof — run id,
// provider, model, digests, provenance — so the only thing the model sends is a
// candidate (validated by `ProjectProfileCandidateSchema`) and a request for
// specific inventory paths. Everything else on the wire is daemon-emitted.
import { z } from "zod";
import { ProjectProfileLifecycleSchema } from "./project-profile";

// --- spawn gate -------------------------------------------------------------

/** Why the spawn gate is open or closed. `validated-profile`: a current profile
 * exists and its bytes validate. `session-bypass`: no profile, but the operator
 * chose Continue Without Profile this daemon session. `first-profile-required`:
 * neither — ordinary/orchestrator creation stays closed. */
export const ProfileSpawnGateBasisSchema = z.enum([
  "validated-profile",
  "session-bypass",
  "first-profile-required",
]);
export type ProfileSpawnGateBasis = z.infer<typeof ProfileSpawnGateBasisSchema>;

export const ProfileSpawnGateSchema = z.strictObject({
  canSpawn: z.boolean(),
  basis: ProfileSpawnGateBasisSchema,
  bypassed: z.boolean(),
});
export type ProfileSpawnGate = z.infer<typeof ProfileSpawnGateSchema>;

// --- status -----------------------------------------------------------------

export const ProfileStatusFailureSchema = z.strictObject({
  code: z.string(),
  detail: z.string(),
  at: z.string(),
});

export const ProfileStatusRunSchema = z.strictObject({
  runId: z.string(),
  provider: z.string(),
  model: z.string(),
  startedAt: z.string(),
});

export const ProfileStatusRefreshSchema = z.strictObject({
  pending: z.boolean(),
  deferredReason: z.string().nullable(),
});

/** Everything the operator's `hive profile status` and the Workspace disclosure
 * need in one object: the lifecycle, whether a validated profile is present
 * *and readable*, exact paths, the last failure verbatim, the run in flight,
 * refresh state, and the authoritative gate. `hasCurrent` and `gate` are derived
 * from the validated read, never from `lifecycle` text alone — a `stale`
 * lifecycle with readable bytes still reports `hasCurrent: true` and an open
 * gate. */
export const ProfileStatusSchema = z.strictObject({
  lifecycle: ProjectProfileLifecycleSchema,
  hasCurrent: z.boolean(),
  currentPath: z.string(),
  statePath: z.string(),
  failure: ProfileStatusFailureSchema.nullable(),
  run: ProfileStatusRunSchema.nullable(),
  refresh: ProfileStatusRefreshSchema,
  gate: ProfileSpawnGateSchema,
});
export type ProfileStatus = z.infer<typeof ProfileStatusSchema>;

// --- inventory (profiler only) ----------------------------------------------

/** At most this many paths per `{ paths }` content request. A daemon constant,
 * never a caller-expandable option (the byte caps are enforced inside the
 * service). */
export const PROFILE_INVENTORY_MAX_CONTENT_PATHS = 32;

/** `profile_inventory` has two mutually exclusive modes: catalog paging with an
 * opaque `cursor`, or content reads for a bounded set of `paths`. Exactly one is
 * given; the daemon rejects a call that sets both or neither. */
export const ProfileInventoryRequestSchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(PROFILE_INVENTORY_MAX_CONTENT_PATHS)
    .optional(),
});
export type ProfileInventoryRequest = z.infer<
  typeof ProfileInventoryRequestSchema
>;

/** One catalog entry: what a profiler may know about a file without reading it.
 * Excluded directories, credential stores, and secret files are simply absent —
 * they never appear as an entry at all. */
export const ProfileInventoryCatalogEntrySchema = z.strictObject({
  path: z.string(),
  type: z.enum(["file", "symlink"]),
  size: z.number().int().nonnegative(),
  contentDigest: z.string(),
  linkTarget: z.string().optional(),
  contentOmissionReason: z.enum(["binary", "outside-project"]).optional(),
});
export type ProfileInventoryCatalogEntry = z.infer<
  typeof ProfileInventoryCatalogEntrySchema
>;

/** Why a requested path returned no bytes. Anything but a catalogued, small,
 * text, in-tree regular file is omitted with a reason, never silently. */
export const ProfileInventoryOmissionReasonSchema = z.enum([
  "binary",
  "too-large",
  "secret",
  "symlink",
  "changed",
  "uncatalogued",
  "outside-project",
]);
export type ProfileInventoryOmissionReason = z.infer<
  typeof ProfileInventoryOmissionReasonSchema
>;

/** One content result: either `content` (UTF-8 bytes) or `omitted` (a reason),
 * never both and never neither. */
export const ProfileInventoryContentFileSchema = z.strictObject({
  path: z.string(),
  content: z.string().optional(),
  omitted: ProfileInventoryOmissionReasonSchema.optional(),
});
export type ProfileInventoryContentFile = z.infer<
  typeof ProfileInventoryContentFileSchema
>;

/** Why an inventory call was refused before any bytes were read. `unauthorized`:
 * the subject is not the active run's profiler (a cross-project, named-instance,
 * or completed-run token). `no-active-run`: nothing is profiling. `stale-run`:
 * the tree changed under the profiler; the cursor/read is void and a new run is
 * scheduled. */
export type ProfileInventoryDenialCode =
  | "unauthorized"
  | "no-active-run"
  | "stale-run";

/** The result of an inventory call. Catalog and content are the two success
 * shapes; `denied` carries a lossless code so the profiler learns exactly why a
 * call was refused. */
export type ProfileInventoryResult =
  | { status: "catalog"; entries: ProfileInventoryCatalogEntry[]; nextCursor: string | null }
  | { status: "content"; files: ProfileInventoryContentFile[] }
  | { status: "denied"; code: ProfileInventoryDenialCode; message: string };

// --- submit (profiler only) -------------------------------------------------

/** The `profile_submit` payload wraps a model-authored candidate. The candidate
 * itself is validated by `ProjectProfileCandidateSchema` inside the service, so
 * schema failures come back as lossless `{ code: "schema" }` rejections rather
 * than an opaque transport error — `candidate` is passed through untyped here on
 * purpose. */
export const ProfileSubmitRequestSchema = z.strictObject({
  candidate: z.unknown(),
});
export type ProfileSubmitRequest = z.infer<typeof ProfileSubmitRequestSchema>;

/** One rejection as it appears on the wire. `code` is a stable machine string;
 * `message` is the exact human detail; `at` is the field it is about, when
 * there is one. The daemon never collapses several rejections into one. */
export const ProfileRejectionWireSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  at: z.string().optional(),
});
export type ProfileRejectionWire = z.infer<typeof ProfileRejectionWireSchema>;

/** The `profile_submit` response. Acceptance is a bare `{ status: "accepted" }`;
 * a rejection carries the resulting lifecycle and every rejection code the
 * daemon knows, so the profiler can repair and resubmit against the same run. */
export type ProfileSubmitResponse =
  | { status: "accepted" }
  | {
      status: "rejected";
      lifecycle: z.infer<typeof ProjectProfileLifecycleSchema>;
      rejections: ProfileRejectionWire[];
    };

// --- reprofile (operator / orchestrator) ------------------------------------

/** The `profile_reprofile` payload. Guidance is an instruction to investigate,
 * never a validation override; the daemon normalizes and caps it and records it
 * as request provenance. */
export const ProfileReprofileRequestSchema = z.strictObject({
  guidance: z.string().optional(),
});
export type ProfileReprofileRequest = z.infer<
  typeof ProfileReprofileRequestSchema
>;

/** What the daemon did with a reprofile request: `started` a fresh run, or
 * `coalesced` onto the one already in flight. `runId` names the run either way. */
export type ProfileReprofileResult = {
  status: "started" | "coalesced";
  runId: string;
};
