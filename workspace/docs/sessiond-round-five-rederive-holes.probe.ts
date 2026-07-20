/**
 * henrietta round-five independent re-derivation of horace's holes 3 and 5,
 * against the REAL kernel gate (default proveReady = connect + LOCAL_PEERPID +
 * HELLO). Deliberately does NOT use helga's proveReady stub.
 *
 * Hole 3: a process that merely OPENS broker.lock (no flock) was counted as the
 *         lock holder by `lsof -t`.
 * Hole 4: macOS lsof lock field is EMPTY even under real LOCK_EX.
 * Hole 5: a stale broker.lock stamp whose pid RECYCLES to match the spawned
 *         child, plus a losing child that announces before dying, resolved
 *         start() with NO flock existing at all.
 *
 * Composite adversarial setup: a foreign process binds broker.sock, and the
 * lock file is staged in the strongest form for each variant, with the stamp
 * pid made EQUAL to the spawned child's pid (the recycled-match).
 * Expected under the redesign: every variant REJECTS, because the ready path
 * consults neither the lock nor the stamp — only the kernel peer of broker.sock.
 */
import { createServer } from "node:net";
import { mkdirSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { SessiondBrokerSupervisor } from "/Users/scottkellar/Projects/hive/.hive/worktrees/henrietta/src/daemon/sessiond-broker";

// Darwin sys/file.h
const LOCK_EX = 2;
const LOCK_NB = 4;
let flockHandle: ReturnType<typeof dlopen> | null = null;
function flockLibc() {
  flockHandle ??= dlopen("libc.dylib", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  return flockHandle;
}

// A pid that is alive and is NOT the socket's peer: use a real child we control.
function makeChild(pid: number, exitAfterMs: number, exitCode: number) {
  let code: number | null = null;
  const exited = new Promise<number>((resolve) => {
    setTimeout(() => {
      code = exitCode;
      resolve(exitCode);
    }, exitAfterMs).unref?.();
  });
  return {
    pid,
    get exitCode() {
      return code;
    },
    exited,
    kill() {
      code = exitCode;
    },
  };
}

type Variant = {
  name: string;
  hole: string;
  // how broker.lock is staged
  lockMode: "absent" | "open-no-flock" | "real-LOCK_EX";
  // stamp written into broker.lock
  stampMatchesChild: boolean;
  // when true, the child pid IS the socket's binder: peer gate must PASS
  positiveControl?: boolean;
};

const VARIANTS: Variant[] = [
  {
    name: "opener-without-flock + stamp matching child pid",
    hole: "3 (+5 stamp)",
    lockMode: "open-no-flock",
    stampMatchesChild: true,
  },
  {
    name: "real LOCK_EX holder + stamp matching child pid",
    hole: "3/4 (+5 stamp)",
    lockMode: "real-LOCK_EX",
    stampMatchesChild: true,
  },
  {
    name: "NO lock exists at all + stale stamp matching child pid",
    hole: "5 (exact: start resolved with no flock existing)",
    lockMode: "absent",
    stampMatchesChild: true,
  },
  {
    name: "POSITIVE CONTROL — child pid IS the socket binder",
    hole: "none: proves the probe can get PAST the peer gate",
    lockMode: "absent",
    stampMatchesChild: false,
    positiveControl: true,
  },
];

let failures = 0;

for (const v of VARIANTS) {
  const home = mkdtempSync(join(tmpdir(), "hen-rederive-"));
  const socketDir = join(home, "runtime", "sessiond");
  mkdirSync(socketDir, { recursive: true });
  const sockPath = join(socketDir, "broker.sock");
  const lockPath = join(socketDir, "broker.lock");

  // Foreign process binds broker.sock. Here the binder is THIS process, so the
  // kernel peer will be process.pid — deliberately not the child pid.
  const server = createServer(() => {
    /* accept and hold: a foreign "broker" that would answer HELLO */
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => resolve());
  });

  // The spawned child pid: chosen so the stamp "recycles" to match it exactly.
  // POSITIVE CONTROL: child pid == the socket's real binder (this process), so
  // the peer-pid gate MUST pass and the rejection must come LATER, at HELLO.
  // If this variant rejects with a peer-pid message, the probe is broken and
  // every "hole dead" result above is unattributable.
  const childPid = v.positiveControl ? process.pid : process.pid + 4242;

  let lockFd: number | null = null;
  if (v.lockMode !== "absent") {
    writeFileSync(lockPath, `${v.stampMatchesChild ? childPid : 999999}\n`);
    lockFd = openSync(lockPath, "r+");
    if (v.lockMode === "real-LOCK_EX") {
      // Real advisory exclusive lock held by THIS process (not the child),
      // taken through libc flock(2) — the same class of lock the broker takes.
      const rc = flockLibc().symbols.flock(lockFd, LOCK_EX | LOCK_NB);
      if (rc !== 0) {
        throw new Error(`probe setup failed: flock(LOCK_EX) returned ${rc}`);
      }
      console.log(`    [setup] real LOCK_EX held by pid ${process.pid} on broker.lock`);
    }
  } else if (v.stampMatchesChild) {
    // Hole 5's exact shape: stamp present, NO lock ever taken.
    writeFileSync(lockPath, `${childPid}\n`);
  }

  const supervisor = new SessiondBrokerSupervisor({
    binary: "/tmp/fake-sessiond",
    hiveHome: home,
    readyTimeoutMs: 1_500,
    // REAL proveReady: no seam, no stub. This is the whole point.
    // Control child stays alive so its rejection can only come from the gate,
    // never from an exit race.
    spawn: () => makeChild(childPid, v.positiveControl ? 60_000 : 900, 1) as never,
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  });

  let outcome: string;
  try {
    await supervisor.start();
    outcome = "RESOLVED (ready granted)";
  } catch (error) {
    outcome = `rejected: ${error instanceof Error ? error.message : String(error)}`;
  }

  const resolved = outcome.startsWith("RESOLVED");
  const mentionsPeerGate = /kernel peer pid|not the owned child/.test(outcome);

  let verdict: string;
  if (v.positiveControl) {
    // Must get PAST the peer gate: rejection may not be a peer-pid mismatch.
    if (mentionsPeerGate) {
      verdict = "*** PROBE BROKEN — control failed AT the peer gate ***";
      failures += 1;
    } else {
      verdict = "control OK (peer gate passed; failed later, as designed)";
    }
  } else if (resolved) {
    verdict = "*** HOLE ALIVE ***";
    failures += 1;
  } else {
    verdict = "hole dead (start refused)";
  }

  console.log(`\nvariant: ${v.name}`);
  console.log(`  hole:     ${v.hole}`);
  console.log(`  lockMode: ${v.lockMode}, stamp==childPid: ${v.stampMatchesChild}`);
  console.log(`  childPid: ${childPid}, socket peer (this process): ${process.pid}`);
  console.log(`  status:   ${supervisor.status}`);
  console.log(`  outcome:  ${outcome}`);
  console.log(`  VERDICT:  ${verdict}`);

  if (lockFd !== null) closeSync(lockFd);
  await new Promise<void>((r) => server.close(() => r()));
}

console.log(`\n=== re-derivation complete: ${failures} hole(s) alive ===`);
process.exit(failures === 0 ? 0 : 1);
