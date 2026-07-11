/**
 * `hive update` — check, stage, and (when the team is idle) activate.
 *
 * The command always performs the safe half immediately: check, download,
 * verify, stage. Then it tells the truth about activation. There is no `--now`
 * flag that forces activation over a live team; the daemon owns landing
 * authority and approvals, so "force" would mean killing agents mid-write. A
 * user who genuinely wants that has an honest spelling already: `hive stop &&
 * hive update`. Making destruction a deliberate two-command act rather than a
 * flag is the point.
 */
import { spawn } from "node:child_process";
import { cliPath, currentLink, detectInstallMethod, installRoot } from "../update/paths";
import {
  checkForUpdate,
  dismissVersion,
  fetchLatestFromGitHub,
  readUpdateCache,
  updatesDisabled,
} from "../update/check";
import { githubReleaseSource } from "../update/source";
import {
  UpdateError,
  activateWithHealthCheck,
  ensureBinLink,
  isStaged,
  readInstallState,
  rollback,
  stageRelease,
} from "../update/install";
import {
  explainRefusal,
  inspectDaemonForUpdate,
  restartStaleDaemon,
} from "../update/daemon";
import { startDownload } from "../update/progress";
import { yellow } from "../update/notice";
import { releaseKeys, selectArtifact, verifyManifest } from "../release/manifest";
import { expectedDaemonHandshake } from "../daemon/handshake";
import { isRunning } from "../daemon/lifecycle";
import { fetchAgentStatus } from "./mcp";
import {
  HIVE_ARCH,
  HIVE_COMMIT,
  HIVE_RELEASE_PUBLIC_KEY,
  HIVE_VERSION,
  IS_RELEASE_BUILD,
  versionLine,
} from "../version";
import type { HiveArch } from "../release/manifest";

const arch = (): HiveArch => (HIVE_ARCH === "arm64" ? "arm64" : "x64");

/** Live agents, read through the daemon's capability-checked status tool. */
export async function liveAgentNames(port: number): Promise<readonly string[]> {
  const agents = await fetchAgentStatus(port);
  return agents
    .filter((agent) => agent.status !== "dead" && agent.status !== "done")
    .map((agent) => agent.name);
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise(stdout) : reject(new Error(
        `${command} exited ${code}${stderr.trim() === "" ? "" : `: ${stderr.trim().slice(0, 500)}`}`,
      )));
  });
}

const probeVersion = (binary: string): Promise<string> => run(binary, ["--version"]);
const unpackApp = async (tarball: string, into: string): Promise<void> => {
  await run("tar", ["-xzf", tarball, "-C", into]);
};
const healthCheck = async (binary: string): Promise<boolean> =>
  probeVersion(binary).then((out) => out.includes("hive")).catch(() => false);

function guardSelfUpdate(): void {
  const disabled = updatesDisabled();
  if (disabled !== null) {
    throw new UpdateError(`Updates are disabled (${disabled}).`);
  }
  const method = detectInstallMethod(process.execPath);
  if (method === "source") {
    throw new UpdateError(
      "This is a source checkout, not an installed release. `hive update` only " +
        "updates an installed Hive; pull and rebuild instead.",
    );
  }
  if (method === "homebrew") {
    throw new UpdateError(
      "This Hive was installed by Homebrew, which owns the install. " +
        "Run `brew upgrade hive`.",
    );
  }
  if (method === "unmanaged") {
    throw new UpdateError(
      `This hive binary (${process.execPath}) was not installed by Hive's ` +
        "installer, so there is nothing safe to replace.",
    );
  }
}

/**
 * The trust posture, stated as a consequence rather than a fact about a
 * variable. "embedded" tells the reader nothing they can act on; "signatures are
 * required" tells them what this binary will and will not install.
 */
function describeKeys(): string {
  const keys = releaseKeys(HIVE_RELEASE_PUBLIC_KEY);
  if (keys.length === 0) {
    return "none — this build cannot verify a release signature";
  }
  const count = keys.length === 1 ? "1 key" : `${keys.length} keys`;
  return `embedded (${count}) — a valid signature is required to install`;
}

export async function printUpdateStatus(): Promise<void> {
  const root = installRoot();
  const state = readInstallState(root);
  const cache = readUpdateCache();
  const method = detectInstallMethod(process.execPath, root);
  const lines = [
    versionLine(),
    `commit:         ${HIVE_COMMIT}`,
    `install:        ${method}`,
    `release build:  ${IS_RELEASE_BUILD ? "yes" : "no (source checkout)"}`,
    `signature key:  ${describeKeys()}`,
    `active:         ${state.active ?? "unknown"}`,
    `retained:       ${state.previous ?? "none"}`,
    `last check:     ${cache === null ? "never" : new Date(cache.checkedAt).toISOString()}`,
    `latest seen:    ${cache?.latestVersion ?? "unknown"}`,
    `skipped:        ${cache?.dismissedVersion ?? "none"}`,
    `disabled by:    ${updatesDisabled() ?? "nothing"}`,
  ];
  console.log(lines.join("\n"));
}

/** Exit 0 up-to-date, 10 update available — the shape scripts want. */
export async function runUpdateCheck(): Promise<number> {
  const check = await checkForUpdate({
    fetchLatest: () => fetchLatestFromGitHub(),
    now: () => Date.now(),
    force: true,
  });
  switch (check.state) {
    case "update-available":
      console.log(`hive ${check.latest} available (you have ${check.current})`);
      return 10;
    case "up-to-date":
      console.log(`hive ${check.current} is the latest release`);
      return 0;
    case "unavailable":
      console.error(`could not check for updates: ${check.reason}`);
      return 1;
    case "dev-build":
      console.log(`hive ${check.current} (source checkout) — no update to check`);
      return 0;
    case "disabled":
      console.log(`update checks are disabled (${check.reason})`);
      return 0;
  }
}

export async function runUpdateSkip(): Promise<void> {
  const cache = readUpdateCache();
  if (cache === null) {
    console.error("Nothing to skip: no update has been offered yet.");
    return;
  }
  dismissVersion(cache.latestVersion);
  console.log(`Silenced notices for hive ${cache.latestVersion}.`);
}

export async function runRollback(): Promise<void> {
  guardSelfUpdate();
  const outcome = await rollback({ healthCheck });
  if (!outcome.activated) {
    throw new UpdateError(outcome.reason);
  }
  console.log(`hive ${outcome.version} active (rolled back).`);
  await stopStaleDaemonAfterActivation();
}

/**
 * After the symlink moves, the daemon is still executing the old image. The
 * handshake will refuse to reuse it, so the next `hive init` would fail rather
 * than adopt a stale control plane. Close the loop here: stop it while it is
 * provably idle so the next start spawns the new binary.
 */
async function stopStaleDaemonAfterActivation(): Promise<void> {
  if (!(await isRunning())) return;
  const expected = await expectedDaemonHandshake(process.cwd());
  const state = await inspectDaemonForUpdate({ expected, liveAgents: liveAgentNames });
  const refusal = explainRefusal(state);
  if (refusal !== null) {
    console.log(refusal);
    return;
  }
  if (state.state === "current" || state.state === "absent") return;

  const outcome = await restartStaleDaemon(state, { isRunning: () => isRunning() });
  console.log(
    outcome.stopped
      ? "Stopped the previous daemon; the next `hive init` runs the new build."
      : `Could not stop the previous daemon: ${outcome.reason}`,
  );
}

/**
 * What was actually checked, said plainly.
 *
 * "downloaded and verified" — the old line — names no check and so cannot be
 * wrong, which is exactly what is wrong with it. A user deciding whether to
 * trust a binary that is about to replace itself deserves the two facts that
 * decision rests on: the manifest carried a signature we could trace to the key
 * baked into this binary, and the bytes on disk hash to what that signed
 * manifest said they would.
 *
 * The unsigned branch gets the opposite treatment. It is not a footnote; it is
 * the single most important thing on the screen, because it means nothing proves
 * the release came from Hive at all.
 */
function verifiedLine(version: string, signed: boolean, sha256: string): string {
  const digest = sha256.slice(0, 12);
  return signed
    ? `hive ${version} staged — signature verified (Hive release key), sha256 ${digest} matched.`
    : `hive ${version} staged — sha256 ${digest} matched, but the release is UNSIGNED.`;
}

/** Loud, and on a line of its own. A `warning:` prefix on stderr is missable. */
function announceUnsigned(warning: string, isTTY: boolean): void {
  const body = `UNSIGNED RELEASE: ${warning}.`;
  console.error(isTTY ? yellow(body) : body);
}

export async function runUpdate(requested?: string): Promise<void> {
  guardSelfUpdate();
  const root = installRoot();
  const target = requested ?? "latest";

  // The safe half, always: fetch, verify, stage. Never blocked by a live team.
  const source = await githubReleaseSource(target);
  const version = source.manifest.version;

  if (version === HIVE_VERSION && requested === undefined) {
    console.log(`hive ${HIVE_VERSION} is the latest release.`);
    return;
  }

  // Verify the manifest *before* asking whether there is anything to download.
  //
  // Staging is where verification used to live, and staging is skipped when the
  // version is already on disk — so a version staged by an older, keyless build
  // (or left behind by a crashed run) could be activated by this one with no
  // signature check at any point. The trust gate cannot be something an earlier
  // crash gets to skip. The manifest bytes are already in hand, so checking here
  // costs nothing; `stageRelease` still checks again for callers that reach it
  // directly.
  const trust = verifyManifest(
    source.manifestBytes,
    source.signature,
    HIVE_RELEASE_PUBLIC_KEY,
  );
  if (!trust.verified) {
    throw new UpdateError(`Refusing update: ${trust.reason}`);
  }
  if (!trust.signed) {
    announceUnsigned(trust.warning, process.stderr.isTTY === true);
  }

  if (!isStaged(version, root)) {
    const staged = await stageRelease({
      manifest: source.manifest,
      manifestBytes: source.manifestBytes,
      signature: source.signature,
      arch: arch(),
      root,
      download: source.download,
      probeVersion,
      unpackApp,
      progress: (artifact) => startDownload(artifact.name, artifact.size),
    });
    console.log(verifiedLine(version, staged.signed, staged.cliSha256));
  } else {
    const cli = selectArtifact(source.manifest, "cli", arch());
    console.log(
      cli === null
        ? `hive ${version} is already staged.`
        : `${verifiedLine(version, trust.signed, cli.sha256)} (already staged)`,
    );
  }

  // The activation half, only when the control plane is provably idle.
  const expected = await expectedDaemonHandshake(process.cwd());
  const daemon = await inspectDaemonForUpdate({ expected, liveAgents: liveAgentNames });
  const refusal = explainRefusal(daemon);
  if (refusal !== null) {
    console.log(`hive ${version} activates when the team finishes.`);
    console.log(refusal);
    return;
  }

  const outcome = await activateWithHealthCheck(version, { root, healthCheck });
  await ensureBinLink(root);
  if (!outcome.activated) {
    throw new UpdateError(
      outcome.revertedTo === null
        ? outcome.reason
        : `${outcome.reason}; reverted to hive ${outcome.revertedTo}`,
    );
  }
  console.log(`hive ${outcome.version} active.`);
  await stopStaleDaemonAfterActivation();
}

export { cliPath, currentLink };
