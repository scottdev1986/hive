import { createHash } from "node:crypto";
import type {
  Action,
  Capability,
  Decision,
} from "../authorization/authorization-service";
import type { HiveDatabase } from "../database/hive-database";
import {
  type HiveTerminalHostAdapter,
  sessiondTeardownSucceeded,
} from "../session-host/hive-terminal-host";
import type { HiveTerminalBinding } from "../session-host/terminal-host-binding";
import { sameSessionLocator } from "../session-host/locators";
import type { AgentRecord } from "../../schemas/agent";
import {
  LiveRunControlIntentSchema,
  LiveRunControlProjectionSchema,
  LiveRunControlResultSchema,
  type LiveRunControlIntent,
  type LiveRunControlProjection,
  type LiveRunControlResult,
} from "../../schemas/live-run-control";
import type { SessionLocator } from "../../schemas/session-protocol";
import { errorMessage } from "../../shared/error-message";

const ROUTE = "/live-run-control";

type LiveRunControlDatabase = Pick<
  HiveDatabase,
  | "getAgentById"
  | "getActiveProviderRunForAgent"
  | "getTerminalHostBindingByLocator"
>;

type LiveRunTerminalHost = Pick<
  HiveTerminalHostAdapter,
  | "inspectControl"
  | "reconcileProviderRun"
  | "verifyAdapterChildIdentity"
  | "stopProvider"
>;

export interface LiveRunControlEndpointDependencies {
  db: LiveRunControlDatabase;
  terminalHost: LiveRunTerminalHost;
  terminateAgent(agent: AgentRecord): Promise<unknown>;
  now(): Date;
  authenticate(request: Request, route: string): Decision;
  authorize(
    capability: Capability,
    route: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
    allowReason?: string | null,
  ): Decision;
  denied(decision: Extract<Decision, { readonly ok: false }>): Response;
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function sameShellRoot(
  left: { pid: number; startToken: string; processGroupId: number },
  right: { pid: number; startToken: string; processGroupId: number },
): boolean {
  return (
    left.pid === right.pid &&
    left.startToken === right.startToken &&
    left.processGroupId === right.processGroupId
  );
}

function operationId(intent: LiveRunControlIntent): string {
  return `lro_${createHash("sha256")
    .update(intent.idempotencyKey)
    .update("\0")
    .update(JSON.stringify(intent.body))
    .digest("hex")
    .slice(0, 32)}`;
}

function result(
  intent: LiveRunControlIntent,
  projection: LiveRunControlProjection,
  outcome: LiveRunControlResult["outcome"],
): LiveRunControlResult {
  return LiveRunControlResultSchema.parse({
    schemaVersion: 1,
    intentId: intent.intentId,
    operationId: operationId(intent),
    postStateToken: {
      kind: "epoch",
      epoch: String(projection.locator.generation),
    },
    outcome,
    observedPostState: projection,
  });
}

function refusal(
  intent: LiveRunControlIntent,
  projection: LiveRunControlProjection,
  code: string,
  message: string,
): Response {
  return response(
    result(intent, projection, {
      status: "rejected",
      failure: { code, message },
    }),
    409,
  );
}

function terminalBinding(
  deps: LiveRunControlEndpointDependencies,
  locator: SessionLocator,
): HiveTerminalBinding | null {
  return deps.db.getTerminalHostBindingByLocator(locator);
}

async function project(
  deps: LiveRunControlEndpointDependencies,
  agent: AgentRecord,
): Promise<LiveRunControlProjection> {
  const locator = agent.sessionLocator;
  if (
    locator === undefined ||
    locator.hostKind !== "sessiond" ||
    locator.subject.kind !== "agent" ||
    locator.subject.agentId !== agent.id
  ) {
    throw new Error(`Agent ${agent.id} has no exact sessiond locator`);
  }
  const inspected = await deps.terminalHost.inspectControl(locator);
  const binding = terminalBinding(deps, locator);
  const terminalResult = binding?.terminationEvidence ?? null;
  // A process-tree target never reports "terminated" — the inspector says
  // `unknown` unconditionally there because macOS cannot prove containment
  // (terminal-host-v1.md row J) — so demanding that exact state reported every
  // clean kill as unknown. The shared predicate reads the documented floor.
  const terminated =
    terminalResult !== null &&
    sessiondTeardownSucceeded(terminalResult.result) &&
    inspected.terminal.presence !== "present";

  const active = deps.terminalHost.reconcileProviderRun(locator);
  let providerRun: LiveRunControlProjection["providerRun"];
  if (active === null) {
    providerRun = { state: "absent" };
  } else if (
    active.agentId === agent.id &&
    active.provider === agent.tool &&
    active.adapterChild !== null &&
    sameSessionLocator(active.terminal, locator) &&
    deps.terminalHost.verifyAdapterChildIdentity(active.adapterChild) &&
    inspected.foregroundProcessGroupId === active.adapterChild.processGroupId
  ) {
    providerRun = {
      state: "running",
      runId: active.runId,
      provider: active.provider,
      process: active.adapterChild,
    };
  } else {
    providerRun = {
      state: "unknown",
      reason:
        "the active ProviderRun is not the verified foreground process group for this terminal",
    };
  }

  let shell: LiveRunControlProjection["shell"];
  if (terminated) {
    shell = { state: "terminated" };
  } else if (
    inspected.terminal.presence === "present" &&
    inspected.terminal.executableVerified &&
    inspected.terminal.shellRoot !== null
  ) {
    const root = inspected.terminal.shellRoot;
    shell = {
      state: "retained",
      root,
      foreground:
        inspected.foregroundProcessGroupId === root.processGroupId
          ? "shell"
          : providerRun.state === "running" &&
              inspected.foregroundProcessGroupId ===
                providerRun.process.processGroupId
            ? "provider"
            : "other",
    };
  } else {
    shell = {
      state: "unknown",
      reason:
        inspected.terminal.presence === "present"
          ? "sessiond could not verify the retained zsh root"
          : "the terminal host is absent without verified termination evidence",
    };
  }

  const processCensus: LiveRunControlProjection["processCensus"] = terminated
    ? { state: "terminated" }
    : inspected.processCensus.completeness === "complete"
      ? {
          state: "complete",
          source: "sessiond-process-tree",
          members: [...inspected.processCensus.members],
          observedAt: inspected.processCensus.evidenceAt,
        }
      : {
          state: "unknown",
          reason:
            inspected.processCensus.diagnostics.join(", ") ||
            `sessiond process census is ${inspected.processCensus.completeness}`,
        };

  let termination: LiveRunControlProjection["termination"];
  if (terminalResult === null) {
    termination =
      binding?.terminationAudit === undefined
        ? { state: "not-requested" }
        : {
            state: "unknown",
            reason: "a termination request exists without a final result",
          };
  } else if (terminated) {
    termination = {
      state: "terminated",
      completedAt: terminalResult.completedAt,
      survivors: [],
    };
  } else if (terminalResult.result.survivors.length > 0) {
    termination = {
      state: "survivors",
      completedAt: terminalResult.completedAt,
      survivors: terminalResult.result.survivors,
    };
  } else {
    termination = {
      state: "unknown",
      reason:
        terminalResult.result.errors
          .map((entry) => entry.diagnosticId)
          .join(", ") || terminalResult.result.state,
    };
  }

  const stopEnabled =
    providerRun.state === "running" &&
    shell.state === "retained" &&
    shell.foreground === "provider" &&
    processCensus.state === "complete";
  // Terminate destroys the terminal, and what identifies WHICH terminal is the
  // retained shell — presence, a verified executable, and a non-null verified
  // shellRoot. The kill is keyed on that session locator and never on the
  // census members, so a census adds no identity safety here; it is an
  // enumeration, which is what reporting survivors afterwards needs, not what
  // deciding to act needs. Requiring it withheld the destructive fallback in
  // exactly the degraded state that fallback exists for. Stop keeps the
  // requirement above, where it is aiming at one specific process group.
  const terminateEnabled = shell.state === "retained";
  return LiveRunControlProjectionSchema.parse({
    schemaVersion: 1,
    observedAt: deps.now().toISOString(),
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.tool,
    locator,
    providerRun,
    shell,
    processCensus,
    termination,
    controls: {
      stopProvider: {
        enabled: stopEnabled,
        reason: stopEnabled
          ? null
          : providerRun.state === "absent"
            ? "no provider is running in this terminal"
            : "the provider process group is not fully verified",
      },
      terminateTerminal: {
        enabled: terminateEnabled,
        reason: terminateEnabled
          ? null
          : termination.state === "terminated"
            ? "this terminal generation is terminated"
            : "the retained shell and its process census are not fully verified",
      },
    },
  });
}

function agentFor(
  deps: LiveRunControlEndpointDependencies,
  agentId: string,
): AgentRecord | null {
  return deps.db.getAgentById(agentId);
}

async function apply(
  deps: LiveRunControlEndpointDependencies,
  intent: LiveRunControlIntent,
  agent: AgentRecord,
): Promise<Response> {
  const before = await project(deps, agent);
  if (
    intent.expected.epoch !== String(before.locator.generation) ||
    !sameSessionLocator(intent.body.locator, before.locator)
  ) {
    return refusal(
      intent,
      before,
      "terminal-generation-mismatch",
      "The selected terminal generation changed; nothing was stopped.",
    );
  }

  if (intent.body.operation === "stop-provider") {
    if (
      before.providerRun.state === "absent" &&
      before.shell.state === "retained" &&
      before.shell.foreground === "shell"
    ) {
      return response(result(intent, before, { status: "accepted" }));
    }
  } else if (
    before.termination.state === "terminated" &&
    before.shell.state === "terminated"
  ) {
    return response(result(intent, before, { status: "accepted" }));
  }

  if (
    before.shell.state !== "retained" ||
    !sameShellRoot(intent.body.expectedShellRoot, before.shell.root)
  ) {
    return refusal(
      intent,
      before,
      "shell-identity-mismatch",
      "The retained zsh identity changed; nothing was stopped.",
    );
  }

  if (intent.body.operation === "stop-provider") {
    if (
      before.providerRun.state !== "running" ||
      before.providerRun.runId !== intent.body.expectedProviderRunId ||
      !before.controls.stopProvider.enabled
    ) {
      return refusal(
        intent,
        before,
        "provider-identity-mismatch",
        "The verified ProviderRun changed; nothing was stopped.",
      );
    }
    const current = deps.db.getActiveProviderRunForAgent(agent.id);
    if (
      current === null ||
      current.runId !== before.providerRun.runId ||
      !(await deps.terminalHost.stopProvider(before.locator, current))
    ) {
      throw new Error(
        "Stop Provider may have been sent, but its final process state is unknown",
      );
    }
    const after = await project(deps, agent);
    if (
      after.providerRun.state !== "absent" ||
      after.shell.state !== "retained" ||
      after.shell.foreground !== "shell" ||
      !sameShellRoot(after.shell.root, before.shell.root)
    ) {
      throw new Error(
        "Stop Provider did not read back the same retained zsh at foreground",
      );
    }
    return response(result(intent, after, { status: "accepted" }));
  }

  if (!before.controls.terminateTerminal.enabled) {
    return refusal(
      intent,
      before,
      "terminal-proof-incomplete",
      "The terminal process tree is not fully verified; nothing was stopped.",
    );
  }
  await deps.terminateAgent(agent);
  const after = await project(deps, agent);
  if (
    after.termination.state !== "terminated" ||
    after.shell.state !== "terminated" ||
    after.processCensus.state !== "terminated"
  ) {
    throw new Error(
      "Terminate Terminal completed without verified final process-tree evidence",
    );
  }
  return response(result(intent, after, { status: "accepted" }));
}

export async function liveRunControlEndpoint(
  deps: LiveRunControlEndpointDependencies,
  request: Request,
): Promise<Response> {
  const authenticated = deps.authenticate(request, ROUTE);
  if (!authenticated.ok) return deps.denied(authenticated);

  if (request.method === "GET") {
    const decision = deps.authorize(
      authenticated.capability,
      ROUTE,
      "status:read",
      undefined,
      false,
    );
    if (!decision.ok) return deps.denied(decision);
    const agentId = new URL(request.url).searchParams.get("agentId");
    if (agentId === null || agentId === "") {
      return response({ error: "agentId is required" }, 400);
    }
    const agent = agentFor(deps, agentId);
    if (agent === null) return response({ error: "agent not found" }, 404);
    try {
      return response(await project(deps, agent));
    } catch (error) {
      return response({ error: errorMessage(error) }, 500);
    }
  }

  if (request.method !== "POST") {
    return response({ error: "method not allowed" }, 405);
  }
  const parsed = LiveRunControlIntentSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return response({ error: parsed.error.message }, 400);
  }
  const agent = agentFor(deps, parsed.data.body.agentId);
  if (agent === null) return response({ error: "agent not found" }, 404);
  const decision = deps.authorize(
    authenticated.capability,
    ROUTE,
    "agent:kill",
    agent.name,
  );
  if (!decision.ok) return deps.denied(decision);
  try {
    return await apply(deps, parsed.data, agent);
  } catch (error) {
    return response({ error: errorMessage(error) }, 500);
  }
}
