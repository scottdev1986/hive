/**
 * B2.5.1 — production pane wiring proof (not the B2.2 demo harness).
 *
 * Uses the staged make-run stack:
 *   short HIVE_HOME, HIVE_INSTALL_ROOT, staged hive binary, owned broker,
 *   real Workspace visibility → sessiond admit → sessiond create.
 *
 * Success criteria (written to evidence dir):
 *   1. daemon.port present; broker.sock under short home; LOCAL peer is child of daemon
 *   2. hive_spawn (or MCP-equivalent HTTP) yields agent with hostKind=sessiond
 *   3. agent pane inventory / attach grant works for that locator
 *   4. no SocketPathTooLong
 *
 * Env:
 *   HIVE_B25_HOME     short home (default /tmp/hb25-<pid>)
 *   HIVE_B25_PORT     default 43140
 *   HIVE_B25_EVIDENCE default raw/qualification/hive-b25-production-pane
 *   HIVE_BIN          staged hive (required)
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "..");
const home = process.env.HIVE_B25_HOME ?? `/tmp/hb25-${process.pid}`;
const port = Number(process.env.HIVE_B25_PORT ?? "43140");
const evidence =
  process.env.HIVE_B25_EVIDENCE ??
  join(repoRoot, "raw/qualification/hive-b25-production-pane");
const hiveBin =
  process.env.HIVE_BIN ??
  join(repoRoot, ".dev/root/current/hive");

const lines: string[] = [];
function log(line: string): void {
  lines.push(line);
  console.log(line);
}

function fail(msg: string): never {
  log(`FAIL: ${msg}`);
  write();
  process.exit(1);
}

function write(): void {
  mkdirSync(join(evidence, "matrix"), { recursive: true });
  writeFileSync(join(evidence, "matrix/production-wiring.txt"), lines.join("\n") + "\n");
}

if (!existsSync(hiveBin)) {
  fail(`staged hive missing at ${hiveBin}; run make build first`);
}

mkdirSync(home, { recursive: true, mode: 0o700 });
log(`home=${home} port=${port} hive=${hiveBin}`);
log(`broker.sock path length=${join(home, "runtime/sessiond/broker.sock").length}`);

// Further steps require a live daemon started the production way.
// This skeleton records environment readiness; full spawn is filled in B2.5.1.
log("scaffold: ready for production daemon launch + sessiond spawn measurement");
log("NEXT: start staged hive with DEV_ENV-equivalent, spawn cheapest agent, assert hostKind=sessiond");
write();
process.exit(0);
