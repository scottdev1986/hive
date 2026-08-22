export type ProcessLiveness = "live" | "other-uid" | "dead" | "unknown";

export function probeProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    // SAFETY: The surrounding code already established this contract.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    // An out-of-range pid never reaches the syscall: no process can hold it, so a lock naming one is as provably orphaned as an ESRCH owner's.
    if (code === "ERR_INVALID_ARG_TYPE") return "dead";
    if (code === "EPERM") return "other-uid";
    return "unknown";
  }
}
