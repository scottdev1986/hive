// The daemon's durable warning sink (defect D2). Daemon warnings and
// lifecycle lines go to console.log/console.error — but the deployed daemon
// is a detached compiled binary whose stdout has no reader and no file
// anywhere under ~/.hive captures it. A loud warning with no readable sink
// is not loud. This appends the lines that matter — startup config (memory
// retention, wake deltas, embedding state), embedding load transitions,
// sweep reports, trigger/delta failures — to $HIVE_HOME/logs/daemon.log,
// one ISO-timestamped line per entry.
//
// Deliberately tiny (no deps, sync fs): this is a warning sink, not a
// logging framework, and it is NOT full stdout capture. Rotation is a
// single size cap with one .1 rollover so the file can never grow without
// bound. The sink NEVER throws: an unwritable log dir must not break the
// daemon it is observing.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHiveHome } from "./db";

/** Daemon log size cap: past it, the current file rolls to daemon.log.1
 * (clobbering any previous rollover) and a fresh file starts. */
export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function daemonLogPath(home: string = getHiveHome()): string {
  return join(home, "logs", "daemon.log");
}

export class DaemonLog {
  constructor(
    private readonly path: string = daemonLogPath(),
    private readonly maxBytes: number = DAEMON_LOG_MAX_BYTES,
  ) {}

  /** Append one timestamped line. Never throws — a broken sink is reported
   * nowhere and breaks nothing. */
  write(line: string): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const stamped = `${new Date().toISOString()} ${line}\n`;
      let size = 0;
      try {
        size = statSync(this.path).size;
      } catch {
        // No file yet — it starts at zero.
      }
      if (size > 0 && size + Buffer.byteLength(stamped) > this.maxBytes) {
        renameSync(this.path, `${this.path}.1`);
      }
      appendFileSync(this.path, stamped);
    } catch {
      // The log sink never breaks the daemon.
    }
  }
}
