import { z } from "zod";
import type { Action, Capability, Decision, Denial } from "./capabilities";
import type { HiveDatabase } from "./db";
import type { OrchestratorSessiondController } from "./orchestrator-sessiond";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  requireSessiondRootLocator,
} from "./session-host/hive-terminal-host";
import { sameSessionLocator } from "./session-host/locators";
import {
  isOrchestratorName,
  SessionLocatorSchema,
  TerminalGeometrySchema,
} from "../schemas";

const json = (value: unknown, init?: ResponseInit): Response =>
  Response.json(value, init);

/**
 * The viewer attach-grant endpoint, with its dependencies named.
 *
 * Fifth extraction of the `HiveDaemon` decomposition (audit §11). The three
 * authorization callbacks cross as functions rather than the capability store
 * itself: this route needs the daemon's audited decisions, not the ability to
 * mint its own, and passing the store would hand a route the authority to
 * decide what it is allowed to do.
 */
export interface AttachGrantDeps {
  db: HiveDatabase;
  orchestratorSessiond: OrchestratorSessiondController | null;
  terminalHost: HiveTerminalHostAdapter;
  authenticate: (request: Request, route: string) => Decision;
  authorize: (
    capability: Capability,
    route: string,
    action: Action,
    subject: string | undefined,
    auditAllow?: boolean,
    allowReason?: string | null,
  ) => Decision;
  denied: (decision: Denial) => Response;
}

export async function attachGrantEndpoint(
  deps: AttachGrantDeps,
  pathname: string,
  request: Request,
): Promise<Response> {
  const authenticated = deps.authenticate(request, "/agents/attach-grant");
  if (!authenticated.ok) return deps.denied(authenticated);
  const name = decodeURIComponent(
    pathname.slice("/agents/".length, -"/attach-grant".length),
  );
  if (name === "") {
    return json({ error: "Invalid attach request: no agent" }, { status: 400 });
  }
  const decision = deps.authorize(
    authenticated.capability,
    "/agents/attach-grant",
    "terminal:observe",
    name,
  );
  if (!decision.ok) return deps.denied(decision);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = z
    .strictObject({
      sessionLocator: SessionLocatorSchema,
      viewerId: z.string().min(1),
      geometry: TerminalGeometrySchema,
      operations: z.array(z.enum(["view", "human-input", "resize"])),
    })
    .safeParse(body);
  if (!parsed.success) {
    return json(
      {
        state: "rejected",
        reason: "invalid-attach-request",
        error:
          "Attach requires the pane's exact sessionLocator, viewer, and geometry",
      },
      { status: 400 },
    );
  }
  if (isOrchestratorName(name)) {
    const current = deps.orchestratorSessiond?.snapshot() ?? null;
    if (
      current === null ||
      !sameSessionLocator(current.locator, parsed.data.sessionLocator)
    ) {
      return json(
        {
          state: "rejected",
          reason: "session-locator-mismatch",
          error: "Hive refused to attach queen: its session generation changed",
        },
        { status: 409 },
      );
    }
    if (current.state !== "running") {
      return json(
        {
          state: "rejected",
          reason:
            current.state === "awaiting-visibility"
              ? "session-not-ready"
              : "session-not-running",
          error:
            current.diagnostic ??
            (current.state === "awaiting-visibility"
              ? "Queen terminal is still starting"
              : `Queen terminal is ${current.state}`),
        },
        { status: 409 },
      );
    }
    try {
      const grant = await deps.terminalHost.issueAttach(
        requireSessiondRootLocator(current.locator),
        {
          viewerId: parsed.data.viewerId,
          geometry: parsed.data.geometry,
          operations: parsed.data.operations,
        },
      );
      return json({ state: "granted", grant });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Attach failed" },
        { status: 500 },
      );
    }
  }
  const agent = deps.db.getAgentByName(name);
  if (agent === null) {
    return json({ error: `Hive agent not found: ${name}` }, { status: 404 });
  }
  if (
    agent.sessionLocator === undefined ||
    !sameSessionLocator(agent.sessionLocator, parsed.data.sessionLocator)
  ) {
    return json(
      {
        state: "rejected",
        reason: "session-locator-mismatch",
        error: `Hive refused to attach ${name}: its session generation changed`,
      },
      { status: 409 },
    );
  }
  try {
    const locator = requireSessiondAgentLocator({
      id: agent.id,
      sessionLocator: agent.sessionLocator,
    });
    const grant = await deps.terminalHost.issueAttach(locator, {
      viewerId: parsed.data.viewerId,
      geometry: parsed.data.geometry,
      operations: parsed.data.operations,
    });
    return json({ state: "granted", grant });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Attach failed" },
      { status: 500 },
    );
  }
}
