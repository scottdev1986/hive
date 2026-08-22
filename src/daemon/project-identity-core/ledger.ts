export interface ManagedWorktree {
  /** Canonical path of the managed worker worktree. */
  canonicalPath: string;
  /** The Hive that owns it. A managed worktree routes here, not to its own Hive. */
  owningHiveUuid: string;
  /** The pane the worktree's agent is attached to. */
  paneId: string;
  agentName: string;
}

/** An unforgeable, connection-bound right to read the managed-worktree ledger. In the flagship this is an XPC capability; here it is an object identity that a caller cannot fabricate from data found on disk. */
export class LedgerCapability {
  private constructor(readonly subject: string) {}
  /** Only the Supervisor may mint one. */
  static issue(subject: string): LedgerCapability {
    return new LedgerCapability(subject);
  }
}

export class UnauthenticatedLedgerAccess extends Error {
  constructor() {
    super("managed-worktree ledger requires a Supervisor-issued capability");
    this.name = "UnauthenticatedLedgerAccess";
  }
}

export interface ManagedWorktreeLedger {
  lookup(
    canonicalPath: string,
    capability: LedgerCapability,
  ): ManagedWorktree | null;
}

export class InMemoryManagedWorktreeLedger implements ManagedWorktreeLedger {
  private readonly entries = new Map<string, ManagedWorktree>();

  /** Supervisor-side registration, e.g. when `hive_spawn` creates a worker worktree. */
  register(entry: ManagedWorktree): void {
    this.entries.set(entry.canonicalPath, entry);
  }

  unregister(canonicalPath: string): void {
    this.entries.delete(canonicalPath);
  }

  lookup(
    canonicalPath: string,
    capability: LedgerCapability,
  ): ManagedWorktree | null {
    if (!(capability instanceof LedgerCapability))
      throw new UnauthenticatedLedgerAccess();
    return this.entries.get(canonicalPath) ?? null;
  }
}
