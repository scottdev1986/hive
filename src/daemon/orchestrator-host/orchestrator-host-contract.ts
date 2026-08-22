import { z } from "zod";
import { ORCHESTRATOR_NAME } from "../../schemas/agent";
import { CapabilityProviderSchema } from "../../schemas/capability";
import {
  domainUuidV7Schema,
  Rfc3339UtcMillisecondsSchema,
} from "../../schemas/primitives";
import { OrchestratorStatusSchema } from "../../schemas/status-envelope";
import {
  type HiveTerminalBinding,
  HiveTerminalBindingSchema,
} from "../session-host/terminal-host-binding";
import type { OrchestratorStatus } from "../status-service/status-service";

export const OrchestratorHostKindSchema = z.literal("sessiond");
export type OrchestratorHostKind = z.infer<typeof OrchestratorHostKindSchema>;

export const RootSessiondLocatorSchema = HiveTerminalBindingSchema.unwrap()
  ["shape"].locator.unwrap()
  .extend({
    subject: z.strictObject({ kind: z.literal("root") }).readonly(),
    hostKind: z.literal("sessiond"),
    engineBuildId: z.string().min(1),
  })
  .readonly();
export type RootSessiondLocator = z.infer<typeof RootSessiondLocatorSchema>;

/** The root terminal's lifecycle, as its sessiond host reports it. Lives here
 * rather than beside the host so the wire schema below can name it without
 * depending on the host implementation. */
export const OrchestratorSessiondStateSchema = z.enum([
  "awaiting-visibility",
  "running",
  "exited",
  "failed",
]);

/**
 * `GET /orchestrator-status`, in full.
 *
 * The root's turn status, provider identity, and terminal lifecycle are
 * independent measurements. Status is always concrete: provider-native turn
 * state wins, while connection lifecycle covers periods without a turn.
 */
export const OrchestratorHostStatusSchema = z.strictObject({
  name: z.literal(ORCHESTRATOR_NAME),
  status: OrchestratorStatusSchema,
  statusObservedAt: Rfc3339UtcMillisecondsSchema.nullable().optional(),
  tool: CapabilityProviderSchema.nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  host: OrchestratorHostKindSchema,
  hostState: OrchestratorSessiondStateSchema.nullable(),
  hostDiagnostic: z.string().nullable(),
  sessionLocator: RootSessiondLocatorSchema.nullable(),
});
export type OrchestratorHostStatus = z.infer<
  typeof OrchestratorHostStatusSchema
>;

type Assert<T extends true> = T;
type Equals<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
true satisfies Assert<
  Equals<z.infer<typeof OrchestratorStatusSchema>, OrchestratorStatus>
>;

/** The launch request survives HTTP retries, so its UUID is also the stable
 * root session identity. A daemon restart can reconstruct the same pending
 * locator without inventing a second queen generation. */
export function rootSessionIdForLaunchRequest(requestId: string): string {
  const request = domainUuidV7Schema("req").parse(requestId);
  return `ses_${request.slice("req_".length)}`;
}

export function mintRootSessiondLocator(
  input: Readonly<{
    requestId: string;
    instanceId: string;
    engineBuildId: string;
    bindings: readonly HiveTerminalBinding[];
  }>,
): RootSessiondLocator {
  const sessionId = rootSessionIdForLaunchRequest(input.requestId);
  const existing = input.bindings.find(
    (binding) =>
      binding.locator.instanceId === input.instanceId &&
      binding.locator.subject.kind === "root" &&
      binding.locator.sessionId === sessionId,
  );
  if (existing !== undefined)
    return RootSessiondLocatorSchema.parse(existing.locator);
  const generation =
    input.bindings.reduce(
      (highest, binding) =>
        binding.locator.instanceId === input.instanceId &&
        binding.locator.subject.kind === "root"
          ? Math.max(highest, binding.locator.generation)
          : highest,
      0,
    ) + 1;
  return RootSessiondLocatorSchema.parse({
    schemaVersion: 1,
    instanceId: input.instanceId,
    subject: { kind: "root" },
    generation,
    sessionId,
    hostKind: "sessiond",
    engineBuildId: input.engineBuildId,
  });
}
