// The daemon's durable warning sink: $HIVE_HOME/logs/daemon.log, one ISO-timestamped line per entry. Two modes, one contract — a report lands on the console once and in the file once: deployed — lifecycle/daemon-lifecycle.ts spawns the detached daemon with its stderr fd opened onto this very file, so the console leg already IS the file leg; appending too would write every line twice (and did, before report() owned both legs). embedded — tests and tooling run the daemon in-process with no redirect, so the file needs its own append or the line never persists. report() tells the modes apart by comparing stderr's inode against the log file's, so no wiring has to tell it which world it is in. write() remains the file-only leg for callers that deliberately keep the console out of it. Deliberately tiny (no deps, sync fs): this is a warning sink, not a logging framework, and it is NOT full stdout capture. Rotation is a single size cap with one .1 rollover so the file can never grow without bound. The sink NEVER throws: an unwritable log dir must not break the daemon it is observing.
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
