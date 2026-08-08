import { spawn } from "node:child_process";
import { terminateProcessGroup } from "../../src/adapters/providers/protocol/process-group";

interface TestChildRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface TestChild {
  readonly pid: number;
  readonly stdout: NodeJS.ReadableStream;
  shutdown(graceMs?: number): Promise<void>;
}

/** Starts an isolated process tree that integration tests can reliably reap. */
export function spawnTestChild(request: TestChildRequest): TestChild {
  const child = spawn(request.executable, [...request.argv], {
    cwd: request.cwd,
    env: { ...request.env },
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  const { pid, stdout } = child;
  if (pid === undefined || stdout === null) {
    throw new Error(`could not spawn ${request.executable}`);
  }

  return {
    pid,
    stdout,
    async shutdown(graceMs = 2000): Promise<void> {
      await terminateProcessGroup(pid, graceMs);
    },
  };
}
