// The Hive authorization boundary. Four roles — user, orchestrator, writer, reader — and the action allowlists each holds are defined here. Two rules carry the whole design: 1. A request body is evidence of intent, never of authority. The subject a caller names is compared against the subject bound into its capability; it is never used to widen what the caller may do. 2. Only the daemon mints. There is no delegation and no attenuation grammar, so the authority graph is exactly one level deep. The single carve-out is the Codex root token (`root-token:mint`): the user's launcher asks the daemon to mint the orchestrator credential the codex root will present, because that root has no spawn path of its own — still daemon-minted, still one level deep.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isOrchestratorName } from "../../schemas/agent";
import type { Action, Capability, Role } from "../../schemas/authority";
import {
  type Hv1CapabilityConstraints,
  Hv1CapabilityRecordSchema,
} from "../../schemas/capability";
import { systemClock } from "../../shared/clock";
import { definedFields } from "../../shared/defined-fields";
import type { HiveDatabase } from "../database/hive-database";

export type { Action, Capability, Role };

export interface RoleGrant {
  readonly actions: readonly Action[];
  readonly anySubject: readonly Action[];
  /** Actions spendable exactly once per capability, consumed on success. */
  readonly oneShot: readonly Action[];
}

interface RoleGrants {
  readonly user: RoleGrant;
  readonly orchestrator: RoleGrant;
  readonly writer: RoleGrant;
  readonly reader: RoleGrant;
}

/** A valid caller reached a capability fence it does not hold. The refusal is
 * security working as designed, so observability must not report it as a daemon
 * fault. */
export class AuthorizationRefusedError extends Error {
  readonly code = "AUTHORIZATION_REFUSED";

  constructor(message: string) {
    super(message);
    this.name = "AuthorizationRefusedError";
  }
}

const AGENT_DIRECTED: readonly Action[] = [
  "agent:kill",
  "agent:mark-dead",
  "agent:recover",
  "settlement:execute",
  "approval:decide",
  // The queen may look at any agent she is running. She can already kill, recover and mark them dead without naming them ahead of time; withholding the ability to LOOK left her deciding those things blind, and made "what is she doing?" answerable only by interrupting the agent to ask — the one thing observation exists to avoid. Reading a pane takes no input, no focus, and no claim; `permitsTerminalObservation` still governs what a non-orchestrator may see, and an agent still cannot read a peer.
  "terminal:observe",
];

const USER_ACTIONS: readonly Action[] = [
  "status:read",
  "terminal:observe",
  "quota:read",
  "quota:write",
  "token-usage:read",
  "token-usage:write",
  "agent:spawn",
  "agent:kill",
  "agent:mark-dead",
  "agent:recover",
  "settlement:decide",
  "settlement:execute",
  "approval:read",
  "approval:decide",
  "message:send",
  "message:ack",
  "message:read",
  "inbox:read",
  "branch:land",
  "memory:read",
  "memory:write",
  "memory:delete",
  "event:report",
  "telemetry:report",
  // Autonomy is the user's dial: only the user credential (the user's own CLI and the Workspace acting for them) may write it. Agents observing it is harmless; an agent raising it would be a sandbox escape.
  "autonomy:read",
  "autonomy:write",
  "routing-policy:read",
  "routing-policy:write",
  // Which vendor runs the live Queen is the user's dial, exactly like autonomy: the Workspace and the user's CLI hold the user credential. The queen choosing her own successor — or an agent choosing its supervisor — would be self-authorization.
  "queen-provider:write",
  "run-control:write",
  "workspace-visibility:write",
  // The one sanctioned token issuance outside the daemon's own spawn path: the launcher mints the Codex root's capability — the single carve-out the no-delegation rule permits.
  "root-token:mint",
];

// The orchestrator decides what work happens; the writer puts code on main. Neither role is a superset of the other, so a stolen credential of either kind buys a strict subset of the control plane.
export const ROLE_GRANTS: RoleGrants = {
  // The user is the Hive CLI and the Workspace acting for them — the root of the local trust chain. Its subject scope is unrestricted because narrowing it would buy nothing: a caller that can already spawn and kill any agent gains no new authority from also being able to name one.
  user: {
    actions: USER_ACTIONS,
    anySubject: USER_ACTIONS,
    oneShot: [],
  },
  orchestrator: {
    actions: [
      "status:read",
      "terminal:observe",
      "quota:read",
      "quota:write",
      "token-usage:read",
      "agent:spawn",
      "agent:kill",
      "agent:mark-dead",
      "agent:recover",
      "settlement:decide",
      "settlement:execute",
      "approval:read",
      "approval:decide",
      "message:send",
      "message:ack",
      "message:read",
      "inbox:read",
      // The queen's pull path to her shipped skills. Agents get no share of it: their skills reach their worktrees by provisioning, so the pull path would be a second door to what they already hold.
      "knowledge:read",
      // Opening the run root the board hangs from. Orchestrator-only and distinct from run-control:write, which stays the user's: this opens a run that grants nothing.
      "run:bootstrap",
      "node:create",
      "grant:issue",
      "task:write",
      // Board story of record: workers read their own task; the queen may read any.
      "task:read",
      "review:write",
      // Work products, both directions: the queen stores what she concludes and reads what her agents concluded. Reading is the point — an artifact she cannot open is a finished analysis nobody ever sees.
      "artifact:write",
      "artifact:read",
      "ownership:transfer",
      "memory:read",
      "memory:write",
      "memory:delete",
      "event:report",
      "telemetry:report",
      "autonomy:read",
      "succession:write",
    ],
    anySubject: AGENT_DIRECTED,
    oneShot: [],
  },
  writer: {
    actions: [
      "status:read",
      "status:write",
      "terminal:observe",
      "quota:read",
      "message:send",
      "message:ack",
      "message:read",
      "inbox:read",
      "branch:land",
      "node:create",
      "grant:issue",
      "task:write",
      "task:read",
      "review:write",
      "artifact:write",
      "artifact:read",
      "ownership:transfer",
      "memory:read",
      "memory:write",
      "event:report",
      "telemetry:report",
    ],
    anySubject: [],
    oneShot: ["branch:land"],
  },
  reader: {
    actions: [
      "status:read",
      "status:write",
      "terminal:observe",
      "quota:read",
      "message:send",
      "message:ack",
      "message:read",
      "inbox:read",
      // Read-only agents still need the board story they were hired for.
      "task:read",
      // A reader reviews what other agents produced, so it opens artifacts; it stores none, because a role that cannot write code has no work product to file.
      "artifact:read",
      "memory:read",
      "event:report",
      "telemetry:report",
    ],
    anySubject: [],
    oneShot: [],
  },
};

// Epoch checks exist to stop stale authority. Status reports and terminal observation bind to the current agent incarnation even though ordinary status reads remain available across rotations.
const EPOCH_CHECKED: ReadonlySet<Action> = new Set<Action>([
  "branch:land",
  "node:create",
  "grant:issue",
  "task:write",
  "review:write",
  "ownership:transfer",
  "message:ack",
  "status:write",
  "terminal:observe",
]);

/** Actions a `writeRevoked` agent may not perform even at a current epoch. */
const WRITE_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "branch:land",
  "node:create",
  "grant:issue",
  "task:write",
  "review:write",
  "ownership:transfer",
  "memory:write",
  "memory:delete",
]);

export interface AuditEntry {
  readonly at: string;
  readonly route: string;
  readonly action: Action | null;
  readonly callerSubject: string | null;
  readonly callerRole: Role | null;
  readonly capabilityId: string | null;
  readonly requestedSubject: string | null;
  readonly epoch: number | null;
  readonly decision: "allow" | "deny";
  readonly reason: string | null;
}

export type DenialReason =
  | "capability.absent"
  | "capability.malformed"
  | "capability.unknown"
  | "capability.expired"
  | "capability.revoked"
  | "capability.authority-unknown"
  | "capability.stale-epoch"
  | "capability.forbidden-action"
  | "capability.foreign-subject"
  | "capability.replayed"
  | "capability.write-revoked";

export interface Denial {
  readonly ok: false;
  readonly reason: DenialReason;
  /** 401 when no usable credential was presented; 403 when one was, and lost. */
  readonly status: 401 | 403;
  readonly message: string;
}

export type Decision =
  { readonly ok: true; readonly capability: Capability } | Denial;

export type RouteAuthorization =
  | { readonly ok: true; readonly capability: Capability }
  | { readonly ok: false; readonly response: Response };

const deny = (
  reason: DenialReason,
  status: 401 | 403,
  message: string,
): Denial => ({ ok: false, reason, status, message });

const TOKEN_PREFIX = "hv1";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function secretMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseToken(
  token: string,
): { id: string; secret: string } | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  const [prefix, id, secret] = parts;
  if (prefix !== TOKEN_PREFIX) return null;
  if (id === undefined || secret === undefined) return null;
  if (id.length === 0 || secret.length === 0) return null;
  return { id, secret };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export interface AuthorizeRequest {
  readonly action: Action;
  readonly subject?: string | undefined;
  readonly route: string;
}

/** Reads the live epoch/revocation state of an agent, or null when the subject is not a spawned agent (the user and the orchestrator have no row). */
export type AgentAuthorityLookup = (
  name: string,
) => { capabilityEpoch: number; writeRevoked: boolean } | null;

export class CapabilityStore {
  constructor(
    private readonly db: HiveDatabase,
    private readonly agentAuthority: AgentAuthorityLookup,
    private readonly now: () => Date = systemClock,
  ) {}

  mint(
    subject: string,
    role: Role,
    options: {
      epoch?: number;
      ttlMs?: number;
      constraints?: Hv1CapabilityConstraints;
      subjects?: readonly string[];
    } = {},
  ) {
    const issued = this.now();
    const id = crypto.randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const capability = Hv1CapabilityRecordSchema.parse({
      id,
      subject,
      role,
      epoch: options.epoch ?? 0,
      ...definedFields({
        constraints: options.constraints,
        subjects: options.subjects,
      }),
      issuedAt: issued.toISOString(),
      expiresAt: new Date(
        issued.getTime() + (options.ttlMs ?? DEFAULT_TTL_MS),
      ).toISOString(),
      revokedAt: null,
    });
    this.db.insertCapability(capability, hashSecret(secret));
    return { token: `${TOKEN_PREFIX}.${id}.${secret}`, capability };
  }

  /** Resolves a bearer token to exactly one capability. Authentication only: it says who is speaking, never what they may do. */
  authenticate(token: string | null): Decision {
    if (token === null) {
      return deny("capability.absent", 401, "No capability was presented");
    }
    const parsed = parseToken(token);
    if (parsed === null) {
      return deny("capability.malformed", 401, "Malformed capability token");
    }
    const found = this.db.getCapability(parsed.id);
    if (found === null) {
      return deny("capability.unknown", 401, "Unknown capability");
    }
    if (!secretMatches(parsed.secret, found.secretHash)) {
      // An id that exists with a wrong secret is indistinguishable, to the caller, from an id that never existed.
      return deny("capability.unknown", 401, "Unknown capability");
    }
    const capability = found.capability;
    if (capability.revokedAt !== null) {
      return deny("capability.revoked", 403, "Capability was revoked");
    }
    if (this.now().toISOString() >= capability.expiresAt) {
      return deny("capability.expired", 401, "Capability expired");
    }
    return { ok: true, capability };
  }

  authorize(capability: Capability, request: AuthorizeRequest): Decision {
    const grant = ROLE_GRANTS[capability.role];
    if (!grant.actions.includes(request.action)) {
      return deny(
        "capability.forbidden-action",
        403,
        `Role ${capability.role} may not ${request.action}`,
      );
    }

    const subject = request.subject;
    const sameRootSubject =
      subject !== undefined &&
      isOrchestratorName(subject) &&
      isOrchestratorName(capability.subject);
    if (
      subject !== undefined &&
      subject !== capability.subject &&
      !sameRootSubject &&
      !grant.anySubject.includes(request.action)
    ) {
      return deny(
        "capability.foreign-subject",
        403,
        `${capability.subject} may not ${request.action} on ${subject}`,
      );
    }

    // The epoch and the write revocation belong to the *named* agent, which for a self-bound action is the caller and for a user is someone else.
    const authorityOf = subject ?? capability.subject;
    const authority = this.agentAuthority(authorityOf);

    if (
      authority === null &&
      (capability.role === "writer" || capability.role === "reader") &&
      (WRITE_ACTIONS.has(request.action) || EPOCH_CHECKED.has(request.action))
    ) {
      return deny(
        "capability.authority-unknown",
        403,
        `No live authority record exists for ${authorityOf}`,
      );
    }

    if (WRITE_ACTIONS.has(request.action) && authority?.writeRevoked === true) {
      return deny(
        "capability.write-revoked",
        403,
        `Write and landing authority is revoked for ${authorityOf}`,
      );
    }

    if (
      EPOCH_CHECKED.has(request.action) &&
      authority !== null &&
      capability.role !== "user" &&
      authority.capabilityEpoch !== capability.epoch
    ) {
      return deny(
        "capability.stale-epoch",
        403,
        `Capability epoch ${capability.epoch} is stale; ${authorityOf} is at epoch ${authority.capabilityEpoch}`,
      );
    }

    if (
      grant.oneShot.includes(request.action) &&
      this.db.isOneShotConsumed(capability.id, request.action)
    ) {
      return deny(
        "capability.replayed",
        403,
        `The one-shot ${request.action} grant for ${capability.subject} is already spent`,
      );
    }

    return { ok: true, capability };
  }

  /** Spends a one-shot right up front, so two concurrent lands cannot both merge. Returns false when the right was already spent — that is a replay. A caller that then fails must `releaseOneShot`, because a fast-forward merge legitimately loses to a moving `main` and has to stay retryable. */
  consumeOneShot(capability: Capability, action: Action): boolean {
    if (!ROLE_GRANTS[capability.role].oneShot.includes(action)) return true;
    return this.db.consumeOneShot(
      capability.id,
      action,
      this.now().toISOString(),
    );
  }

  releaseOneShot(capability: Capability, action: Action): void {
    if (!ROLE_GRANTS[capability.role].oneShot.includes(action)) return;
    this.db.releaseOneShot(capability.id, action);
  }

  /** Re-arms a spent one-shot for a subject by explicit approval (the land-grant re-arm flow): deleting the consumption row grants exactly one more spend, and approving the same request twice finds nothing left to delete. Returns how many rows were released. */
  rearmOneShot(subject: string, action: Action): number {
    return this.db.releaseOneShotForSubject(subject, action);
  }

  /** Revocation by subject. Advancing an agent's epoch kills its epoch-checked rights; this kills the credential outright, for kill and mark-dead. */
  revokeSubject(subject: string): number {
    return this.db.revokeCapabilitiesForSubject(
      subject,
      this.now().toISOString(),
    );
  }

  audit(entry: Omit<AuditEntry, "at">): void {
    this.db.insertAuditEntry({ ...entry, at: this.now().toISOString() });
  }

  /** Authentication happens before a request body is parsed, so a caller with no credential is denied without the daemon ever reading what it asked for. */
  authenticateAndAudit(token: string | null, route: string): Decision {
    const decision = this.authenticate(token);
    if (!decision.ok) {
      this.audit({
        route,
        action: null,
        callerSubject: null,
        callerRole: null,
        capabilityId: null,
        requestedSubject: null,
        epoch: null,
        decision: "deny",
        reason: decision.reason,
      });
    }
    return decision;
  }

  /** Denials are always audited; allows only for the routes that mutate, so status polls cannot drown the rows that matter. */
  authorizeAndAudit(
    capability: Capability,
    request: AuthorizeRequest,
    auditAllow: boolean,
    allowReason: string | null = null,
  ): Decision {
    const decision = this.authorize(capability, request);
    const shared = {
      route: request.route,
      action: request.action,
      callerSubject: capability.subject,
      callerRole: capability.role,
      capabilityId: capability.id,
      requestedSubject: request.subject ?? null,
      epoch: capability.epoch,
    } as const;
    if (!decision.ok) {
      this.audit({ ...shared, decision: "deny", reason: decision.reason });
    } else if (auditAllow) {
      this.audit({ ...shared, decision: "allow", reason: allowReason });
    }
    return decision;
  }
}

export function permitsTerminalObservation(
  capability: Capability,
  readerAgentId: string | null,
  targetAgentId: string,
  include: "metadata" | "visible-text",
): boolean {
  const self = readerAgentId !== null && readerAgentId === targetAgentId;
  if (self && include === "metadata") return true;
  if (self && include === "visible-text") {
    return capability.constraints?.content === true;
  }
  // The orchestrator reads any agent in her own fleet, metadata or text. She already spawns, kills and recovers these agents unnamed, so looking at one takes no new authority; observation takes no input, no focus, and no claim. This does not widen what an AGENT may see — a peer still cannot read a peer, and self-reads still require the content constraint.
  if (capability.role === "orchestrator") return true;
  if (capability.role !== "user" || !("subjects" in capability)) return false;
  return capability.subjects.includes(targetAgentId);
}
