import {
  domainUuidV7Schema,
} from "../schemas/session-protocol";
import { z } from "zod";
import {
  HiveTerminalBindingSchema,
  type HiveTerminalBinding,
} from "./session-host/terminal-host-binding";

export type OrchestratorHostKind = "sessiond" | "tmux";

export const RootSessiondLocatorSchema = HiveTerminalBindingSchema.unwrap()
  .shape.locator.unwrap().extend({
    subject: z.strictObject({ kind: z.literal("root") }).readonly(),
    hostKind: z.literal("sessiond"),
    engineBuildId: z.string().min(1),
  }).readonly();
export type RootSessiondLocator = z.infer<typeof RootSessiondLocatorSchema>;

/** Production has one terminal host. The union remains only for explicit
 * legacy fixtures until #1/#2 delete the dead tmux implementation. */
export function configuredOrchestratorHost(): OrchestratorHostKind {
  return "sessiond";
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
