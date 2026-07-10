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
 */
export const WORKSPACE_PRESENCE_TTL_MS = 15_000;

export class WorkspacePresence {
  private expiresAt = 0;

  constructor(
    private readonly now: () => number = Date.now,
    readonly ttlMs: number = WORKSPACE_PRESENCE_TTL_MS,
  ) {}

  /** Renew the lease. Called on registration and on every feed heartbeat. */
  markPresent(): void {
    this.expiresAt = this.now() + this.ttlMs;
  }

  /** Surrender the lease immediately (clean app shutdown). */
  clear(): void {
    this.expiresAt = 0;
  }

  isPresent(): boolean {
    return this.now() < this.expiresAt;
  }
}
