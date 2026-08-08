// Owns workspace-owner registration watch and the /workspace-owner HTTP
// surface. HiveDaemon supplies visibility authority and narrow shutdown
// callbacks; the service never reaches back into the daemon. stopInProgress
// stays on HiveDaemon — the service only reads isStopping and calls
// requestShutdown.

import type {
  Action,
  RouteAuthorization,
} from "../authorization/authorization-service";
import { DAEMON_STARTUP_TIMEOUT_MS } from "../lifecycle/daemon-lifecycle";
import {
  WorkspaceOwnerSchema,
  type WorkspaceVisibilityAuthority,
} from "../session-host/workspace-visibility";

export const WORKSPACE_OWNER_WATCH_MS = 5_000;
export const WORKSPACE_OWNER_REGISTRATION_TIMEOUT_MS = 15_000;

export interface WorkspaceOwnerServiceDependencies {
  manageLifecycle: boolean;
  workspaceVisibility: WorkspaceVisibilityAuthority | null;
  isServerRunning: () => boolean;
  isStopping: () => boolean;
  /** Sets stopInProgress on HiveDaemon and starts initiateShutdown. */
  requestShutdown: () => void;
  authorizeRoute: (
    request: Request,
    route: string,
    action: Action,
    options?: Readonly<{ withSubject?: boolean; auditAllow?: boolean }>,
  ) => RouteAuthorization;
}

const json = (value: unknown, init?: ResponseInit): Response =>
  Response.json(value, init);

export class WorkspaceOwnerService {
  private workspaceOwnerTimer: ReturnType<typeof setInterval> | null = null;
  private ownerRegistrationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: WorkspaceOwnerServiceDependencies) {}

  /** Start the owner-liveness interval and the initial registration timeout. */
  start(): void {
    this.workspaceOwnerTimer = setInterval(() => {
      this.checkWorkspaceOwnerAlive();
    }, WORKSPACE_OWNER_WATCH_MS);
    this.workspaceOwnerTimer.unref?.();
    this.armRegistrationTimeout(
      DAEMON_STARTUP_TIMEOUT_MS + WORKSPACE_OWNER_REGISTRATION_TIMEOUT_MS,
    );
  }

  /** After startup recovery finishes, replace the long registration timeout with the short one. */
  armRegistrationTimeoutAfterRecovery(): void {
    this.armRegistrationTimeout(WORKSPACE_OWNER_REGISTRATION_TIMEOUT_MS, true);
  }

  private armRegistrationTimeout(timeoutMs: number, replace = false): void {
    if (
      !this.deps.manageLifecycle ||
      this.deps.workspaceVisibility === null ||
      this.deps.workspaceVisibility.ownerRegistered() ||
      !this.deps.isServerRunning() ||
      this.deps.isStopping()
    ) {
      return;
    }
    if (this.ownerRegistrationTimer !== null) {
      if (!replace) return;
      clearTimeout(this.ownerRegistrationTimer);
      this.ownerRegistrationTimer = null;
    }
    this.ownerRegistrationTimer = setTimeout(() => {
      this.ownerRegistrationTimer = null;
      if (
        !this.deps.workspaceVisibility?.ownerRegistered() &&
        !this.deps.isStopping()
      ) {
        this.deps.requestShutdown();
      }
    }, timeoutMs);
  }

  async workspaceOwnerEndpoint(request: Request): Promise<Response> {
    const route = "/workspace-owner";
    const authorized = this.deps.authorizeRoute(
      request,
      route,
      "workspace-visibility:write",
    );
    if (!authorized.ok) return authorized.response;
    if (this.deps.workspaceVisibility === null) {
      return json(
        { error: "workspace ownership authority is unavailable" },
        { status: 503 },
      );
    }
    const body = WorkspaceOwnerSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success)
      return json({ error: body.error.message }, { status: 400 });
    const result = this.deps.workspaceVisibility.register(body.data);
    if (result.state !== "accepted") return json(result, { status: 409 });
    if (this.ownerRegistrationTimer !== null) {
      clearTimeout(this.ownerRegistrationTimer);
      this.ownerRegistrationTimer = null;
    }
    return json({ state: "accepted" });
  }

  /** The Workspace's own liveness is policy the daemon owns: a Hive with no Workspace has nobody to serve, so it shuts down. Nothing a terminal needs rides on this check — terminals observe their own supervisor and outlive any number of missed ticks. Do not renew terminal lifetime here: agent survival must not depend on a liveness message arriving on time. */
  checkWorkspaceOwnerAlive(): void {
    const workspaceVisibility = this.deps.workspaceVisibility;
    if (workspaceVisibility == null) return;
    if (workspaceVisibility.sourceVerified()) return;
    if (!workspaceVisibility.ownerRegistered()) return;
    if (this.deps.isStopping()) return;
    this.deps.requestShutdown();
  }

  /** Clears owner-watch timers; called from HiveDaemon.stop(). */
  close(): void {
    if (this.workspaceOwnerTimer !== null) {
      clearInterval(this.workspaceOwnerTimer);
      this.workspaceOwnerTimer = null;
    }
    if (this.ownerRegistrationTimer !== null) {
      clearTimeout(this.ownerRegistrationTimer);
      this.ownerRegistrationTimer = null;
    }
  }
}
