/**
 * qa/verify-announcement.ts — assert the running QA daemon was started from
 * the exact sources under test.
 *
 *   bun run qa/verify-announcement.ts <daemon-log> <src-root> <daemon-pid>
 *
 * The daemon prints a startup announcement carrying the source hash it was
 * built/started from; this compares it against the hash of <src-root> right
 * now. A mismatch means the daemon is serving code other than the code the
 * QA run believes it is testing — the exact condition that made the
 * long-lived dev daemon 404 five of six wired screens — and must be a loud
 * failure, never a soft warning.
 */
import { observeAnnouncement } from "../../scripts/dev/verify-dev-run";
import { sourceBuildHash } from "../../src/daemon/lifecycle/daemon-lifecycle";

const [logPath, srcRoot, pidRaw] = process.argv.slice(2);
const daemonPid = Number(pidRaw);
if (
  logPath === undefined ||
  srcRoot === undefined ||
  !Number.isSafeInteger(daemonPid) ||
  daemonPid <= 0
) {
  console.error("usage: verify-announcement <daemon-log> <src-root> <daemon-pid>");
  process.exit(2);
}

const announcement = await observeAnnouncement(logPath, daemonPid);
const computed = await sourceBuildHash(srcRoot);
if (announcement.sourceHash !== computed) {
  console.error(
    `announced source ${announcement.sourceHash.slice(0, 8)} does not match ` +
      `${srcRoot} (${computed.slice(0, 8)}) — the daemon is not running the ` +
      "sources under test",
  );
  process.exit(1);
}
console.log(
  `source_hash announced=${announcement.sourceHash} computed=${computed}`,
);
console.log("daemon runs the sources under test");
