/** `hive uninstall` removes Hive-owned integration without treating the command as authority to discard unsettled work. Repo uninstall asks the live settlement service to close exact-safe cases before stopping it, then removes byte-identical skills and standards, Hive's marked `.gitignore` entries, leaked runtime config, graph output, and derived project state. Any remaining worktree, branch, edited Hive file, or user file stays and is named. Machine uninstall removes the shared Hive home and managed install only after its separate live-team and mutation-lease checks. */
import { existsSync } from "node:fs";
import { readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type CommandRunner,
  GRAPHIFY_IGNORE_MARKER,
  graphOutDir,
  runCommand,
} from "../adapters/graphify";
import { nativeSkillDirectory, type SkillTool } from "../adapters/skills";
import { listHiveBranches, listWorktrees } from "../adapters/worktrees";
import {
  daemonInstanceLiveness,
  expectedDaemonHandshake,
  readDaemonHandshake,
  readDaemonPort,
} from "../daemon/lifecycle/daemon-lifecycle";
import {
  type InstanceMutationBlocker,
  instanceMutationBlockers,
  listInstances,
} from "../daemon/lifecycle/instances";
import {
  acquireMachineMutationLease,
  type MachineMutationLease,
  type MachineMutationPurpose,
} from "../daemon/mutation-lease";
import { projectStateDir } from "../daemon/project-identity-core/state";
import {
  AGENT_STANDARDS_FILE,
  scaffoldAgentStandardsMd,
} from "../daemon/spawn/agent-standards";
import { resolveHiveHome, userHiveHome } from "../hive-home/home";
import { resolveVariant, type VariantConfig } from "../hive-home/variant";
import { CAPABILITY_PROVIDERS } from "../schemas/capability";
import { errorMessage } from "../shared/error-message";
import { SHIPPED_SKILLS, shippedSkillAddresses } from "../skills/shipped";
import {
  binLink,
  detectInstallMethod,
  installRoot,
} from "../update-service/paths";
import { stopHive } from "./control";
import { isAgentCaller } from "./invoker";
import { fetchAgentStatus, requestSettlementSweep } from "./mcp";
import { repairLeakedProjectConfig } from "./project-config-cleanup";
import { type ConfirmFn, confirmOnTty } from "./prompt";
import { stripHiveGitignoreEntries } from "./repo-gitignore";

export interface UninstallDeps {
  run: CommandRunner;
  confirm: ConfirmFn;
  log: (line: string) => void;
  stopCurrentInstance: () => Promise<void>;
  /** Whether the selected instance's live daemon serves the repo being uninstalled. A foreign daemon must never be signaled. */
  currentInstanceOwnsProject: (root: string) => Promise<boolean>;
  settleCurrentProject: () => Promise<unknown>;
  liveTeams: () => Promise<readonly InstanceMutationBlocker[]>;
  stopInstances: () => Promise<void>;
  acquireLease: (
    purpose: MachineMutationPurpose,
  ) => Promise<MachineMutationLease>;
  /** Where this uninstall was invoked from. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Environment used to detect an agent caller. Defaults to `process.env`.
   * Tests pass a copy so they can set or clear HIVE_CAPABILITY_TOKEN without
   * mutating the process.
   */
  env?: Record<string, string | undefined>;
  /**
   * The root this invocation owns. Production never sets this — the CLI has
   * no flag for it — so an agent `hive uninstall` always uses the inherited
   * env root and is refused. Tests that must actually uninstall pass a
   * scratch path here instead of escaping the guard by moving cwd.
   */
  ownedRoot?: string;
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
    const states = await Promise.all(
      instances.map((instance) =>
        daemonInstanceLiveness(instance.home, instance.instanceId),
      ),
    );
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
      return (
        actual.instanceId === expected.instanceId &&
        actual.hiveUuid === expected.hiveUuid &&
        actual.identityKey === expected.identityKey &&
        actual.repoFamilyKey === expected.repoFamilyKey
      );
    } catch {
      return false;
    }
  },
  settleCurrentProject: async () => {
    const port = readDaemonPort();
    if (port === null)
      throw new Error("the project daemon has no readable port");
    return requestSettlementSweep(port);
  },
  liveTeams: () =>
    instanceMutationBlockers(async (port) => {
      const agents = await fetchAgentStatus(port);
      return agents
        .filter((agent) => agent.status !== "dead" && agent.status !== "done")
        .map((agent) => agent.name);
    }),
  stopInstances,
  acquireLease: acquireMachineMutationLease,
};

/**
 * Agent shells inherit HIVE_INSTALL_ROOT and HIVE_BIN_LINK pointing at the
 * owner's fleet. cwd under .hive/worktrees is the cheap first test;
 * HIVE_CAPABILITY_TOKEN is cwd-independent (wrapSpawnWithCapabilityEnv).
 * An explicit ownedRoot is a test-owned target, not a cwd escape.
 */
function refuseAgentWorktreeUninstall(
  deps: UninstallDeps,
  target: string,
): boolean {
  if (deps.ownedRoot !== undefined) return false;
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  if (!isAgentCaller(cwd, env)) return false;
  deps.log(
    `Refusing to uninstall ${target}: this process is an agent (worktree ${cwd} or HIVE_CAPABILITY_TOKEN is set) and agent shells inherit HIVE_INSTALL_ROOT and HIVE_BIN_LINK pointing at the owner install.\n` +
      "No files were removed. Fix: run `hive uninstall` from an owner shell that does not carry an agent credential, outside .hive/worktrees/.",
  );
  return true;
}

function liveTeamRefusal(blockers: readonly InstanceMutationBlocker[]): string {
  return (
    "Refusing machine uninstall while a Hive instance has a live or unobservable team: " +
    blockers
      .map(
        ({ instance, liveAgents }) =>
          `${instance.name} (${liveAgents.join(", ")})`,
      )
      .join("; ") +
    "\nFix: let every team finish and make every instance observable, then rerun `hive uninstall`."
  );
}

/** Confirm a destructive plan: explicit `--yes` wins, a TTY is asked (default no), and a non-TTY without `--yes` refuses with the scriptable spelling — a destructive default is never guessed. */
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
    deps.log(
      "Refusing to uninstall without confirmation; pass --yes to proceed non-interactively.",
    );
    return false;
  }
  return answer;
}

async function removeOwnedSkillCopy(
  root: string,
  directory: string,
  displayPath: string,
  shippedContent: string,
  run: CommandRunner,
  log: (line: string) => void,
): Promise<void> {
  const current = await readFile(join(directory, "SKILL.md"), "utf8").catch(
    () => null,
  );
  if (current === null) return;
  if (current !== shippedContent) {
    log(
      `Left ${displayPath}: it differs from what Hive ships, so it is yours.`,
    );
    return;
  }
  const tracking = await run(
    ["git", "-C", root, "ls-files", "--error-unmatch", "--", displayPath],
    { cwd: root, timeoutMs: 5_000 },
  );
  if (tracking.exitCode === 0) {
    log(`Left ${displayPath}: it is tracked by Git, so it is yours.`);
    return;
  }
  if (tracking.exitCode !== 1 && tracking.exitCode !== 128) {
    log(`Left ${displayPath}: Git could not determine whether it is tracked.`);
    return;
  }
  await rm(directory, { recursive: true, force: true });
  log(`Removed ${displayPath}.`);
}

/** Remove the generic AGENT_STANDARDS.md init wrote. Only a byte-identical scaffold is Hive's to remove; an edited file is the project's standing procedure. */
async function removeScaffoldedAgentStandards(
  root: string,
  log: (line: string) => void,
): Promise<void> {
  const path = join(root, AGENT_STANDARDS_FILE);
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === null) return;
  if (current !== scaffoldAgentStandardsMd()) {
    log(
      `Left ${AGENT_STANDARDS_FILE}: it differs from the generic scaffold, so it is yours.`,
    );
    return;
  }
  await rm(path, { force: true });
  log(`Removed ${AGENT_STANDARDS_FILE}.`);
}

/** Remove the exact local-state rules init placed beneath Hive's marker. */
async function removeHiveGitignoreEntries(
  root: string,
  log: (line: string) => void,
): Promise<void> {
  const path = join(root, ".gitignore");
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === null) return;
  const cleanup = stripHiveGitignoreEntries(current);
  if (cleanup.removedEntries.length === 0) return;
  if (cleanup.content === "") {
    await rm(path, { force: true });
    log("Removed .gitignore after removing Hive's local-state block.");
    return;
  }
  await writeFile(path, cleanup.content);
  log("Removed Hive's local-state entries from .gitignore.");
}

/** Remove the base skills Hive installed into `.hive/skills`, where they sit beside the user's own. Only byte-identical, untracked copies are Hive's to remove; an edited or tracked one is the user's and is reported instead, and their own skills are never candidates at all — a name Hive does not ship is not looked at. */
async function removeBaseSkills(
  root: string,
  run: CommandRunner,
  log: (line: string) => void,
): Promise<void> {
  const skillsRoot = join(root, ".hive", "skills");
  if (!existsSync(skillsRoot)) return;
  for (const skill of SHIPPED_SKILLS) {
    for (const address of shippedSkillAddresses(skill)) {
      const directory = join(skillsRoot, address, skill.name);
      const relativePath = join(".hive", "skills", address, skill.name);
      await removeOwnedSkillCopy(
        root,
        directory,
        relativePath,
        skill.content,
        run,
        log,
      );
    }
  }
  for (const address of new Set(
    SHIPPED_SKILLS.flatMap(shippedSkillAddresses),
  )) {
    const parts = address.split("/");
    for (let depth = parts.length; depth > 0; depth -= 1) {
      await rmdir(join(skillsRoot, ...parts.slice(0, depth))).catch(() => {});
    }
  }
}

/** Remove shipped skills from one vendor directory of the primary checkout. Only byte-identical, untracked copies are Hive's to remove; an edited or tracked skill is the user's and is reported instead. */
async function removeShippedSkills(
  root: string,
  tool: SkillTool,
  run: CommandRunner,
  log: (line: string) => void,
): Promise<void> {
  const nativeDirectory = nativeSkillDirectory(tool);
  const nativeRoot = join(root, nativeDirectory);
  if (!existsSync(nativeRoot)) return;
  for (const skill of SHIPPED_SKILLS.filter((skill) =>
    skill.tools.includes(tool),
  )) {
    const directory = join(nativeRoot, skill.name);
    await removeOwnedSkillCopy(
      root,
      directory,
      join(nativeDirectory, skill.name),
      skill.content,
      run,
      log,
    );
  }
  for (const dir of [nativeRoot, join(root, dirname(nativeDirectory))]) {
    await rmdir(dir).catch(() => {});
  }
}

async function reportUnsettledWork(
  root: string,
  log: (line: string) => void,
): Promise<number> {
  const container = resolve(root, ".hive", "worktrees");
  const worktrees = await listWorktrees(root);
  const registered = worktrees.filter(
    (worktree) => dirname(resolve(worktree.path)) === container,
  );
  for (const worktree of registered) {
    log(
      `Left protected settlement worktree ${worktree.path} (${worktree.branch ?? "detached"}).`,
    );
  }
  const diskEntries = await readdir(container).catch(() => [] as string[]);
  const registeredPaths = new Set(
    registered.map((worktree) => resolve(worktree.path)),
  );
  for (const entry of diskEntries) {
    const path = resolve(container, entry);
    if (!registeredPaths.has(path)) {
      log(`Left unregistered settlement path ${path} for inspection.`);
    }
  }
  await rmdir(container).catch(() => {});
  await rmdir(join(root, ".hive")).catch(() => {});
  const branches = await listHiveBranches(root);
  for (const branch of branches) {
    log(`Left protected settlement branch ${branch}.`);
  }
  return registered.length + diskEntries.length + branches.length;
}

export async function runUninstallRepo(
  root: string,
  options: { yes?: boolean } = {},
  deps: UninstallDeps = defaultUninstallDeps,
): Promise<number> {
  if (refuseAgentWorktreeUninstall(deps, root)) return 1;
  const plan = [
    `This removes Hive from ${root}:`,
    "  - stops the selected daemon only when its handshake proves it serves this project",
    "  - asks the settlement service to release exact-safe worktrees and branches; unprovable work stays protected",
    "  - removes the skills Hive installed (edited copies are yours and stay)",
    "  - removes AGENT_STANDARDS.md only when it still matches the generic scaffold",
    "  - removes Hive's marked local-state entries from .gitignore",
    "  - removes Hive's entries from .mcp.json, .claude/settings.local.json, and .codex/",
    "  - deletes graphify-out/, the generated .graphifyignore, and this repo's derived state under ~/.hive/projects/",
    "The graphify tool under ~/.hive/tools is shared across repos and stays; `hive uninstall` removes it.",
  ];
  if (
    !(await confirmed(plan, "Remove Hive from this repo?", options.yes, deps))
  ) {
    return 1;
  }

  if (await deps.currentInstanceOwnsProject(root)) {
    try {
      await deps.settleCurrentProject();
      await deps.stopCurrentInstance();
    } catch (error) {
      deps.log(
        `Refusing repo uninstall because this project's instance did not stop: ${errorMessage(error)}\n` +
          "Fix: stop its agents and daemon, then rerun `hive uninstall --repo`.",
      );
      return 1;
    }
  }
  let unsettled = 0;
  try {
    unsettled = await reportUnsettledWork(root, deps.log);
  } catch (error) {
    deps.log(
      `Repo uninstall stopped before cleanup completed: ${errorMessage(error)}\n` +
        "Fix: resolve the Git error, then rerun `hive uninstall --repo`.",
    );
    return 1;
  }
  await removeBaseSkills(root, deps.run, deps.log);
  await removeScaffoldedAgentStandards(root, deps.log);
  await removeHiveGitignoreEntries(root, deps.log);
  // Remove byte-identical Hive skills from vendor directories too.
  for (const tool of CAPABILITY_PROVIDERS) {
    await removeShippedSkills(root, tool, deps.run, deps.log);
  }
  const repaired = await repairLeakedProjectConfig(root);
  for (const path of repaired) deps.log(`Removed Hive's entries from ${path}.`);
  await rm(graphOutDir(root), { recursive: true, force: true });
  const ignorePath = join(root, ".graphifyignore");
  const ignoreContent = await readFile(ignorePath, "utf8").catch(() => null);
  if (ignoreContent?.startsWith(GRAPHIFY_IGNORE_MARKER)) {
    await rm(ignorePath, { force: true });
    deps.log("Removed the generated .graphifyignore.");
  }
  const stateDir = projectStateDir(root);
  await rm(stateDir, { recursive: true, force: true });
  deps.log(`Removed ${stateDir}.`);
  deps.log(
    unsettled === 0
      ? "Hive is removed from this repo. `hive init` brings it back."
      : `Hive's repo integration is removed; ${unsettled} protected settlement item(s) remain until their cases are resolved.`,
  );
  return 0;
}

/**
 * The paths this uninstall will actually delete, in the words the user needs before consenting.
 *
 * `instances/` is listed entry by entry because a home that holds named instances takes every one
 * of them with it, and a plan that says only "the home" does not let anyone consent to that. The
 * two sessiond roots are named because they are the install's and are removed with it — the socket
 * root sits outside the home so a bind address fits in `sun_path`, which is exactly why leaving it
 * to a sweep of the home left it behind.
 */
async function homeRemovalPlan(config: VariantConfig): Promise<string[]> {
  const lines = [
    config.retention.length === 0
      ? `  - deletes ${config.home} — all Hive state, memory, the graphify tool, and any skills you authored under ${join(config.home, "skills")}`
      : `  - clears ${config.home}, keeping ${config.retention.join(", ")}`,
  ];
  const instancesRoot = join(config.home, "instances");
  if (existsSync(instancesRoot)) {
    for (const name of await readdir(instancesRoot)) {
      lines.push(
        `  - deletes ${join(instancesRoot, name)}, a separate Hive install inside that home`,
      );
    }
  }
  lines.push(
    `  - deletes this install's sessiond roots, ${config.socketRoot} and ${config.sessiondStateRoot}`,
  );
  return lines;
}

/**
 * Empty a home of everything this variant does not retain.
 *
 * Entries are removed one at a time from a directory listing rather than by recursing into the
 * home, so a symlink is unlinked instead of followed. That distinction is the whole safety property
 * here: several retained names are links into the user's own home, and following one would delete
 * the store it points at rather than the link to it.
 *
 * The home directory itself goes only when nothing was kept, which is what `rmdir` refusing a
 * non-empty directory already says — so there is no second rule deciding it.
 */
async function clearHome(config: VariantConfig): Promise<void> {
  if (!existsSync(config.home)) return;
  const retained = config.retention.map((pattern) => new Bun.Glob(pattern));
  for (const entry of await readdir(config.home)) {
    if (retained.some((pattern) => pattern.match(entry))) continue;
    await rm(join(config.home, entry), { recursive: true, force: true });
  }
  await rmdir(config.home).catch(() => {});
}

export async function runUninstallMachine(
  options: { yes?: boolean; purge?: boolean } = {},
  deps: UninstallDeps = defaultUninstallDeps,
): Promise<number> {
  if (refuseAgentWorktreeUninstall(deps, `${installRoot()} (${binLink()})`)) {
    return 1;
  }
  const method = detectInstallMethod(process.execPath);
  const resolved = resolveVariant();
  // A non-prod variant must never clear ~/.hive. Equality with defaultHome is
  // not that test: `make qa` pins HIVE_HOME and HIVE_DEFAULT_HOME to the same
  // isolated tree so uninstall cannot see the live fleet.
  if (
    resolved.variant !== "prod" &&
    resolved.home === resolveHiveHome(userHiveHome())
  ) {
    deps.log(
      `Refusing ${resolved.binName} uninstall: its home ${resolved.home} is the production home. Set HIVE_HOME to this variant's isolated home.`,
    );
    return 1;
  }
  // Purge is this same uninstall with the variant's retention overridden to nothing — dev's
  // destroy-everything command (`make clean-all`), not a second deletion path. On prod it is
  // idempotent rather than dead, because prod's configured retention is already empty.
  const config: VariantConfig =
    options.purge === true ? { ...resolved, retention: [] } : resolved;
  const blockers = await deps.liveTeams();
  if (blockers.length > 0) {
    deps.log(liveTeamRefusal(blockers));
    return 1;
  }
  const plan = [
    "This removes Hive from this machine:",
    "  - stops every idle daemon and this instance's leftover sessions",
    ...(await homeRemovalPlan(config)),
    // A purge of a retaining variant is a wider deletion than the variant's own uninstall, and a
    // plan that does not say so cannot be consented to.
    ...(options.purge === true && resolved.retention.length > 0
      ? [
          `  - overrides this variant's configured retention (${resolved.retention.join(", ")}): a purge keeps nothing`,
        ]
      : []),
    ...(method === "native"
      ? [
          `  - deletes the installed releases (${installRoot()}) and the \`${config.binName}\` command (${binLink()})`,
        ]
      : [
          `  - leaves the hive binary alone: this install is ${method}, not Hive-managed`,
        ]),
    "Repos keep the skills Hive installed into them; run `hive uninstall --repo` in a repo first to clean it.",
  ];
  if (!(await confirmed(plan, "Completely remove Hive?", options.yes, deps))) {
    return 1;
  }

  let lease: MachineMutationLease;
  try {
    lease = await deps.acquireLease("machine-uninstall");
  } catch (error) {
    deps.log(`Refusing machine uninstall: ${errorMessage(error)}`);
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
        `Refusing to remove the machine-wide binary because a Hive instance did not stop: ${errorMessage(
          error,
        )}\nFix: stop every Hive daemon, then rerun \`hive uninstall\`.`,
      );
      return 1;
    }
    try {
      await deps.stopCurrentInstance();
    } catch (error) {
      deps.log(
        `Refusing machine uninstall because this instance's sessions did not stop: ${errorMessage(
          error,
        )}\nFix: stop the sessions, then rerun \`hive uninstall\`.`,
      );
      return 1;
    }
    await clearHome(config);
    deps.log(
      config.retention.length === 0
        ? `Removed ${config.home}.`
        : `Cleared ${config.home}, keeping ${config.retention.join(", ")}.`,
    );
    // The identity marker lives outside the home precisely so it survives the home's deletion,
    // so clearing the home cannot reach it and a purge must take it separately. A surviving
    // marker is recorded, not returned on: the operator asked for everything gone, and stopping
    // here would leave the sessiond roots and the install in place while the report named one
    // file. Every remaining removal is attempted first; the exit code still says the purge
    // failed, because a marker left behind re-arms the guard against the home the purge just
    // emptied — the next run reads it, finds no database, and refuses to start.
    let purgeFailure: string | null = null;
    if (options.purge === true) {
      let markerError: unknown = null;
      try {
        await rm(config.databaseIdentityPath, { force: true });
      } catch (error) {
        markerError = error;
      }
      if (existsSync(config.databaseIdentityPath)) {
        purgeFailure =
          `the database identity marker ${config.databaseIdentityPath} survived` +
          (markerError === null ? "" : ` (${errorMessage(markerError)})`);
      }
    }
    for (const root of [config.socketRoot, config.sessiondStateRoot]) {
      await rm(root, { recursive: true, force: true });
    }
    deps.log(`Removed ${config.socketRoot} and ${config.sessiondStateRoot}.`);
    if (method === "native") {
      await rm(installRoot(), { recursive: true, force: true });
      await rm(binLink(), { force: true });
      deps.log(`Removed ${installRoot()} and ${binLink()}.`);
    }
    if (purgeFailure !== null) {
      const alsoRemoved =
        method === "native"
          ? `${config.socketRoot}, ${config.sessiondStateRoot}, ${installRoot()} and ${binLink()}`
          : `${config.socketRoot} and ${config.sessiondStateRoot}`;
      deps.log(
        `Purge incomplete: ${purgeFailure}. Everything else the purge takes was removed: the home, ${alsoRemoved}.` +
          "\nFix: remove the marker by hand; while it remains, the next run refuses the empty home this purge made.",
      );
      return 1;
    }
    deps.log(
      config.retention.length === 0
        ? "Hive is removed."
        : `${config.binName} is removed; what it kept is still in ${config.home}.`,
    );
    return 0;
  } finally {
    lease.release();
  }
}

export async function runUninstall(
  root: string,
  options: { repo?: boolean; yes?: boolean; purge?: boolean } = {},
  deps: UninstallDeps = defaultUninstallDeps,
): Promise<number> {
  return options.repo === true
    ? runUninstallRepo(root, options, deps)
    : runUninstallMachine(options, deps);
}
