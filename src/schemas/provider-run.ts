import { z } from "zod";
import { type JsonValue, requireJsonValue } from "../shared/json";
import { CapabilityProviderSchema } from "./provider";
import { SessionLocatorSchema } from "./session-protocol";
import { isRecord } from "../shared/is-record";

export const AdapterChildIdentitySchema = z
  .strictObject({
    pid: z.number().int().positive(),
    startToken: z.string().min(1),
    processGroupId: z.number().int().positive(),
    observedAt: z.iso.datetime({ offset: true }),
  })
  .readonly()
  .superRefine((identity, context) => {
    if (identity.pid !== identity.processGroupId) {
      context.addIssue({
        code: "custom",
        message: "adapter child must lead its reported process group",
        path: ["processGroupId"],
      });
    }
  });

export type AdapterChildIdentity = z.infer<typeof AdapterChildIdentitySchema>;

export const ProviderProtocolReceiptSchema = z
  .strictObject({
    clientInputId: z.string().min(1),
    outcome: z.enum(["accepted", "rejected", "unknown"]),
    turnId: z.string().min(1).nullable(),
    detail: z.string().min(1).optional(),
    reportedAt: z.iso.datetime({ offset: true }),
  })
  .readonly();

export type ProviderProtocolReceipt = z.infer<
  typeof ProviderProtocolReceiptSchema
>;

export const ProviderRuntimeReportSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      schemaVersion: z.literal(1),
      kind: z.literal("adapter-child"),
      providerRunId: z.string().uuid(),
      identity: AdapterChildIdentitySchema,
    })
    .readonly(),
  z
    .strictObject({
      schemaVersion: z.literal(1),
      kind: z.literal("protocol-receipt"),
      providerRunId: z.string().uuid(),
      receipt: z
        .strictObject({
          clientInputId: z.string().min(1),
          outcome: z.enum(["accepted", "rejected", "unknown"]),
          turnId: z.string().min(1).nullable(),
          detail: z.string().min(1).optional(),
        })
        .readonly(),
    })
    .readonly(),
]);

export type ProviderRuntimeReport = z.infer<typeof ProviderRuntimeReportSchema>;

export const ProviderRunBindingSchema = z
  .strictObject({
    runId: z.string().uuid(),
    agentId: z.string().min(1).nullable(),
    terminal: SessionLocatorSchema,
    /** Null only for a headless orchestrator root: no vendor process is attached. A worker run (agentId non-null) always has one — enforced below, not just by convention. */
    provider: CapabilityProviderSchema.nullable(),
    model: z.string().min(1).nullable(),
    effort: z.string().min(1).nullable(),
    conversationId: z.string().min(1).nullable(),
    capabilityEpoch: z.number().int().nonnegative(),
    launchGrantId: z.string().min(1),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .readonly();

export const ProviderRunSchema = z
  .strictObject({
    ...ProviderRunBindingSchema.unwrap()["shape"],
    adapterChild: AdapterChildIdentitySchema.nullable(),
    protocolReceipt: ProviderProtocolReceiptSchema.nullable(),
    state: z.enum(["running", "exited"]),
    exitReason: z.string().min(1).nullable(),
  })
  .readonly()
  .superRefine((run, context) => {
    if (run.state === "running" && run.endedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "a running provider run cannot have endedAt",
        path: ["endedAt"],
      });
    }
    if (run.state === "exited" && run.endedAt === null) {
      context.addIssue({
        code: "custom",
        message: "an exited provider run requires endedAt",
        path: ["endedAt"],
      });
    }
    // One-directional: a worker run always has a vendor. Only a root run (agentId null) may be headless (provider null) — this is what stops a worker from masquerading as a headless root at the type level, not just inside getActiveRootProviderRun.
    if (run.agentId !== null && run.provider === null) {
      context.addIssue({
        code: "custom",
        message:
          "a worker provider run must carry a provider; only a root run may be headless",
        path: ["provider"],
      });
    }
  });

export type ProviderRun = z.infer<typeof ProviderRunSchema>;

export function migrateStoredProviderRun<T>(value: T): JsonValue {
  const json = requireJsonValue(value, "stored provider run");
  if (!isRecord(json)) {
    return json;
  }
  if (!("pid" in json) && !("foregroundProcessGroupId" in json)) {
    return json;
  }
  const {
    pid: _pid,
    startToken: _startToken,
    foregroundProcessGroupId: _pgid,
    ...current
  } = json;
  return { ...current, adapterChild: null, protocolReceipt: null };
}
