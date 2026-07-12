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
 *   - `graphify-out/` and the `.git/info/exclude` lines Hive appended (in
 *     the git common dir, so linked worktrees are covered)
 *   - the project's derived-state dir `~/.hive/projects/<uuid>/` (profile,
 *     graphify decision, init stamp)
 *
 *   Machine-level (no flag):
 *   - `~/.hive` — state, memory, the graphify tool under `tools/`, and any
 *     skills the user authored under `~/.hive/skills` (the confirmation
 *     names this; it is the one place user-authored content lives)
 *   - installed releases (`~/.local/share/hive`) and the `~/.local/bin/hive`
 *     link — only when Hive owns the install; a Homebrew or source install
 *     is named and left to its owner
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
import { dirname, join } from "node:path";
import {
  GRAPHIFY_IGNORE_MARKER,
  graphOutDir,
  removeGraphifyExcludeEntry,
  runCommand,
  type CommandRunner,
} from "../adapters/graphify";
import { projectStateDir } from "../adapters/profile";
import { nativeSkillDirectory, type SkillTool } from "../adapters/skills";
import { CAPABILITY_PROVIDERS } from "../schemas";
import { getHiveHome } from "../daemon/db";
import { shippedSkillsFor } from "../skills/shipped";
import { binLink, detectInstallMethod, installRoot } from "../update/paths";
import { stopHive } from "./control";
import { confirmOnTty, type ConfirmFn } from "./prompt";
import { repairLeakedProjectConfig } from "./project-config-cleanup";

export interface UninstallDeps {
  run: CommandRunner;
  confirm: ConfirmFn;
  log: (line: string) => void;
  /** Best-effort daemon/agent stop; injectable so tests never touch tmux. */
  stop: () => Promise<void>;
}

export const defaultUninstallDeps: UninstallDeps = {
  run: runCommand,
  confirm: confirmOnTty,
  log: console.log,
  stop: stopHive,
};

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

/** Remove every agent worktree under `.hive/worktrees/` and every `hive/*`
 * branch. The confirmation named this: unlanded agent work dies here. */
async function removeWorktreesAndBranches(
  root: string,
  run: CommandRunner,
  log: (line: string) => void,
): Promise<void> {
  const container = join(root, ".hive", "worktrees");
  const entries = await readdir(container).catch(() => [] as string[]);
  for (const entry of entries) {
    const path = join(container, entry);
    const removed = await run(
      ["git", "worktree", "remove", "--force", path],
      { cwd: root, timeoutMs: 30_000 },
    );
    if (removed.exitCode !== 0) {
      // A directory that is not a registered worktree (stale leftovers) is
      // still Hive's to delete.
      await rm(path, { recursive: true, force: true });
    }
    log(`Removed worktree ${path}.`);
  }
  await run(["git", "worktree", "prune"], { cwd: root, timeoutMs: 30_000 });
  await rm(container, { recursive: true, force: true });
  await rmdir(join(root, ".hive")).catch(() => {
    // Only removed when empty: `.hive/skills` and other user content stay.
  });

  const branches = await run(
    ["git", "branch", "--list", "hive/*", "--format", "%(refname:short)"],
    { cwd: root, timeoutMs: 30_000 },
  );
  if (branches.exitCode === 0) {
    for (const branch of branches.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)) {
      const deleted = await run(
        ["git", "branch", "-D", branch],
        { cwd: root, timeoutMs: 30_000 },
      );
      if (deleted.exitCode === 0) log(`Deleted branch ${branch}.`);
    }
  }
}

export async function runUninstallRepo(
  root: string,
  options: { yes?: boolean } = {},
  deps: UninstallDeps = defaultUninstallDeps,
): Promise<number> {
  const plan = [
    `This removes Hive from ${root}:`,
    "  - stops this project's agents and daemon",
    "  - deletes agent worktrees under .hive/worktrees/ and all hive/* branches (unlanded agent work is lost)",
    "  - removes the skills Hive installed (edited copies are yours and stay)",
    "  - removes Hive's entries from .mcp.json, .claude/settings.local.json, .codex/, and .git/info/exclude",
    "  - deletes graphify-out/, the generated .graphifyignore, and this repo's derived state under ~/.hive/projects/",
    "The graphify tool under ~/.hive/tools is shared across repos and stays; `hive uninstall` removes it.",
  ];
  if (!(await confirmed(plan, "Remove Hive from this repo?", options.yes, deps))) {
    return 1;
  }

  await deps.stop().catch(() => {
    // No daemon (or no tmux) is fine: there is nothing to stop.
  });
  await removeWorktreesAndBranches(root, deps.run, deps.log);
  for (const tool of CAPABILITY_PROVIDERS) {
    await removeShippedSkills(root, tool, deps.log);
  }
  const repaired = await repairLeakedProjectConfig(root);
  for (const path of repaired) deps.log(`Removed Hive's entries from ${path}.`);
  await rm(graphOutDir(root), { recursive: true, force: true });
  if (await removeGraphifyExcludeEntry(root, deps.run)) {
    deps.log("Removed Hive's .git/info/exclude entries.");
  }
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
  const hiveHome = getHiveHome();
  const plan = [
    "This removes Hive from this machine:",
    `  - stops running agents and the daemon`,
    `  - deletes ${hiveHome} — all Hive state, memory, the graphify tool, and any skills you authored under ${join(hiveHome, "skills")}`,
    ...(method === "native"
      ? [`  - deletes the installed releases (${installRoot()}) and the \`hive\` command (${binLink()})`]
      : [
          `  - leaves the hive binary alone: this install is ${method === "homebrew" ? "Homebrew's (`brew uninstall hive` removes it)" : `${method}, not Hive-managed`}`,
        ]),
    "Repos keep the skills Hive installed into them; run `hive uninstall --repo` in a repo first to clean it.",
  ];
  if (!(await confirmed(plan, "Completely remove Hive?", options.yes, deps))) {
    return 1;
  }

  await deps.stop().catch(() => {
    // No daemon is fine.
  });
  await rm(hiveHome, { recursive: true, force: true });
  deps.log(`Removed ${hiveHome}.`);
  if (method === "native") {
    await rm(installRoot(), { recursive: true, force: true });
    await rm(binLink(), { force: true });
    deps.log(`Removed ${installRoot()} and ${binLink()}.`);
  } else if (method === "homebrew") {
    deps.log("The binary is Homebrew's: `brew uninstall hive` finishes the job.");
  }
  deps.log("Hive is removed.");
  return 0;
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
