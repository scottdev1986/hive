// The Hive authorization boundary. See docs/daemon/authorization.md
// for the binding contract; this file is its implementation and must not drift
// from it.
//
// Two rules carry the whole design:
//
//  1. A request body is evidence of intent, never of authority. The subject a
//     caller names is compared against the subject bound into its capability;
//     it is never used to widen what the caller may do.
//  2. Only the daemon mints. There is no delegation and no attenuation
//     grammar, so the authority graph is exactly one level deep. The single
//     carve-out is the Codex root token (`root-token:mint`): the operator's
//     launcher asks the daemon to mint the orchestrator credential the codex
//     root will present, because that root has no spawn path of its own —
//     still daemon-minted, still one level deep.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { HiveDatabase } from "./db";

export type Role =
  | "operator"
  | "orchestrator"
  | "writer"
  | "reader";

export type Action =
  | "status:read"
  | "quota:read"
  | "quota:write"
  | "token-usage:read"
  | "token-usage:write"
  | "agent:spawn"
  | "agent:kill"
  | "agent:mark-dead"
  | "agent:recover"
  | "approval:read"
  | "approval:decide"
  | "message:send"
  | "message:ack"
  | "message:read"
  | "inbox:read"
  | "branch:land"
  | "memory:read"
  | "memory:write"
  | "event:report"
  | "telemetry:report"
  | "root-token:mint"
  | "autonomy:read"
  | "autonomy:write"
  | "routing-policy:read"
  | "routing-policy:write"
  | "graphify:write";

export interface RoleGrant {
  /** The explicit action allowlist. Anything absent is denied. */
  readonly actions: readonly Action[];
  /** Actions this role may perform against a subject other than itself. */
  readonly anySubject: readonly Action[];
  /** Actions spendable exactly once per capability, consumed on success. */
  readonly oneShot: readonly Action[];
}

const AGENT_DIRECTED: readonly Action[] = [
  "agent:kill",
  "agent:mark-dead",
  "agent:recover",
  "approval:decide",
];

const OPERATOR_ACTIONS: readonly Action[] = [
  "status:read", "quota:read", "quota:write", "token-usage:read",
  "token-usage:write", "agent:spawn", "agent:kill",
  "agent:mark-dead", "agent:recover", "approval:read", "approval:decide",
  "message:send", "message:ack", "message:read", "inbox:read",
  "branch:land", "memory:read", "memory:write", "event:report",
  "telemetry:report",
  // Autonomy is the human's dial: only the operator credential (the user's
  // own CLI and the Workspace acting for them) may write it. Agents observing
  // it is harmless; an agent raising it would be a sandbox escape.
  "autonomy:read", "autonomy:write",
  // Routing policy is the user's standing routing preference — the Model
  // Control Center and the user's own CLI edit it; an agent rewriting the
  // router that governs agents would be self-authorization.
  "routing-policy:read", "routing-policy:write",
  // Graphify is likewise the human's dial: opting a repo into a code-indexing
  // service (and the install that comes with it) is consent only the
  // operator's own CLI may express.
  "graphify:write",
  // The one sanctioned token issuance outside the daemon's own spawn path:
  // the launcher mints the Codex root's capability (SPEC decision 4's "no
  // delegation" rule carves out exactly this exchange).
  "root-token:mint",
];

// The orchestrator decides what work happens; the writer puts code on main.
// Neither role is a superset of the other, so a stolen credential of either
// kind buys a strict subset of the control plane.
export const ROLE_GRANTS: Readonly<Record<Role, RoleGrant>> = {
  // The operator is the human's own CLI and the root of the local trust chain.
  // Its subject scope is unrestricted because narrowing it would buy nothing:
  // a caller that can already spawn and kill any agent gains no new authority
  // from also being able to name one.
  operator: {
    actions: OPERATOR_ACTIONS,
    anySubject: OPERATOR_ACTIONS,
    oneShot: [],
  },
  orchestrator: {
    actions: [
      "status:read", "quota:read", "quota:write", "token-usage:read",
      "agent:spawn", "agent:kill",
      "agent:mark-dead", "agent:recover", "approval:read", "approval:decide",
      "message:send", "message:ack", "message:read", "inbox:read",
      "memory:read", "memory:write", "event:report", "telemetry:report",
      "autonomy:read",
    ],
    anySubject: AGENT_DIRECTED,
    oneShot: [],
  },
  writer: {
    actions: [
      "status:read", "quota:read", "message:send", "message:ack", "inbox:read",
      "branch:land", "memory:read", "memory:write", "event:report",
      "telemetry:report",
    ],
    anySubject: [],
    oneShot: ["branch:land"],
  },
  reader: {
    actions: [
      "status:read", "quota:read", "message:send", "message:ack", "inbox:read",
      "memory:read", "event:report", "telemetry:report",
    ],
    anySubject: [],
    oneShot: [],
  },
};

// Epoch checks exist to stop stale authority, so only the actions that commit
// carry one: merging a branch, and confirming a control instruction landed.
// Gating reads on the epoch would fail every status poll during a rotation and
// buy nothing.
const EPOCH_CHECKED: ReadonlySet<Action> = new Set<Action>([
  "branch:land",
  "message:ack",
]);

/** Actions a `writeRevoked` agent may not perform even at a current epoch. */
const WRITE_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "branch:land",
  "memory:write",
]);

export interface Capability {
  readonly id: string;
  readonly subject: string;
  readonly role: Role;
  readonly epoch: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

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

export type Decision = { readonly ok: true; readonly capability: Capability } | Denial;

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

/** `hv1.<capabilityId>.<secret>` — the id is a lookup key, not a secret. */
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
  /** The subject the caller named in its request body, if the route names one. */
  readonly subject?: string | undefined;
  readonly route: string;
}

/** Reads the live epoch/revocation state of an agent, or null when the subject
 * is not a spawned agent (the operator and the orchestrator have no row). */
export type AgentAuthorityLookup = (
  name: string,
) => { capabilityEpoch: number; writeRevoked: boolean } | null;

export class CapabilityStore {
  constructor(
    private readonly db: HiveDatabase,
    private readonly agentAuthority: AgentAuthorityLookup,
    private readonly now: () => Date = () => new Date(),
  ) {}

  mint(
    subject: string,
    role: Role,
    options: { epoch?: number; ttlMs?: number } = {},
  ): { token: string; capability: Capability } {
    const issued = this.now();
    const id = crypto.randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const capability: Capability = {
      id,
      subject,
      role,
      epoch: options.epoch ?? 0,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(
        issued.getTime() + (options.ttlMs ?? DEFAULT_TTL_MS),
      ).toISOString(),
      revokedAt: null,
    };
    this.db.insertCapability(capability, hashSecret(secret));
    return { token: `${TOKEN_PREFIX}.${id}.${secret}`, capability };
  }

  /** Resolves a bearer token to exactly one capability. Authentication only:
   * it says who is speaking, never what they may do. */
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
      // An id that exists with a wrong secret is indistinguishable, to the
      // caller, from an id that never existed.
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

  /** Authorization only: may this capability do this, to this subject, now? */
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
    if (
      subject !== undefined && subject !== capability.subject &&
      !grant.anySubject.includes(request.action)
    ) {
      return deny(
        "capability.foreign-subject",
        403,
        `${capability.subject} may not ${request.action} on ${subject}`,
      );
    }

    // The epoch and the write revocation belong to the *named* agent, which for
    // a self-bound action is the caller and for an operator is someone else.
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
      EPOCH_CHECKED.has(request.action) && authority !== null &&
      capability.role !== "operator" && authority.capabilityEpoch !== capability.epoch
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

  /** Spends a one-shot right up front, so two concurrent lands cannot both
   * merge. Returns false when the right was already spent — that is a replay.
   * A caller that then fails must `releaseOneShot`, because a fast-forward
   * merge legitimately loses to a moving `main` and has to stay retryable. */
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

  /** Re-arms a spent one-shot for a subject by explicit approval (the
   * land-grant re-arm flow): deleting the consumption row grants exactly one
   * more spend, and approving the same request twice finds nothing left to
   * delete. Returns how many rows were released. */
  rearmOneShot(subject: string, action: Action): number {
    return this.db.releaseOneShotForSubject(subject, action);
  }

  /** Revocation by subject. Advancing an agent's epoch kills its epoch-checked
   * rights; this kills the credential outright, for kill and mark-dead. */
  revokeSubject(subject: string): number {
    return this.db.revokeCapabilitiesForSubject(
      subject,
      this.now().toISOString(),
    );
  }

  audit(entry: Omit<AuditEntry, "at">): void {
    this.db.insertAuditEntry({ ...entry, at: this.now().toISOString() });
  }

  /** Authentication happens before a request body is parsed, so a caller with
   * no credential is denied without the daemon ever reading what it asked for. */
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

  /** Denials are always audited; allows only for the routes that mutate, so
   * status polls cannot drown the rows that matter. */
  authorizeAndAudit(
    capability: Capability,
    request: AuthorizeRequest,
    auditAllow: boolean,
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
      this.audit({ ...shared, decision: "allow", reason: null });
    }
    return decision;
  }
}
