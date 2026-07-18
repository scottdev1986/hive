import { z } from "zod";
import {
  SessionLocatorSchema,
  VisibilityRequestSchema,
} from "../../schemas/session-protocol";

/** Hive-owned policy bound to one exact sessiond locator. */
export const HiveTerminalBindingSchema = z.strictObject({
  locator: SessionLocatorSchema.unwrap().extend({ hostKind: z.literal("sessiond") }).readonly(),
  visibility: VisibilityRequestSchema,
}).readonly();

export type HiveTerminalBinding = z.infer<typeof HiveTerminalBindingSchema>;

export interface TerminalHostBindingStore {
  bindTerminalHostSession(binding: HiveTerminalBinding): HiveTerminalBinding;
  getTerminalHostBindingByLocator(locator: HiveTerminalBinding["locator"]): HiveTerminalBinding | null;
  listTerminalHostBindings(instanceId: string): readonly HiveTerminalBinding[];
}

export class TerminalHostBindingConflictError extends Error {
  constructor() {
    super("terminal host identity is already bound to different Hive policy");
    this.name = "TerminalHostBindingConflictError";
  }
}
