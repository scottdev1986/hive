import {
  domainUuidV7Schema,
} from "../schemas/session-protocol";
import { z } from "zod";
import {
  HiveTerminalBindingSchema,
  type HiveTerminalBinding,
} from "./session-host/terminal-host-binding";

export type OrchestratorHostKind = "sessiond" | "tmux";

export const ORCHESTRATOR_HOST_ENV = "HIVE_ORCHESTRATOR_HOST";

export const RootSessiondLocatorSchema = HiveTerminalBindingSchema.unwrap()
  .shape.locator.unwrap().extend({
    subject: z.strictObject({ kind: z.literal("root") }).readonly(),
    hostKind: z.literal("sessiond"),
    engineBuildId: z.string().min(1),
  }).readonly();
export type RootSessiondLocator = z.infer<typeof RootSessiondLocatorSchema>;

/** #114 gates the default flip. sessiond remains an explicit restart-proof opt-in. */
export function configuredOrchestratorHost(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OrchestratorHostKind {
  const value = environment[ORCHESTRATOR_HOST_ENV];
  if (value === undefined || value === "" || value === "tmux") return "tmux";
  if (value === "sessiond") return "sessiond";
  throw new Error(
    `${ORCHESTRATOR_HOST_ENV} must be sessiond or tmux (received ${JSON.stringify(value)})`,
  );
}

/** The launch request survives HTTP retries, so its UUID is also the stable
 * root session identity. A daemon restart can reconstruct the same pending
 * locator without inventing a second queen generation. */
export function rootSessionIdForLaunchRequest(requestId: string): string {
  const request = domainUuidV7Schema("req").parse(requestId);
  return `ses_${request.slice("req_".length)}`;
}

export function mintRootSessiondLocator(input: Readonly<{
  requestId: string;
  instanceId: string;
  engineBuildId: string;
  bindings: readonly HiveTerminalBinding[];
}>): RootSessiondLocator {
  const sessionId = rootSessionIdForLaunchRequest(input.requestId);
  const existing = input.bindings.find((binding) =>
    binding.locator.instanceId === input.instanceId &&
    binding.locator.subject.kind === "root" &&
    binding.locator.sessionId === sessionId
  );
  if (existing !== undefined) return RootSessiondLocatorSchema.parse(existing.locator);
  const generation = input.bindings.reduce(
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
