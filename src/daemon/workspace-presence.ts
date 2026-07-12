/**
 * Workspace presence — "the app is the viewer right now".
 *
 * While the Hive Workspace app is attached, its panes *are* the terminals, so
 * the daemon must not open external Terminal.app/iTerm2 viewer windows or move
 * the window wall around; doing both at once was exactly the double-viewer mess
 * the field test surfaced. Presence is deliberately a lease, not a flag: the
 * feed process heartbeats it (`POST /workspace`), and a crashed or force-quit
 * app simply stops renewing, so the daemon reverts to external viewers on its
 * own instead of staying headless forever. The static `headless` config keeps
 * its meaning — "never open windows" — untouched; presence is the dynamic
 * counterpart that only holds while someone is provably watching.
 *
 * The lease is held per *owner* — one owner per feed process — because it used
 * to be a single global expiry that anyone could surrender. A second workspace
 * (an agent verifying UI work against the live daemon) shutting down cleanly
 * would call clear() and blind the daemon to the user's real, still-attached,
 * still-heartbeating app; the daemon then opened a Terminal.app window over
 * live panes. One app's exit is that app's event, not the state of every other
 * app, so an owner may only surrender its own lease. Presence is the union: it
 * holds while ANY owner's lease is unexpired, and lapses only when the last one
 * does — so a genuinely crashed or force-quit workspace still hands the
 * external viewers back.
 */
export const WORKSPACE_PRESENCE_TTL_MS = 15_000;

/** The owner recorded for a feed that predates owner identity: they all share
 * one lease, which is exactly the old behaviour and no worse. */
export const LEGACY_PRESENCE_OWNER = "legacy";

export class WorkspacePresence {
  /** owner -> when that owner's lease expires. */
  private readonly leases = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    readonly ttlMs: number = WORKSPACE_PRESENCE_TTL_MS,
  ) {}

  /** Renew one owner's lease. Called on registration and on every heartbeat. */
  markPresent(owner: string = LEGACY_PRESENCE_OWNER): void {
    this.leases.set(owner, this.now() + this.ttlMs);
  }

  /** Surrender one owner's lease (clean app shutdown). Never anyone else's. */
  clear(owner: string = LEGACY_PRESENCE_OWNER): void {
    this.leases.delete(owner);
  }

  /** True while any owner still holds an unexpired lease. */
  isPresent(): boolean {
    const now = this.now();
    for (const [owner, expiresAt] of this.leases) {
      if (now < expiresAt) return true;
      this.leases.delete(owner);
    }
    return false;
  }
}
