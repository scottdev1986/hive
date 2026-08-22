import {
  appendFileSync,
  fstatSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getHiveHome } from "../../hive-home/home";

export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function daemonLogPath(home: string = getHiveHome()): string {
  return join(home, "logs", "daemon.log");
}

export class DaemonLog {
  constructor(
    private readonly path: string = daemonLogPath(),
    private readonly maxBytes: number = DAEMON_LOG_MAX_BYTES,
  ) {}

  /** Append one timestamped line. Never throws — a broken sink is reported nowhere and breaks nothing. */
  write(line: string): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const stamped = `${new Date().toISOString()} ${line}\n`;
      let size = 0;
      try {
        size = statSync(this.path).size;
      } catch {}
      if (size > 0 && size + Buffer.byteLength(stamped) > this.maxBytes) {
        renameSync(this.path, `${this.path}.1`);
      }
      appendFileSync(this.path, stamped);
    } catch {
      // The log sink never breaks the daemon.
    }
  }

  report(line: string): void {
    console.error(`${new Date().toISOString()} ${line}`);
    if (!this.stderrIsThisFile()) this.write(line);
  }

  private stderrIsThisFile(): boolean {
    try {
      const stderr = fstatSync(2);
      const target = statSync(this.path);
      return stderr.dev === target.dev && stderr.ino === target.ino;
    } catch {
      return false;
    }
  }
}

let sharedLog: DaemonLog | null = null;

function sharedDaemonLog(): DaemonLog {
  sharedLog ??= new DaemonLog();
  return sharedLog;
}

/** Resource and control alerts are the only way daemon degradation reaches the orchestrator; a failed alert send must not crash the sweep, but it must not vanish either. Built as a `.catch` handler: the failure is reported and the promise resolves `undefined`. */
export function logAlertDeliveryFailure<T>(error: T): undefined {
  sharedDaemonLog().report(
    `Hive failed to deliver a daemon alert to the orchestrator: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
  return undefined;
}
