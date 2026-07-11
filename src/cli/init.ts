/**
 * `hive init` — the gated enrichment pass (SPEC.md decision 14).
 *
 * The profile itself is no longer this command's job. Every session boundary
 * ensures a correct profile silently, so there is nothing for a human to
 * initialize and nothing to keep up to date; `hive init` is left with only the
 * work that *must* be asked for, because it writes into the user's repo or
 * spends their tokens:
 *   - When no `AGENTS.md` exists, *offer* to scaffold one (opt-in, never blind —
 *     Codex caps the AGENTS.md chain at 32 KiB and truncates silently, so we
 *     never append to a human's existing instructions).
 *   - Seed a small set of narrative memory facts with `source: "init"` and a
 *     `verified` date (decision 5's provenance), derived and re-derivable —
 *     distinct from the earned facts an agent learns. Structured facts never
 *     become memory; they are already in the profile.
 *
 * Running the command is the authorization, and every action it takes is
 * printed — but it never ends by asking for another command. Anything Hive can
 * finish itself, it finishes here (the memory index below is the example: seeded
 * facts are indexed on the spot, not left with a note to go reindex them).
 * Model-authored narrative is supplied by the caller — hive's models are its
 * agents, not this CLI — and written through the same seeding path.
 */
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureProfile,
  loadDerivedProfile,
  regenerateProfile,
} from "../adapters/profile";
import {
  listMemoryFacts,
  writeMemoryFact,
  type MemoryWriteFileInput,
} from "../adapters/memory";
import { readDaemonPort } from "../daemon/lifecycle";
import { reindexMemory } from "./mcp";
import {
  installShippedSkills,
  type SkillInstallReport,
  type SkillTool,
} from "../adapters/skills";
import type { RepoProfile } from "../schemas/profile";
import { projectRootOrCwd } from "./project-root";
import { repairLeakedProjectConfig } from "./project-config-cleanup";

/** The vendors Hive installs skills for, and the command whose presence on PATH
 * means the user actually has that CLI. Hive does not create a `.claude/` for
 * someone who has no Claude Code: an empty vendor directory in a stranger's repo
 * is litter, not a feature. */
const VENDORS: ReadonlyArray<{ tool: SkillTool; command: string; label: string }> = [
  { tool: "claude", command: "claude", label: "Claude Code" },
  { tool: "codex", command: "codex", label: "Codex" },
];

/** A narrative fact for init to seed. Structured truth never comes through here
 * — it lives in the profile (SPEC §14). A stable id keeps a `hive init --refresh`
 * upserting the same fact in place rather than accumulating duplicates. */
export interface InitFact {
  title: string;
  body: string;
  tags?: string[];
  id?: string;
}

export interface InitOptions {
  /** Force a re-scan even when the profile is already correct. Never required —
   * every start regenerates a drifted profile on its own — so this is a debug
   * escape hatch, not a maintenance ritual. */
  refresh?: boolean;
  /** Opt-in `AGENTS.md` scaffold. Only ever writes when none exists. */
  scaffoldAgents?: boolean;
  /** Model-authored narrative facts to seed with `source: "init"`. */
  facts?: InitFact[];
  /** Replace a skill the user has edited with Hive's shipped version. Without
   * it, an edited skill is reported as drifted and left exactly as it is. */
  force?: boolean;
  /** Injected for tests; defaults to today. */
  today?: string;
}

export interface InitResult {
  /** Whether this run rebuilt the derived profile (forced, first-ever, or drifted). */
  profileWritten: boolean;
  agentsScaffolded: boolean;
  /** Ids of the facts seeded (upserted) this run. */
  factsSeeded: string[];
  /** One report per vendor CLI found on the machine. A vendor that is not
   * installed produces no report and no directory. */
  skills: SkillInstallReport[];
  messages: string[];
}

export interface InitDeps {
  ensureProfile: (root: string) => Promise<RepoProfile>;
  regenerateProfile: (root: string) => Promise<RepoProfile>;
  loadDerivedProfile: (root: string) => Promise<RepoProfile | null>;
  writeMemoryFact: (
    root: string,
    input: MemoryWriteFileInput,
  ) => Promise<{ id: string }>;
  listMemoryFacts: (root: string) => Promise<Array<{ id: string; scope: string }>>;
  fileExists: (path: string) => Promise<boolean>;
  writeFile: (path: string, contents: string) => Promise<void>;
  /** Index freshly seeded facts. Best-effort: with no daemon up there is nothing
   * to tell, because the next one rebuilds the index when it starts. */
  reindexMemory: () => Promise<void>;
  /** Is this CLI installed on the machine? A dependency so a test can decide
   * what the machine has without a real `claude` on PATH. */
  hasCli: (command: string) => boolean;
  installShippedSkills: (
    root: string,
    tool: SkillTool,
    options: { force?: boolean },
  ) => Promise<SkillInstallReport>;
  today: () => string;
}

export const defaultInitDeps: InitDeps = {
  ensureProfile,
  regenerateProfile,
  loadDerivedProfile,
  writeMemoryFact,
  listMemoryFacts,
  fileExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  writeFile: async (path, contents) => {
    await writeFile(path, contents);
  },
  reindexMemory: async () => {
    const port = readDaemonPort();
    if (port === null) return;
    await reindexMemory(port);
  },
  hasCli: (command) => Bun.which(command) !== null,
  installShippedSkills,
  today: () => new Date().toISOString().slice(0, 10),
};

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "fact";
}

/**
 * Seed narrative facts as `source: "init"`, `verified: <today>`, scope `repo`.
 * Every fact gets a stable id (explicit, or a slug of its title) so a later
 * `hive init --refresh` upserts it in place — the id-overwrite path is exactly
 * the dedup-before-write policy decision 5 requires, and re-confirming a fact
 * bumps its `verified` date while leaving earned facts untouched. Returns the
 * ids written.
 */
export async function seedInitFacts(
  root: string,
  facts: InitFact[],
  today: string,
  deps: Pick<InitDeps, "writeMemoryFact"> = defaultInitDeps,
): Promise<string[]> {
  const seeded: string[] = [];
  for (const fact of facts) {
    const id = fact.id ?? slugify(fact.title);
    const written = await deps.writeMemoryFact(root, {
      scope: "repo",
      id,
      title: fact.title,
      body: fact.body,
      tags: fact.tags ?? [],
      source: "init",
      verified: today,
    });
    seeded.push(written.id);
  }
  return seeded;
}

/** A minimal starter `AGENTS.md` derived from the profile — a starting point a
 * human refines (every vendor's `/init` frames it that way), not a template
 * pretending to be authoritative. Commands and shape come from the profile so
 * nothing here is hive-repo-specific. */
export function scaffoldAgentsMd(profile: RepoProfile): string {
  const lines = ["# Agent instructions", ""];
  lines.push(
    "Starter conventions scaffolded by `hive init` from this repo's profile.",
    "Review and refine — it captures obvious structure, not your team's nuance.",
    "",
    "## Commands",
    "",
  );
  const commands: Array<[string, string | null]> = [
    ["Build", profile.commands.build],
    ["Test", profile.commands.test],
    ["Typecheck", profile.commands.typecheck],
    ["Lint", profile.commands.lint],
    ["Run", profile.commands.run],
  ];
  for (const [label, command] of commands) {
    if (command !== null) lines.push(`- ${label}: \`${command}\``);
  }
  lines.push("");
  if (profile.conventions.language !== null || profile.conventions.packageManager !== null) {
    lines.push("## Stack", "");
    if (profile.conventions.language !== null) {
      lines.push(`- Language: ${profile.conventions.language}`);
    }
    if (profile.conventions.packageManager !== null) {
      lines.push(`- Package manager: ${profile.conventions.packageManager}`);
    }
    lines.push("");
  }
  if (profile.entryPoints.length > 0) {
    lines.push("## Entry points", "");
    for (const entry of profile.entryPoints) lines.push(`- \`${entry}\``);
    lines.push("");
  }
  if (profile.docs.primary !== null) {
    lines.push(
      "## Design",
      "",
      `The primary design doc is \`${profile.docs.primary}\`; read it by section.`,
      "",
    );
  }
  return lines.join("\n");
}

export async function runInit(
  cwd: string,
  options: InitOptions = {},
  deps: InitDeps = defaultInitDeps,
): Promise<InitResult> {
  const today = options.today ?? deps.today();
  const messages: string[] = [];

  // 1. Profile. Nothing to decide: it is generated if this repo has never been
  //    profiled and regenerated if it drifted, here exactly as on every other
  //    start. We report what was found, never what to run next.
  const before = await deps.loadDerivedProfile(cwd);
  const profile = options.refresh === true
    ? await deps.regenerateProfile(cwd)
    : await deps.ensureProfile(cwd);
  const profileWritten = options.refresh === true || before === null ||
    before.fingerprint.inputsHash !== profile.fingerprint.inputsHash;
  messages.push(
    `Profiled the repo: ${profile.docs.briefable.length} briefable doc${
      profile.docs.briefable.length === 1 ? "" : "s"
    }${profile.commands.test === null ? "" : `, tests run with \`${profile.commands.test}\``}.`,
  );

  // 2. AGENTS.md: offer to scaffold, never overwrite.
  let agentsScaffolded = false;
  if (options.scaffoldAgents === true) {
    const agentsPath = join(cwd, "AGENTS.md");
    const claudePath = join(cwd, "CLAUDE.md");
    const hasAgents = await deps.fileExists(agentsPath);
    const hasClaude = await deps.fileExists(claudePath);
    if (hasAgents) {
      messages.push("AGENTS.md already exists; leaving it untouched.");
    } else {
      await deps.writeFile(agentsPath, scaffoldAgentsMd(profile));
      agentsScaffolded = true;
      messages.push(
        hasClaude
          ? "Scaffolded AGENTS.md (a CLAUDE.md is also present; reconcile them)."
          : "Scaffolded AGENTS.md — review and refine it.",
      );
    }
  }

  // 3. Skills. Hive's own skills live in the binary (src/skills/shipped.ts), so
  //    this works on a machine that has only the binary and never consults a
  //    checkout. We install for the CLIs the user actually has, into the
  //    directory each vendor actually reads, creating `.claude/` or `.agents/`
  //    when they are missing and merging into them when they are not. Nothing
  //    the user wrote is overwritten; drift is reported, and `--force` is the
  //    only way to take Hive's copy over theirs.
  const skills: SkillInstallReport[] = [];
  const installed = VENDORS.filter((vendor) => deps.hasCli(vendor.command));
  if (installed.length === 0) {
    messages.push(
      "No Claude Code or Codex CLI found on PATH; installed no skills and created no vendor directories.",
    );
  }
  for (const vendor of installed) {
    const report = await deps.installShippedSkills(cwd, vendor.tool, {
      ...(options.force === true ? { force: true } : {}),
    });
    skills.push(report);
    const where = `${report.nativeDirectory}/${report.createdDirectory ? " (created)" : " (merged into what was already there)"}`;
    if (report.installed.length > 0) {
      messages.push(
        `${vendor.label}: installed ${report.installed.join(", ")} into ${where}`,
      );
    }
    if (report.unchanged.length > 0) {
      messages.push(
        `${vendor.label}: ${report.unchanged.join(", ")} already up to date; left alone.`,
      );
    }
    if (report.userOwned.length > 0) {
      messages.push(
        `${vendor.label}: ${report.userOwned.join(", ")} is provided by your own skills; yours wins, left alone.`,
      );
    }
    if (report.drifted.length > 0) {
      messages.push(
        `${vendor.label}: ${report.drifted.join(", ")} differs from the version Hive ships — your copy is untouched. Re-run \`hive init --force\` to take Hive's.`,
      );
    }
  }

  // 4. Seed narrative facts (source: init). Structured truth stays in the
  //    profile; only genuinely narrative knowledge is seeded here. A seeded fact
  //    that is not in the search index is not yet a fact anyone can find, so we
  //    index it now rather than printing the reindex command at someone.
  const facts = options.facts ?? [];
  const factsSeeded = facts.length === 0
    ? []
    : await seedInitFacts(cwd, facts, today, deps);
  if (factsSeeded.length > 0) {
    await deps.reindexMemory().catch(() => {
      // No daemon, or one that would not answer: the next daemon to start
      // rebuilds the index from the files on disk anyway.
    });
    messages.push(
      `Seeded and indexed ${factsSeeded.length} narrative memory fact${factsSeeded.length === 1 ? "" : "s"} (source: init).`,
    );
  }

  return { profileWritten, agentsScaffolded, factsSeeded, skills, messages };
}

/** Read a JSON array of `InitFact`s from a file, so a human or orchestrator can
 * supply model-authored narrative through the CLI. */
export async function readSeedFactsFile(path: string): Promise<InitFact[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("--seed-facts file must contain a JSON array of facts");
  }
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" || entry === null ||
      typeof (entry as { title?: unknown }).title !== "string" ||
      typeof (entry as { body?: unknown }).body !== "string"
    ) {
      throw new Error("each seed fact needs a string title and body");
    }
    const fact = entry as InitFact;
    return {
      title: fact.title,
      body: fact.body,
      ...(fact.id === undefined ? {} : { id: fact.id }),
      ...(fact.tags === undefined ? {} : { tags: fact.tags }),
    };
  });
}

/** CLI entry: `hive init [--refresh] [--scaffold-agents] [--seed-facts <path>]`.
 * Prints what it did and stops. It never ends by naming another command: the
 * profile needs no maintenance and seeded facts are indexed on the way out. */
export async function runInitCli(options: {
  /** The project root; defaults to the git toplevel of process.cwd(), so
   * `hive init` from a repo subdirectory profiles the repo, not the
   * subdirectory. */
  cwd?: string;
  refresh?: boolean;
  scaffoldAgents?: boolean;
  seedFacts?: string;
  force?: boolean;
}): Promise<void> {
  const root = options.cwd ?? projectRootOrCwd();
  const repaired = await repairLeakedProjectConfig(root);
  if (repaired.length > 0) {
    console.log(`Removed stale Hive runtime config: ${repaired.join(", ")}`);
  }
  const result = await runInitProfile(root, options);
  for (const line of result.messages) console.log(line);
}

/** Run init's profile pass. Kept separate from the session boundary so it is
 * independently testable. */
export async function runInitProfile(
  cwd: string,
  options: {
    refresh?: boolean;
    scaffoldAgents?: boolean;
    seedFacts?: string;
    force?: boolean;
  },
): Promise<InitResult> {
  const facts = options.seedFacts === undefined
    ? []
    : await readSeedFactsFile(options.seedFacts);
  return runInit(cwd, {
    ...(options.refresh === true ? { refresh: true } : {}),
    ...(options.scaffoldAgents === undefined
      ? {}
      : { scaffoldAgents: options.scaffoldAgents }),
    ...(options.force === true ? { force: true } : {}),
    facts,
  });
}
