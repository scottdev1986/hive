import { z } from "zod";
import {
  SessionLocatorSchema,
  TerminalHostSessionRefSchema,
  VisibilityRequestSchema,
} from "../../schemas/session-protocol";

/** Hive-owned policy bound to one project-neutral terminal-host identity. */
export const HiveTerminalBindingSchema = z.strictObject({
  session: TerminalHostSessionRefSchema,
  locator: SessionLocatorSchema.unwrap().extend({ hostKind: z.literal("sessiond") }).readonly(),
  visibility: VisibilityRequestSchema,
}).readonly();

export type HiveTerminalBinding = z.infer<typeof HiveTerminalBindingSchema>;
export type TerminalHostSessionRef = HiveTerminalBinding["session"];

export interface TerminalHostBindingStore {
  bindTerminalHostSession(binding: HiveTerminalBinding): HiveTerminalBinding;
  getTerminalHostBinding(session: TerminalHostSessionRef): HiveTerminalBinding | null;
  getTerminalHostBindingByLocator(locator: HiveTerminalBinding["locator"]): HiveTerminalBinding | null;
}

export class TerminalHostBindingConflictError extends Error {
  constructor() {
    super("terminal host identity is already bound to different Hive policy");
    this.name = "TerminalHostBindingConflictError";
  }
}
