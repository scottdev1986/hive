import type {
  Completeness,
  ProcessIdentity,
  Sequence,
  SessionInspection,
  SessionRef,
  TerminationResult,
} from "../../src/daemon/session-host/terminal-host-contract";
import type {
  ActiveVisibilityLease,
  VisibilityAdmissionHost,
  VisibilityCreateRequest,
  VisibilityCreateResult,
  VisibilityLease,
  VisibilityRejected,
  VisibilityRenewalRequest,
  VisibilityRenewalResult,
  VisibilityRequest,
  VisibilitySourceIdentity,
  VisibilityUnknown,
} from "../../src/daemon/session-host/terminal-host-visibility-contract";
import { NeutralTerminalHostFixture } from "./neutral-fixture";

export const NEUTRAL_VISIBILITY_FIXTURE_VERSION = "1.0.0" as const;
export const VISIBILITY_LEASE_MILLISECONDS = 15_000;

export type VisibilityFreezeFault =
  | "accept-invalid-revision"
  | "accept-stale-revision"
  | "ignore-source-identity"
  | "renew-absent-session"
  | "never-expire"
  | "claim-incomplete-evidence"
  | "allow-duplicate-owner"
  | "ignore-session-generation"
  | "abort-sweep-on-teardown-failure"
  | "do-not-cache-create-rejection";

type Snapshot = {
  source: VisibilitySourceIdentity;
  revision: bigint;
  revisionText: Sequence;
  representedSessionKeys: Set<string>;
  completeness: Completeness;
  live: boolean;
};

type Validated = Readonly<{ state: "valid"; snapshot: Snapshot }>;
type Validation = Validated | VisibilityRejected | VisibilityUnknown;

const START_TIME = Date.parse("2026-07-18T12:00:00.000Z");

function leaseKey(session: SessionRef): string {
  return `${session.key}\0${session.incarnation}`;
}

function sameProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.processId === right.processId && left.startToken === right.startToken;
}

function parsePositiveRevision(value: Sequence): bigint | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed;
}

export class NeutralVisibilityHostFixture implements VisibilityAdmissionHost {
  readonly version = NEUTRAL_VISIBILITY_FIXTURE_VERSION;
  readonly terminal = new NeutralTerminalHostFixture();
  private readonly fault: VisibilityFreezeFault | null;
  private nowMilliseconds = START_TIME;
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly owners = new Map<string, string>();
  private readonly leases = new Map<string, ActiveVisibilityLease>();
  private readonly leaseStates = new Map<string, VisibilityLease>();
  private readonly createResults = new Map<string, VisibilityCreateResult>();
  private readonly expiryResults = new Map<string, TerminationResult>();

  constructor(fault: VisibilityFreezeFault | null = null) {
    this.fault = fault;
  }

  publishSnapshot(request: Readonly<{
    source: VisibilitySourceIdentity;
    inventoryRevision: Sequence;
    representedSessionKeys: readonly string[];
    completeness?: Completeness;
  }>): void {
    const revision = parsePositiveRevision(request.inventoryRevision);
    if (revision === null) throw new Error("fixture snapshots require a positive revision");
    const prior = this.snapshots.get(request.source.sessionId);
    if (prior && revision < prior.revision) throw new Error("fixture snapshots cannot move backwards");
    this.snapshots.set(request.source.sessionId, {
      source: request.source,
      revision,
      revisionText: request.inventoryRevision,
      representedSessionKeys: new Set(request.representedSessionKeys),
      completeness: request.completeness ?? "complete",
      live: prior?.live ?? true,
    });
  }

  setSourceLive(sessionId: string, live: boolean): void {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) throw new Error("visibility source is not published");
    snapshot.live = live;
  }

  async create(request: VisibilityCreateRequest): Promise<VisibilityCreateResult> {
    const idempotency = `${request.terminal.key}\0${request.terminal.idempotencyKey}`;
    const prior = this.createResults.get(idempotency);
    if (prior) {
      if (prior.state !== "created") return prior;
      const lease = this.leaseStates.get(leaseKey(prior.result.session));
      return lease ? { ...prior, lease } : prior;
    }

    const validation = this.validate(
      request.terminal.key,
      request.visibility,
      "create",
    );
    if (validation.state !== "valid") {
      const result: VisibilityCreateResult = {
        ...validation,
        createInvoked: false,
        session: null,
        lease: null,
      };
      if (this.fault !== "do-not-cache-create-rejection") {
        this.createResults.set(idempotency, result);
      }
      return result;
    }

    if (this.owners.has(request.terminal.key) &&
        this.fault !== "allow-duplicate-owner") {
      const result = this.createFailure(this.rejected(
        "duplicate-session-owner",
        validation.snapshot.revisionText,
        "session key already has a leased or unreconciled generation",
      ));
      this.createResults.set(idempotency, result);
      return result;
    }

    const created = await this.terminal.create(request.terminal);
    const lease = this.issueLease(created.session, request.visibility);
    this.owners.set(request.terminal.key, request.visibility.source.sessionId);
    this.leases.set(leaseKey(created.session), lease);
    this.leaseStates.set(leaseKey(created.session), lease);
    const result: VisibilityCreateResult = { state: "created", result: created, lease };
    this.createResults.set(idempotency, result);
    return result;
  }

  async renewVisibility(request: VisibilityRenewalRequest): Promise<VisibilityRenewalResult> {
    let lease = this.leases.get(leaseKey(request.session));
    if (!lease && this.fault === "ignore-session-generation") {
      lease = [...this.leases.values()].find((candidate) => candidate.session.key === request.session.key);
    }
    if (!lease) {
      const hasOtherGeneration = [...this.leases.values()]
        .some((candidate) => candidate.session.key === request.session.key);
      return this.renewalFailure(this.rejected(
        hasOtherGeneration ? "session-generation-mismatch" : "lease-expired",
        null,
        hasOtherGeneration ? "visibility lease names another generation" : "visibility lease is absent",
      ));
    }
    if (this.nowMilliseconds >= Date.parse(lease.expiresAt)) {
      await this.expireLease(lease);
      return this.renewalFailure(this.rejected(
        "lease-expired",
        lease.acceptedRevision,
        "visibility lease expired before renewal",
      ));
    }
    if (request.visibility.source.sessionId !== lease.source.sessionId ||
        !sameProcess(request.visibility.source.process, lease.source.process)) {
      return this.renewalFailure(this.rejected(
        "source-identity-mismatch",
        lease.acceptedRevision,
        "renewal source does not match the lease source",
      ));
    }

    const validation = this.validate(lease.session.key, request.visibility, "renew");
    if (validation.state !== "valid") return this.renewalFailure(validation);
    const accepted = parsePositiveRevision(request.visibility.inventoryRevision);
    const prior = parsePositiveRevision(lease.acceptedRevision);
    if (accepted === null || prior === null || accepted < prior) {
      return this.renewalFailure(this.rejected(
        "stale-revision",
        lease.acceptedRevision,
        "renewal revision predates the active lease",
      ));
    }

    const renewed = this.issueLease(lease.session, request.visibility);
    this.leases.set(leaseKey(lease.session), renewed);
    this.leaseStates.set(leaseKey(lease.session), renewed);
    return { state: "active", lease: renewed };
  }

  async advance(milliseconds: number): Promise<void> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("fixture clock advances must be nonnegative integers");
    }
    this.nowMilliseconds += milliseconds;
    if (this.fault === "never-expire") return;
    for (const lease of [...this.leases.values()]) {
      if (this.nowMilliseconds >= Date.parse(lease.expiresAt)) await this.expireLease(lease);
    }
  }

  currentLease(session: SessionRef): VisibilityLease | null {
    return this.leaseStates.get(leaseKey(session)) ?? null;
  }

  expiryResult(session: SessionRef): TerminationResult | null {
    return this.expiryResults.get(leaseKey(session)) ?? null;
  }

  inspect(session: SessionRef): Promise<SessionInspection> {
    return this.terminal.inspect(session);
  }

  list(): Promise<readonly SessionInspection[]> {
    return this.terminal.list();
  }

  private validate(
    sessionKey: string,
    request: VisibilityRequest,
    phase: "create" | "renew",
  ): Validation {
    const requestedRevision = parsePositiveRevision(request.inventoryRevision);
    const snapshot = this.snapshots.get(request.source.sessionId);
    const currentRevision = snapshot?.revisionText ?? null;
    const acceptsInvalid = this.fault === "accept-invalid-revision";
    if (requestedRevision === null && !acceptsInvalid) {
      return this.rejected(
        "invalid-revision",
        currentRevision,
        "inventory revision must be a positive integer",
      );
    }
    if (!snapshot) {
      return this.rejected("source-not-live", null, "visibility source is not authenticated");
    }

    const exactProcess = sameProcess(snapshot.source.process, request.source.process);
    if ((!exactProcess || !snapshot.live) && this.fault !== "ignore-source-identity") {
      return this.rejected(
        exactProcess ? "source-not-live" : "source-identity-mismatch",
        snapshot.revisionText,
        exactProcess ? "visibility source is no longer live" : "PID start token does not match",
      );
    }
    if (snapshot.completeness !== "complete") {
      if (this.fault === "claim-incomplete-evidence") {
        return this.rejected(
          "session-not-represented",
          snapshot.revisionText,
          "incomplete evidence was incorrectly treated as absence",
        );
      }
      return this.unknown(
        snapshot.completeness,
        snapshot.revisionText,
        "current representation inventory is incomplete",
      );
    }

    const bypassRevision = this.fault === "accept-stale-revision" ||
      (acceptsInvalid && requestedRevision === null);
    if (!bypassRevision && requestedRevision !== snapshot.revision) {
      return this.rejected(
        requestedRevision !== null && requestedRevision < snapshot.revision
          ? "stale-revision"
          : "unverified-revision",
        snapshot.revisionText,
        "request does not name the current inventory revision",
      );
    }
    if (!snapshot.representedSessionKeys.has(sessionKey) &&
        !(phase === "renew" && this.fault === "renew-absent-session")) {
      return this.rejected(
        "session-not-represented",
        snapshot.revisionText,
        "current inventory does not contain the exact session key",
      );
    }
    return { state: "valid", snapshot };
  }

  private issueLease(session: SessionRef, request: VisibilityRequest): ActiveVisibilityLease {
    return {
      session,
      source: request.source,
      acceptedRevision: request.inventoryRevision,
      state: "active",
      issuedAt: new Date(this.nowMilliseconds).toISOString(),
      expiresAt: new Date(this.nowMilliseconds + VISIBILITY_LEASE_MILLISECONDS).toISOString(),
    };
  }

  private async expireLease(lease: ActiveVisibilityLease): Promise<void> {
    const key = leaseKey(lease.session);
    if (!this.leases.has(key)) return;
    let result: TerminationResult;
    try {
      result = await this.terminal.terminate({
        session: lease.session,
        mode: "immediate",
        target: "process-tree",
        deadline: new Date(this.nowMilliseconds).toISOString(),
        idempotencyKey: `visibility-expiry-${lease.session.incarnation}`,
      });
    } catch (error) {
      if (this.fault === "abort-sweep-on-teardown-failure") throw error;
      result = {
        state: "unknown",
        exit: null,
        reap: {
          authority: "unavailable",
          reaped: false,
          status: null,
          completeness: "unknown",
        },
        survivors: [],
        completeness: "unknown",
        diagnostics: [
          `visibility expiry teardown failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    this.expiryResults.set(key, result);
    this.leases.delete(key);
    this.leaseStates.set(key, {
      ...lease,
      state: "expired",
      expiredAt: new Date(this.nowMilliseconds).toISOString(),
      teardown: result,
    });
    const verifiedAbsent = result.state === "terminated" &&
      result.completeness === "complete" &&
      result.survivors.length === 0 &&
      result.reap.reaped &&
      result.reap.completeness === "complete";
    if (verifiedAbsent && this.owners.get(lease.session.key) === lease.source.sessionId) {
      this.owners.delete(lease.session.key);
    }
  }

  private createFailure(
    failure: VisibilityRejected | VisibilityUnknown,
  ): VisibilityCreateResult {
    return { ...failure, createInvoked: false, session: null, lease: null };
  }

  private renewalFailure(
    failure: VisibilityRejected | VisibilityUnknown,
  ): VisibilityRenewalResult {
    return { ...failure, renewed: false };
  }

  private rejected(
    reason: VisibilityRejected["reason"],
    currentRevision: Sequence | null,
    diagnostic: string,
  ): VisibilityRejected {
    return { state: "rejected", reason, completeness: "complete", currentRevision, diagnostic };
  }

  private unknown(
    completeness: Exclude<Completeness, "complete">,
    currentRevision: Sequence | null,
    diagnostic: string,
  ): VisibilityUnknown {
    return { state: "unknown", completeness, currentRevision, diagnostic };
  }
}
