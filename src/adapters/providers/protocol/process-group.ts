import { pollUntil } from "../../../shared/poll-until";

export function processGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {}
}

async function waitForProcessGroupGone(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  return pollUntil(() => !processGroupAlive(processGroupId), {
    intervalMs: 25,
    timeoutMs,
  });
}

export async function terminateProcessGroup(
  processGroupId: number,
  graceMs: number,
): Promise<void> {
  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupGone(processGroupId, graceMs)) return;
  signalProcessGroup(processGroupId, "SIGKILL");
  if (await waitForProcessGroupGone(processGroupId, graceMs)) return;
  throw new Error(`vendor process group ${processGroupId} survived SIGKILL`);
}
