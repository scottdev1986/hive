import type {
  ClaimResult,
  CreateRequest,
  CreateResult,
  InputReceipt,
  ResizeResult,
  SessionInspection,
  SessionRef,
  TerminalHost,
  TerminationResult,
} from "./terminal-host-contract";
import type { AgentRecord } from "../../schemas";
import {
  HiveTerminalBindingSchema,
  type HiveTerminalBinding,
  type TerminalHostBindingStore,
} from "./terminal-host-binding";

/**
 * Keep locator validation here, above the frozen neutral host. The backend
 * never learns agent IDs, Hive instances, generations, or visibility policy.
 */
export function requireSessiondAgentLocator(
  agent: Pick<AgentRecord, "id" | "sessionLocator">,
): HiveTerminalBinding["locator"] {
  const locator = agent.sessionLocator;
  if (
    locator === undefined ||
    locator.hostKind !== "sessiond" ||
    locator.subject.kind !== "agent" ||
    locator.subject.agentId !== agent.id
  ) {
    throw new Error(`Agent ${agent.id} has a mismatched sessiond SessionLocator`);
  }
  return HiveTerminalBindingSchema.unwrap().shape.locator.parse(locator);
}

type TerminalLifecycleHost = Pick<
  TerminalHost,
  | "create"
  | "claimInput"
  | "submitInput"
  | "resize"
  | "inspect"
  | "list"
  | "terminate"
>;

export type HiveTerminalPolicy = Omit<HiveTerminalBinding, "session">;

export type BoundTerminalInspection = Readonly<{
  binding: HiveTerminalBinding;
  inspection: SessionInspection;
}>;

export class TerminalHostBindingNotFoundError extends Error {
  constructor() {
    super("sessiond locator has no terminal-host binding in this Hive instance");
    this.name = "TerminalHostBindingNotFoundError";
  }
}

export class TerminalHostBindingMismatchError extends Error {
  constructor() {
    super("sessiond returned a neutral session outside its Hive binding");
    this.name = "TerminalHostBindingMismatchError";
  }
}

function sameSession(left: SessionRef, right: SessionRef): boolean {
  return left.key === right.key && left.incarnation === right.incarnation;
}

/** Hive policy adapter over the project-neutral frozen TerminalHost contract. */
export class HiveTerminalHostAdapter {
  constructor(
    private readonly host: TerminalLifecycleHost,
    private readonly bindings: TerminalHostBindingStore,
    private readonly instanceId: string,
  ) {}

  async create(
    request: CreateRequest,
    policy: HiveTerminalPolicy,
  ): Promise<CreateResult> {
    if (policy.locator.instanceId !== this.instanceId) {
      throw new TerminalHostBindingNotFoundError();
    }
    const result = await this.host.create(request);
    if (result.session.key !== request.key) {
      throw new TerminalHostBindingMismatchError();
    }
    this.bindings.bindTerminalHostSession({
      session: result.session,
      locator: policy.locator,
      visibility: policy.visibility,
    });
    return result;
  }

  async list(): Promise<readonly BoundTerminalInspection[]> {
    const bound: BoundTerminalInspection[] = [];
    for (const inspection of await this.host.list()) {
      const binding = this.bindings.getTerminalHostBinding(inspection.session);
      if (
        binding !== null &&
        binding.locator.instanceId === this.instanceId
      ) {
        bound.push({ binding, inspection });
      }
    }
    return bound;
  }

  async claimInput(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["claimInput"]>[0], "session">,
  ): Promise<ClaimResult> {
    const binding = this.requireBinding(locator);
    return this.host.claimInput({ ...request, session: binding.session });
  }

  async submitInput(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["submitInput"]>[0], "session">,
  ): Promise<InputReceipt> {
    const binding = this.requireBinding(locator);
    return this.host.submitInput({ ...request, session: binding.session });
  }

  async resize(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["resize"]>[0], "session">,
  ): Promise<ResizeResult> {
    const binding = this.requireBinding(locator);
    return this.host.resize({ ...request, session: binding.session });
  }

  async inspect(
    locator: HiveTerminalBinding["locator"],
  ): Promise<BoundTerminalInspection> {
    const binding = this.requireBinding(locator);
    const inspection = await this.host.inspect(binding.session);
    if (!sameSession(inspection.session, binding.session)) {
      throw new TerminalHostBindingMismatchError();
    }
    return { binding, inspection };
  }

  async terminate(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["terminate"]>[0], "session">,
  ): Promise<TerminationResult> {
    const binding = this.requireBinding(locator);
    return this.host.terminate({ ...request, session: binding.session });
  }

  private requireBinding(
    locator: HiveTerminalBinding["locator"],
  ): HiveTerminalBinding {
    if (locator.instanceId !== this.instanceId) {
      throw new TerminalHostBindingNotFoundError();
    }
    const binding = this.bindings.getTerminalHostBindingByLocator(locator);
    if (binding === null) throw new TerminalHostBindingNotFoundError();
    return binding;
  }
}
