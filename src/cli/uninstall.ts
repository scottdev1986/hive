/**
 * `hive uninstall` — remove Hive completely; `--repo` removes what Hive put
 * in (and derived for) the current repo and nothing machine-wide.
 *
 * Complete removal is the acceptance test for Hive's whole repo-local
 * posture: if uninstall leaves residue, the posture was a lie. The inventory
 * below is everything Hive writes, audited from the writers themselves:
 *
 *   Repo-level (`--repo`):
 *   - shipped skills in `.claude/skills/` and `.agents/skills/` — removed
 *     only when byte-identical to what Hive ships; an edited copy is the
 *     human's and is reported, not deleted (the same rule install obeys)
 *   - agent worktrees under `.hive/worktrees/` and their `hive/*` branches
 *     (worktree-local `.mcp.json`, vendor configs, graphify hook scripts,
 *     and per-worktree skills all live inside them and go with them)
 *   - leaked orchestrator runtime config in the primary checkout
 *     (`.mcp.json`, `.claude/settings.local.json`, `.codex/*`) — the same
 *     signature-matched repair every session boundary runs
 *   - `graphify-out/` and Hive's generated `.graphifyignore`
 *   - the project's derived-state dir `~/.hive/projects/<uuid>/` (serving
 *     snapshot and init stamp)
 *
 *   Machine-level (no flag):
 *   - `~/.hive` — state, memory, the graphify tool under `tools/`, and any
 *     skills the user authored under `~/.hive/skills` (the confirmation
 *     names this; it is the one place user-authored content lives)
 *   - installed releases (`~/.local/share/hive`) and the `~/.local/bin/hive`
 *     link — only when Hive owns the install; a source or unmanaged binary is
 *     named and left alone
 *
 * Deliberately not removed: `AGENTS.md` (scaffolded only on request and then
 * edited by humans — it is the user's document) and repo-level skills in
 * OTHER repos, which a machine-wide uninstall cannot know about; the
 * confirmation says to run `--repo` in each repo first if wanted.
 *
 * Both forms confirm before acting (destructive), on the TTY; `--yes` is the
 * scriptable spelling, and a non-TTY run without it refuses rather than
 * guessing.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  GRAPHIFY_IGNORE_MARKER,
  graphOutDir,
  runCommand,
  type CommandRunner,
} from "../adapters/graphify";
import { projectStateDir } from "../daemon/project-state";
import { nativeSkillDirectory, type SkillTool } from "../adapters/skills";
import { CAPABILITY_PROVIDERS } from "../schemas";
import { shippedSkillsFor } from "../skills/shipped";
import { binLink, detectInstallMethod, installRoot } from "../update/paths";
import { stopHive } from "./control";
import { fetchAgentStatus } from "./mcp";
import { confirmOnTty, type ConfirmFn } from "./prompt";
import { repairLeakedProjectConfig } from "./project-config-cleanup";
import {
  instanceMutationBlockers,
  listInstances,
  machineHiveHome,
  type InstanceMutationBlocker,
} from "../daemon/instances";
import { daemonInstanceLiveness, readDaemonPort } from "../daemon/lifecycle";
import {
  expectedDaemonHandshake,
  readDaemonHandshake,
} from "../daemon/handshake";
import {
  branchOwner,
  clearBranchOwnership,
  listWorktrees,
} from "../adapters/worktrees";
import { hiveInstanceSuffix, isDefaultHiveHome } from "../daemon/tmux-sessions";
import {
  acquireMachineMutationLease,
  type MachineMutationLease,
  type MachineMutationPurpose,
} from "../daemon/mutation-lease";

export interface UninstallDeps {
  run: CommandRunner;
  confirm: ConfirmFn;
  log: (line: string) => void;
  /** Clean up this instance's sessions after every daemon has exited. */
  stopCurrentInstance: () => Promise<void>;
  /** Whether the selected instance's live daemon serves the repo being
   * uninstalled. A foreign daemon must never be signaled. */
  currentInstanceOwnsProject: (root: string) => Promise<boolean>;
  liveTeams: () => Promise<readonly InstanceMutationBlocker[]>;
  stopInstances: () => Promise<void>;
  acquireLease: (purpose: MachineMutationPurpose) => Promise<MachineMutationLease>;
}

async function stopInstances(): Promise<void> {
  const instances = await listInstances();
  for (const instance of instances) {
    if (!instance.running) continue;
    if (instance.pid === null) {
      throw new Error(`instance ${instance.name} has no recorded daemon pid`);
    }
    process.kill(instance.pid, "SIGTERM");
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const states = await Promise.all(instances.map((instance) =>
      daemonInstanceLiveness(instance.home, instance.instanceId)
    ));
    if (states.every((state) => state === "dead")) return;
    await Bun.sleep(50);
  }
  throw new Error("one or more Hive instances did not stop");
}

export const defaultUninstallDeps: UninstallDeps = {
  run: runCommand,
  confirm: confirmOnTty,
  log: console.log,
  stopCurrentInstance: stopHive,
  currentInstanceOwnsProject: async (root) => {
    const port = readDaemonPort();
    if (port === null) return false;
    try {
      const [actual, expected] = await Promise.all([
        readDaemonHandshake(port),
        expectedDaemonHandshake(root),
      ]);
      return actual.instanceId === expected.instanceId &&
        actual.hiveUuid === expected.hiveUuid &&
        actual.identityKey === expected.identityKey &&
        actual.repoFamilyKey === expected.repoFamilyKey;
    } catch {
      return false;
    }
  },
  liveTeams: () => instanceMutationBlockers(async (port) => {
    const agents = await fetchAgentStatus(port);
    return agents
      .filter((agent) => agent.status !== "dead" && agent.status !== "done")
      .map((agent) => agent.name);
  }),
  stopInstances,
  acquireLease: acquireMachineMutationLease,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandFailure(
  action: string,
  result: Awaited<ReturnType<CommandRunner>>,
): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new Error(`${action}: ${detail}`);
}

function liveTeamRefusal(blockers: readonly InstanceMutationBlocker[]): string {
  return "Refusing machine uninstall while a Hive instance has a live or unobservable team: " +
    blockers.map(({ instance, liveAgents }) =>
      `${instance.name} (${liveAgents.join(", ")})`
    ).join("; ") +
    "\nFix: let every team finish and make every instance observable, then rerun `hive uninstall`.";
}

/** Confirm a destructive plan: explicit `--yes` wins, a TTY is asked
 * (default no), and a non-TTY without `--yes` refuses with the scriptable
 * spelling — a destructive default is never guessed. */
async function confirmed(
  plan: string[],
  question: string,
  yes: boolean | undefined,
  deps: UninstallDeps,
): Promise<boolean> {
  for (const line of plan) deps.log(line);
  if (yes === true) return true;
  const answer = await deps.confirm(question, false);
  if (answer === null) {
    deps.log("Refusing to uninstall without confirmation; pass --yes to proceed non-interactively.");
    return false;
  }
  return answer;
}

/** Remove the shipped skills Hive installed into one vendor directory of the
 * primary checkout. Only byte-identical copies are Hive's to remove; an
 * edited skill is the human's and is reported instead. */
async function removeShippedSkills(
  root: string,
  tool: SkillTool,
  log: (line: string) => void,
): Promise<void> {
  const nativeDirectory = nativeSkillDirectory(tool);
  const nativeRoot = join(root, nativeDirectory);
  if (!existsSync(nativeRoot)) return;
  for (const skill of shippedSkillsFor(tool)) {
    const directory = join(nativeRoot, skill.name);
    const current = await readFile(join(directory, "SKILL.md"), "utf8")
      .catch(() => null);
    if (current === null) continue;
    if (current === skill.content) {
      await rm(directory, { recursive: true, force: true });
      log(`Removed ${join(nativeDirectory, skill.name)}.`);
    } else {
      log(
        `Left ${join(nativeDirectory, skill.name)}: it differs from what Hive ships, so it is yours.`,
      );
    }
  }
  // Directories Hive may have created, removed only when now empty — an
  // empty vendor dir in a stranger's repo is litter either way.
  for (const dir of [nativeRoot, join(root, dirname(nativeDirectory))]) {
    await rmdir(dir).catch(() => {});
  }
}

/** Remove only this instance's worktrees and branches. */
async function removeWorktreesAndBranches(
  root: string,
  run: CommandRunner,
  log: (line: string) => void,
): Promise<void> {
  const container = resolve(root, ".hive", "worktrees");
  const instanceId = hiveInstanceSuffix();
  const allowLegacy = isDefaultHiveHome();
  const worktrees = await listWorktrees(root);
  const worktreeMarker = `${join(".hive", "worktrees")}/`;
  const registered = new Map(
    worktrees
      .filter((worktree) =>
        worktree.path.includes(worktreeMarker)
      )
      .map((worktree) => [basename(worktree.path), worktree]),
  );
  const entries = await readdir(container).catch(() => [] as string[]);
  for (const entry of entries) {
    const path = resolve(container, entry);
    const worktree = registered.get(entry);
    const owner = worktree?.branch === null || worktree?.branch === undefined
      ? undefined
      : await branchOwner(root, worktree.branch);
    const owned = owner === instanceId || (owner === undefined && allowLegacy);
    if (!owned) {
      log(`Left sibling-owned worktree ${path}.`);
      continue;
    }
    const removed = await run(
      ["git", "worktree", "remove", "--force", path],
      { cwd: root, timeoutMs: 30_000 },
    );
    if (removed.exitCode !== 0 && allowLegacy && worktree === undefined) {
      // A directory that is not a registered worktree (stale leftovers) is
      // only safely attributable to the legacy default instance.
      await rm(path, { recursive: true, force: true });
    } else if (removed.exitCode !== 0) {
      throw commandFailure(`Git could not remove owned worktree ${path}`, removed);
    }
    log(`Removed worktree ${path}.`);
  }
  const pruned = await run(
    ["git", "worktree", "prune"],
    { cwd: root, timeoutMs: 30_000 },
  );
  if (pruned.exitCode !== 0) {
    throw commandFailure("Git could not prune removed worktrees", pruned);
  }
  await rmdir(container).catch(() => {});
  await rmdir(join(root, ".hive")).catch(() => {
    // Only removed when empty: `.hive/skills` and other user content stay.
  });

  const branches = await run(
    ["git", "branch", "--list", "hive/*", "--format", "%(refname:short)"],
    { cwd: root, timeoutMs: 30_000 },
  );
  if (branches.exitCode !== 0) {
    throw commandFailure("Git could not list Hive branches", branches);
  }
  for (const branch of branches.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)) {
    const owner = await branchOwner(root, branch);
    if (owner !== instanceId && !(owner === undefined && allowLegacy)) {
      log(`Left sibling-owned branch ${branch}.`);
      continue;
    }
    const deleted = await run(
      ["git", "branch", "-D", branch],
      { cwd: root, timeoutMs: 30_000 },
    );
    if (deleted.exitCode !== 0) {
      throw commandFailure(`Git could not delete owned branch ${branch}`, deleted);
    }
    await clearBranchOwnership(root, branch);
    log(`Deleted branch ${branch}.`);
  }
}

export async function runUninstallRepo(
  root: string,
  options: { yes?: boolean } = {},
  deps: UninstallDeps = defaultUninstallDeps,
): Promise<number> {
  const plan = [
    `This removes Hive from ${root}:`,
    "  - stops the selected daemon only when its handshake proves it serves this project",
    "  - deletes this instance's agent worktrees and hive/* branches (its unlanded agent work is lost)",
    "  - removes the skills Hive installed (edited copies are yours and stay)",
    "  - removes Hive's entries from .mcp.json, .claude/settings.local.json, and .codex/",
    "  - deletes graphify-out/, the generated .graphifyignore, and this repo's derived state under ~/.hive/projects/",
    "The graphify tool under ~/.hive/tools is shared across repos and stays; `hive uninstall` removes it.",
  ];
  if (!(await confirmed(plan, "Remove Hive from this repo?", options.yes, deps))) {
    return 1;
  }

  if (await deps.currentInstanceOwnsProject(root)) {
    try {
      await deps.stopCurrentInstance();
    } catch (error) {
      deps.log(
        `Refusing repo uninstall because this project's instance did not stop: ${errorMessage(error)}\n` +
          "Fix: stop its agents and daemon, then rerun `hive uninstall --repo`.",
      );
      return 1;
    }
  }
  try {
    await removeWorktreesAndBranches(root, deps.run, deps.log);
  } catch (error) {
    deps.log(
      `Repo uninstall stopped before cleanup completed: ${errorMessage(error)}\n` +
        "Fix: resolve the Git error, then rerun `hive uninstall --repo`.",
    );
    return 1;
  }
  for (const tool of CAPABILITY_PROVIDERS) {
    await removeShippedSkills(root, tool, deps.log);
  }
  const repaired = await repairLeakedProjectConfig(root);
  for (const path of repaired) deps.log(`Removed Hive's entries from ${path}.`);
  await rm(graphOutDir(root), { recursive: true, force: true });
  // Only Hive's generated .graphifyignore (identified by its marker line) is
  // Hive's to delete; a user-authored one stays — the same rule purge obeys.
  const ignorePath = join(root, ".graphifyignore");
  const ignoreContent = await readFile(ignorePath, "utf8").catch(() => null);
  if (ignoreContent !== null && ignoreContent.startsWith(GRAPHIFY_IGNORE_MARKER)) {
    await rm(ignorePath, { force: true });
    deps.log("Removed the generated .graphifyignore.");
  }
  const stateDir = projectStateDir(root);
  await rm(stateDir, { recursive: true, force: true });
  deps.log(`Removed ${stateDir}.`);
  deps.log("Hive is removed from this repo. `hive init` brings it back.");
  return 0;
}

export async function runUninstallMachine(
  options: { yes?: boolean } = {},
  deps: UninstallDeps = defaultUninstallDeps,
): Promise<number> {
  const method = detectInstallMethod(process.execPath);
  const hiveHome = machineHiveHome();
  const blockers = await deps.liveTeams();
  if (blockers.length > 0) {
    deps.log(liveTeamRefusal(blockers));
    return 1;
  }
  const plan = [
    "This removes Hive from this machine:",
    "  - stops every idle daemon and this instance's leftover sessions",
    `  - deletes ${hiveHome} — all Hive state, memory, the graphify tool, and any skills you authored under ${join(hiveHome, "skills")}`,
    ...(method === "native"
      ? [`  - deletes the installed releases (${installRoot()}) and the \`hive\` command (${binLink()})`]
      : [`  - leaves the hive binary alone: this install is ${method}, not Hive-managed`]),
    "Repos keep the skills Hive installed into them; run `hive uninstall --repo` in a repo first to clean it.",
  ];
  if (!(await confirmed(plan, "Completely remove Hive?", options.yes, deps))) {
    return 1;
  }

  let lease: MachineMutationLease;
  try {
    lease = await deps.acquireLease("machine-uninstall");
  } catch (error) {
    deps.log(
      `Refusing machine uninstall: ${errorMessage(error)}`,
    );
    return 1;
  }

  try {
    const postConfirmationBlockers = await deps.liveTeams();
    if (postConfirmationBlockers.length > 0) {
      deps.log(liveTeamRefusal(postConfirmationBlockers));
      return 1;
    }
    try {
      await deps.stopInstances();
    } catch (error) {
      deps.log(
        `Refusing to remove the machine-wide binary because a Hive instance did not stop: ${
          errorMessage(error)
        }\nFix: stop every Hive daemon, then rerun \`hive uninstall\`.`,
      );
      return 1;
    }
    try {
      await deps.stopCurrentInstance();
    } catch (error) {
      deps.log(
        `Refusing machine uninstall because this instance's sessions did not stop: ${
          errorMessage(error)
        }\nFix: stop the sessions, then rerun \`hive uninstall\`.`,
      );
      return 1;
    }
    await rm(hiveHome, { recursive: true, force: true });
    deps.log(`Removed ${hiveHome}.`);
    if (method === "native") {
      await rm(installRoot(), { recursive: true, force: true });
      await rm(binLink(), { force: true });
      deps.log(`Removed ${installRoot()} and ${binLink()}.`);
    }
    deps.log("Hive is removed.");
    return 0;
  } finally {
    lease.release();
  }
}

export async function runUninstall(
  root: string,
  options: { repo?: boolean; yes?: boolean } = {},
  deps: UninstallDeps = defaultUninstallDeps,
): Promise<number> {
  return options.repo === true
    ? runUninstallRepo(root, options, deps)
    : runUninstallMachine(options, deps);
}
