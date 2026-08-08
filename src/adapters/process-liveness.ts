// The one answer to "is this pid alive", shared by every lock and lease that reclaims on death. kill(pid, 0) distinguishes four truths, and each consumer picks its policy for the two ambiguous ones at the call site: live — the process exists and this uid may signal it other-uid — the process exists but belongs to another uid (EPERM); it may be a live foreign owner, or a stale lock whose pid was reused dead — no such process (ESRCH); reclamation is provably safe unknown — the probe itself failed; nothing is proved This lives in adapters (not daemon) so both the daemon's leases and the adapters' file lock can share it without a new cross-layer edge.

export type ProcessLiveness = "live" | "other-uid" | "dead" | "unknown";

export function probeProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    // An out-of-range pid never reaches the syscall: no process can hold it, so a lock naming one is as provably orphaned as an ESRCH owner's.
    if (code === "ERR_INVALID_ARG_TYPE") return "dead";
    if (code === "EPERM") return "other-uid";
    return "unknown";
  }
}
