import type {
  ClaimResult,
  InputReceipt,
  ResizeResult,
  SessionInspection,
  SessionRef,
  TerminalHost,
  TerminationResult,
} from "./terminal-host-contract";
import type {
  CreateResult,
  SessionHost,
  SessionLocator,
  SessionSpec,
} from "./contract";
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
  | "claimInput"
  | "submitInput"
  | "resize"
  | "inspect"
  | "list"
  | "terminate"
> & Pick<SessionHost, "create">;

export type HiveTerminalPolicy = HiveTerminalBinding;

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
    super("sessiond returned evidence outside its Hive locator binding");
    this.name = "TerminalHostBindingMismatchError";
  }
}

function sameSession(left: SessionRef, right: SessionRef): boolean {
  return left.key === right.key && left.incarnation === right.incarnation;
}

function sameLocator(
  left: SessionLocator,
  right: SessionLocator,
): boolean {
  const sameSubject = left.subject.kind === right.subject.kind &&
    (left.subject.kind === "root" || (
      right.subject.kind === "agent" &&
      left.subject.agentId === right.subject.agentId
    ));
  return left.schemaVersion === right.schemaVersion &&
    left.instanceId === right.instanceId &&
    sameSubject &&
    left.generation === right.generation &&
    left.sessionId === right.sessionId &&
    left.hostKind === right.hostKind &&
    left.engineBuildId === right.engineBuildId;
}

/** Hive policy adapter over the project-neutral frozen TerminalHost contract. */
export class HiveTerminalHostAdapter {
  constructor(
    private readonly host: TerminalLifecycleHost,
    private readonly bindings: TerminalHostBindingStore,
    private readonly instanceId: string,
  ) {}

  async create(
    spec: SessionSpec,
    initialInput: Uint8Array,
    policy: HiveTerminalPolicy,
  ): Promise<CreateResult> {
    if (policy.locator.instanceId !== this.instanceId) {
      throw new TerminalHostBindingNotFoundError();
    }
    if (!sameLocator(spec.locator, policy.locator)) {
      throw new TerminalHostBindingMismatchError();
    }
    this.bindings.bindTerminalHostSession(policy);
    const result = await this.host.create(spec, initialInput);
    if (!sameLocator(result.locator, policy.locator)) {
      throw new TerminalHostBindingMismatchError();
    }
    return result;
  }

  async list(): Promise<readonly BoundTerminalInspection[]> {
    const bindings = new Map(
      this.bindings.listTerminalHostBindings(this.instanceId)
        .map((binding) => [binding.locator.sessionId, binding]),
    );
    const bound: BoundTerminalInspection[] = [];
    for (const inspection of await this.host.list()) {
      const binding = bindings.get(inspection.session.key);
      if (binding !== undefined) bound.push({ binding, inspection });
    }
    return bound;
  }

  async claimInput(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["claimInput"]>[0], "session">,
  ): Promise<ClaimResult> {
    const { session } = await this.requireTransportBinding(locator);
    return this.host.claimInput({ ...request, session });
  }

  async submitInput(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["submitInput"]>[0], "session">,
  ): Promise<InputReceipt> {
    const { session } = await this.requireTransportBinding(locator);
    return this.host.submitInput({ ...request, session });
  }

  async resize(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["resize"]>[0], "session">,
  ): Promise<ResizeResult> {
    const { session } = await this.requireTransportBinding(locator);
    return this.host.resize({ ...request, session });
  }

  async inspect(
    locator: HiveTerminalBinding["locator"],
  ): Promise<BoundTerminalInspection> {
    const { binding, session } = await this.requireTransportBinding(locator);
    const inspection = await this.host.inspect(session);
    if (!sameSession(inspection.session, session)) {
      throw new TerminalHostBindingMismatchError();
    }
    return { binding, inspection };
  }

  async terminate(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["terminate"]>[0], "session">,
  ): Promise<TerminationResult> {
    const { session } = await this.requireTransportBinding(locator);
    return this.host.terminate({ ...request, session });
  }

  private async requireTransportBinding(
    locator: HiveTerminalBinding["locator"],
  ): Promise<Readonly<{ binding: HiveTerminalBinding; session: SessionRef }>> {
    const binding = this.requireBinding(locator);
    const matches = (await this.host.list()).filter(
      (inspection) => inspection.session.key === locator.sessionId,
    );
    if (matches.length === 0) throw new TerminalHostBindingNotFoundError();
    if (matches.length !== 1) throw new TerminalHostBindingMismatchError();
    return { binding, session: matches[0]!.session };
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
