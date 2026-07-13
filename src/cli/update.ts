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
  ensureStaged,
  readInstallState,
  rollback,
  type ActivationOutcome,
  type StageOutcome,
} from "../update/install";
import {
  explainRefusal,
  inspectDaemonForUpdate,
  restartStaleDaemon,
  type DaemonUpdateState,
} from "../update/daemon";
import { startDownload } from "../update/progress";
import { releaseKeys } from "../release/manifest";
import { expectedDaemonHandshake } from "../daemon/handshake";
import { isRunning } from "../daemon/lifecycle";
import {
  instanceMutationBlockers,
  type InstanceMutationBlocker,
} from "../daemon/instances";
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
import {
  acquireMachineMutationLease,
  type MachineMutationLease,
  type MachineMutationPurpose,
} from "../daemon/mutation-lease";

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
    throw new UpdateError(`updates are disabled (${disabled})`);
  }
  const method = detectInstallMethod(process.execPath);
  if (method === "source") {
    throw new UpdateError(
      "this is a source checkout, not an installed release; `hive update` only " +
        "updates an installed hive\nFix: pull and rebuild instead",
    );
  }
  if (method === "homebrew") {
    throw new UpdateError(
      "Homebrew installed this hive and owns the install\n" +
        "Fix: run `brew upgrade hive`",
    );
  }
  if (method === "unmanaged") {
    throw new UpdateError(
      `this hive binary (${process.execPath}) was not installed by hive's ` +
        "installer, so there is nothing safe to replace",
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
  console.log(`Silenced notices for hive ${cache.latestVersion}`);
}

export interface RollbackMutationDeps {
  acquireLease: (purpose: MachineMutationPurpose) => Promise<MachineMutationLease>;
  blockers: () => Promise<readonly InstanceMutationBlocker[]>;
  rollback: () => Promise<ActivationOutcome>;
  stopStaleDaemon: () => Promise<void>;
  log: (line: string) => void;
}

export async function rollbackWhenIdle(deps: RollbackMutationDeps): Promise<void> {
  const lease = await deps.acquireLease("rollback");
  try {
    const blockers = await deps.blockers();
    if (blockers.length > 0) throw new UpdateError(globalMutationRefusal(blockers));
    const outcome = await deps.rollback();
    if (!outcome.activated) throw new UpdateError(outcome.reason);
    deps.log(`hive ${outcome.version} active (rolled back)`);
    await deps.stopStaleDaemon();
  } finally {
    lease.release();
  }
}

export async function runRollback(): Promise<void> {
  guardSelfUpdate();
  await rollbackWhenIdle({
    acquireLease: acquireMachineMutationLease,
    blockers: () => instanceMutationBlockers(liveAgentNames),
    rollback: () => rollback({ healthCheck }),
    stopStaleDaemon: stopStaleDaemonAfterActivation,
    log: console.log,
  });
}

export function globalMutationRefusal(
  blockers: readonly InstanceMutationBlocker[],
): string {
  return blockers.map(({ instance, liveAgents }) =>
    `${instance.name}: ${liveAgents.join(", ")}`
  ).join("; ") +
    " — refusing to change the machine-wide active Hive binary while any instance has a live or unobservable team\n" +
    "Fix: wait for every team to finish or stop them, then retry.";
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
 * What was actually checked, named one by one.
 *
 * Hive performs three independent integrity checks on every update — the Ed25519
 * signature over the manifest, the SHA-256 of each artifact against that signed
 * manifest, and executing the staged binary to make it state its own version
 * before it can ever be `current` — and for a long time told the user about none
 * of them. "Downloaded and verified" names no check and so cannot be wrong,
 * which is exactly what was wrong with it: it neither earns trust nor risks
 * anything. The answer to a trust complaint is not a stronger adjective, it is
 * saying plainly what already happens. So the line lists the three checks.
 *
 * The rejected alternative was to keep the vague line and let `hive update
 * status` carry the detail. It loses because the moment of the claim is the
 * moment the user is deciding, and nobody audits an install afterwards.
 *
 */
function verifiedLine(staged: StageOutcome): string {
  const how = staged.reused ? "already staged" : "staged";
  return `hive ${staged.version} ${how} — verified: Ed25519 signature, SHA-256, binary probed`;
}

export interface StagedUpdateActivationDeps {
  acquireLease: (purpose: MachineMutationPurpose) => Promise<MachineMutationLease>;
  blockers: () => Promise<readonly InstanceMutationBlocker[]>;
  inspectDaemon: () => Promise<DaemonUpdateState>;
  activate: () => Promise<ActivationOutcome>;
  ensureBinLink: () => Promise<void>;
  stopStaleDaemon: () => Promise<void>;
  log: (line: string) => void;
}

export async function activateStagedUpdate(
  version: string,
  deps: StagedUpdateActivationDeps,
): Promise<void> {
  const lease = await deps.acquireLease("update");
  try {
    const blockers = await deps.blockers();
    if (blockers.length > 0) {
      deps.log(`hive ${version} activates when every instance's team finishes`);
      deps.log(globalMutationRefusal(blockers));
      return;
    }
    const daemon = await deps.inspectDaemon();
    const refusal = explainRefusal(daemon);
    if (refusal !== null) {
      deps.log(`hive ${version} activates when the team finishes`);
      deps.log(refusal);
      return;
    }

    const outcome = await deps.activate();
    await deps.ensureBinLink();
    if (!outcome.activated) {
      throw new UpdateError(
        outcome.revertedTo === null
          ? outcome.reason
          : `${outcome.reason}; reverted to hive ${outcome.revertedTo}`,
      );
    }
    deps.log(`hive ${outcome.version} active`);
    await deps.stopStaleDaemon();
  } finally {
    lease.release();
  }
}

export async function runUpdate(requested?: string): Promise<void> {
  guardSelfUpdate();
  const root = installRoot();
  const target = requested ?? "latest";

  // The safe half, always: fetch, verify, stage. Never blocked by a live team.
  const source = await githubReleaseSource(target);
  const version = source.manifest.version;

  // One way in, whether the bytes arrive now or are already on disk. `isStaged()`
  // used to short-circuit staging entirely, which skipped all three checks — an
  // interrupted earlier run was enough to walk a binary past a fail-closed path.
  const staged = await ensureStaged({
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
  console.log(verifiedLine(staged));
  if (version === HIVE_VERSION && requested === undefined) {
    console.log(`hive ${HIVE_VERSION} is the latest release`);
    return;
  }

  await activateStagedUpdate(version, {
    acquireLease: acquireMachineMutationLease,
    blockers: () => instanceMutationBlockers(liveAgentNames),
    inspectDaemon: () => inspectDaemonForUpdate({
      expected: () => expectedDaemonHandshake(process.cwd()),
      liveAgents: liveAgentNames,
    }),
    activate: () => activateWithHealthCheck(version, { root, healthCheck }),
    ensureBinLink: () => ensureBinLink(root),
    stopStaleDaemon: stopStaleDaemonAfterActivation,
    log: console.log,
  });
}

export { cliPath, currentLink };
