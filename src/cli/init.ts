/**
 * `hive init` — the gated enrichment pass (SPEC.md decision 14).
 *
 * `hive init` is the work that *must* be asked for, because it writes into the
 * user's repo or spends their tokens:
 *   - When no `AGENTS.md` exists, *offer* to scaffold a starter one (opt-in,
 *     never blind — Codex caps the AGENTS.md chain at 32 KiB and truncates
 *     silently, so we never append to a human's existing instructions).
 *   - Seed a small set of narrative memory articles with `source: "init"` and a
 *     `verified` date (decision 5's provenance), derived and re-derivable —
 *     distinct from the earned facts an agent learns.
 *   - Ensure `.gitignore` covers `.hive/memory/` (user ruling 2026-07-22, board
 *     issue #78): repo memory is daemon-written derived state, never committed.
 *     The entry is exactly `.hive/memory/` — never a bare `.hive/` entry.
 *
 * Running the command is the authorization, and every action it takes is
 * printed. Seeded facts are indexed immediately when a daemon is available;
 * otherwise the report names the startup rebuild instead of claiming the index
 * already changed.
 * Graphify is the one decision that is the human's, and init is where it gets
 * made: `--graphify`/`--no-graphify` always win and never prompt; with no flag
 * a TTY is asked once (recommended, default yes) and a non-TTY safely declines
 * for the run with one line naming the enable command — so `hive init` stays
 * scriptable while a human at a terminal gets the recommended choice.
 * Model-authored narrative is supplied by the caller — hive's models are its
 * agents, not this CLI — and written through the same seeding path.
 */
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  discoverBriefableDocs,
  type BriefableDocs,
} from "../adapters/briefing-docs";
import { projectStateDir } from "../daemon/project-state";
import {
  listMemoryFacts,
  writeMemoryFact,
  type MemoryWriteFileInput,
} from "../adapters/memory";
import {
  graphifyDecisionRecorded,
  graphifyPin,
  readGraphifyState,
  writeGraphifyState,
  type GraphifyState,
} from "../adapters/graphify";
import { graphifyArtifact } from "../adapters/graphify-artifacts";
import { probeDaemonReuse } from "../daemon/lifecycle";
import { expectedDaemonHandshake } from "../daemon/handshake";
import { reindexMemory } from "./mcp";
import {
  installShippedSkills,
  type SkillInstallReport,
  type SkillTool,
} from "../adapters/skills";
import { CAPABILITY_PROVIDERS } from "../schemas";
import { runGraphifyEnable } from "./graphify";
import { confirmOnTty, type ConfirmFn } from "./prompt";
import { projectRootOrCwd } from "./project-root";
import { repairLeakedProjectConfig } from "./project-config-cleanup";

/** The vendors Hive installs skills for, and the command whose presence on PATH
 * means the user actually has that CLI. Hive does not create a `.claude/` for
 * someone who has no Claude Code: an empty vendor directory in a stranger's repo
 * is litter, not a feature. */
const VENDORS: Record<SkillTool, { command: string; label: string }> = {
  claude: { command: "claude", label: "Claude Code" },
  codex: { command: "codex", label: "Codex" },
  grok: { command: "grok", label: "Grok" },
};

/** A narrative fact for init to seed. A stable id keeps a re-run upserting the
 * same fact in place rather than accumulating duplicates. */
export interface InitFact {
  title: string;
  body: string;
  tags?: string[];
  id?: string;
}

export interface InitOptions {
  /** Opt-in `AGENTS.md` scaffold. Only ever writes when none exists. */
  scaffoldAgents?: boolean;
  /** Model-authored narrative facts to seed with `source: "init"`. */
  facts?: InitFact[];
  /** Replace a skill the user has edited with Hive's shipped version. Without
   * it, an edited skill is reported as drifted and left exactly as it is. */
  force?: boolean;
  /** The graphify decision, from `--graphify` / `--no-graphify`. Flags always
   * win and never prompt; undefined means undecided, which prompts on a TTY
   * and safely declines (with one line saying how to enable) everywhere else. */
  graphify?: boolean;
  /** Injected for tests; defaults to today. */
  today?: string;
}

export interface InitResult {
  agentsScaffolded: boolean;
  /** Ids of the facts seeded (upserted) this run. */
  factsSeeded: string[];
  /** One report per vendor CLI found on the machine. A vendor that is not
   * installed produces no report and no directory. */
  skills: SkillInstallReport[];
  messages: string[];
}

export interface InitDeps {
  /** Discover the repo's briefable docs, so a scaffolded AGENTS.md can point at
   * the primary design doc. The only surviving repo-detection init does. */
  discoverBriefableDocs: (root: string) => Promise<BriefableDocs>;
  writeMemoryFact: (
    root: string,
    input: MemoryWriteFileInput,
  ) => Promise<{ id: string }>;
  listMemoryFacts: (root: string) => Promise<Array<{ id: string; scope: string }>>;
  fileExists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, contents: string) => Promise<void>;
  /** The next daemon rebuilds the index when no daemon is available yet. */
  reindexMemory: (root: string) => Promise<"indexed" | "deferred">;
  /** Is this CLI installed on the machine? A dependency so a test can decide
   * what the machine has without a real `claude` on PATH. */
  hasCli: (command: string) => boolean;
  installShippedSkills: (
    root: string,
    tool: SkillTool,
    options: { force?: boolean; coresidentVendors?: readonly SkillTool[] },
  ) => Promise<SkillInstallReport>;
  /** Where the opt-in graphify decision stands, so init can report it. */
  readGraphifyState: (root: string) => Promise<GraphifyState>;
  /** Whether a decision (either way) was ever recorded, so init asks once. */
  graphifyDecisionRecorded: (root: string) => boolean;
  /** Whether this Hive build ships a graphify bundle for this platform. When
   * it does not, there is nothing to ask: init prints one line instead. */
  graphifyAvailable: () => boolean;
  /** Ask on a TTY; null means there is no terminal to ask. */
  confirm: ConfirmFn;
  /** The scriptable enable everything resolves to (`hive graphify enable`). */
  enableGraphify: (root: string) => Promise<number>;
  /** Persist an explicit "no" so the question is not re-asked forever. */
  writeGraphifyState: (root: string, state: GraphifyState) => Promise<void>;
  /** Record that init completed here, so bare `hive` stops offering to init. */
  writeInitStamp: (root: string) => Promise<void>;
  today: () => string;
}

export const defaultInitDeps: InitDeps = {
  discoverBriefableDocs,
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
  readFile: (path) => readFile(path, "utf8"),
  reindexMemory: async (root) => {
    const daemon = await probeDaemonReuse(await expectedDaemonHandshake(root));
    if (daemon.state !== "authorized") return "deferred";
    await reindexMemory(daemon.port);
    return "indexed";
  },
  hasCli: (command) => Bun.which(command) !== null,
  installShippedSkills,
  readGraphifyState,
  graphifyDecisionRecorded,
  graphifyAvailable: () => graphifyArtifact() !== null,
  confirm: confirmOnTty,
  enableGraphify: (root) => runGraphifyEnable(root),
  writeGraphifyState,
  writeInitStamp: async (root) => {
    const path = initStampPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `# Written by \`hive init\`; bare \`hive\` checks it.\n`);
  },
  today: () => new Date().toISOString().slice(0, 10),
};

/** The marker `hive init` leaves in the project's derived-state dir. Bare
 * `hive` reads it to know whether this repo ever completed the init flow.
 * Deleting it (or the state dir, as `hive uninstall --repo` does) makes bare
 * `hive` offer init again, which is exactly right. */
export function initStampPath(root: string): string {
  return join(projectStateDir(root), "initialized");
}

export function isRepoInitialized(root: string): boolean {
  return existsSync(initStampPath(root));
}

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
 * `hive init` re-run upserts it in place — the id-overwrite path is exactly the
 * dedup-before-write policy decision 5 requires, and re-confirming a fact bumps
 * its `verified` date while leaving earned facts untouched. Returns the ids
 * written.
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
      topic: "project",
      title: fact.title,
      body: fact.body,
      tags: fact.tags ?? [],
      date: today,
      source: "init",
      evidence: "Derived by hive init from the current repository",
      status: "verified",
      supersedes: [id],
      verified: today,
    });
    seeded.push(written.id);
  }
  return seeded;
}

/** The exact entry board issue #78 settled on. Never a bare `.hive/` — a
 * parent-dir entry caused a worktree-deletion incident. */
export const HIVE_MEMORY_GITIGNORE_ENTRY = ".hive/memory/";

/** Does this .gitignore line already cover `.hive/memory/`? Exact forms (with
 * or without a leading/trailing slash) and the broader `.hive/` / `.hive/*`
 * entries all count; negations and comments do not. */
function gitignoreCoversHiveMemory(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) {
    return false;
  }
  const normalized = trimmed.replace(/^\//, "").replace(/\/+$/, "");
  return normalized === ".hive/memory" ||
    normalized === ".hive" ||
    normalized === ".hive/*";
}

/**
 * Ensure the project's `.gitignore` ignores `.hive/memory/`. Idempotent: any
 * existing covering entry leaves the file byte-for-byte untouched; otherwise the
 * entry is appended under a `# Hive memory` header without rewriting or
 * reordering existing content; a missing `.gitignore` is created.
 */
export async function ensureHiveMemoryGitignored(
  cwd: string,
  deps: Pick<InitDeps, "fileExists" | "readFile" | "writeFile"> = defaultInitDeps,
): Promise<string> {
  const path = join(cwd, ".gitignore");
  if (!(await deps.fileExists(path))) {
    await deps.writeFile(path, `# Hive memory\n${HIVE_MEMORY_GITIGNORE_ENTRY}\n`);
    return "Created .gitignore with a `.hive/memory/` entry (Hive memory is derived state, never committed).";
  }
  const existing = await deps.readFile(path);
  if (existing.split(/\r?\n/).some(gitignoreCoversHiveMemory)) {
    return ".gitignore already covers `.hive/memory/`; left untouched.";
  }
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await deps.writeFile(
    path,
    `${existing}${separator}\n# Hive memory\n${HIVE_MEMORY_GITIGNORE_ENTRY}\n`,
  );
  return "Appended `.hive/memory/` to .gitignore (Hive memory is derived state, never committed).";
}

/** A minimal starter `AGENTS.md` — a starting point a human refines (every
 * vendor's `/init` frames it that way), not a template pretending to be
 * authoritative. Hive does not detect this repo's commands or stack, so those
 * sections are prompts to fill in, never invented values. The one thing it can
 * name is the repo's primary design doc, discovered from the tree. */
export function scaffoldAgentsMd(primaryDoc: string | null): string {
  const lines = [
    "# Agent instructions",
    "",
    "Starter conventions scaffolded by `hive init`. Review and fill these in —",
    "it is a starting point, not your team's nuance.",
    "",
    "## Commands",
    "",
    "Document how this repo builds, tests, typechecks, lints, and runs.",
    "",
    "## Stack",
    "",
    "Note the language, package manager, and anything an agent should assume.",
    "",
  ];
  if (primaryDoc !== null) {
    lines.push(
      "## Design",
      "",
      `The primary design doc is \`${primaryDoc}\`; read it by section.`,
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

  // 1. AGENTS.md: offer to scaffold, never overwrite.
  let agentsScaffolded = false;
  if (options.scaffoldAgents === true) {
    const agentsPath = join(cwd, "AGENTS.md");
    const claudePath = join(cwd, "CLAUDE.md");
    const hasAgents = await deps.fileExists(agentsPath);
    const hasClaude = await deps.fileExists(claudePath);
    if (hasAgents) {
      messages.push("AGENTS.md already exists; leaving it untouched.");
    } else {
      // The one repo fact a starter can name without inventing anything: the
      // primary design doc, discovered from the tree.
      const docs = await deps.discoverBriefableDocs(cwd).catch(() => null);
      await deps.writeFile(agentsPath, scaffoldAgentsMd(docs?.primary ?? null));
      agentsScaffolded = true;
      messages.push(
        hasClaude
          ? "Scaffolded AGENTS.md (a CLAUDE.md is also present; reconcile them)."
          : "Scaffolded AGENTS.md — review and refine it.",
      );
    }
  }

  // 2. Skills. Hive's own skills live in the binary (src/skills/shipped.ts), so
  //    this works on a machine that has only the binary and never consults a
  //    checkout. We install for the CLIs the user actually has, into the
  //    directory each vendor actually reads, creating `.claude/` or `.agents/`
  //    when they are missing and merging into them when they are not. Nothing
  //    the user wrote is overwritten; drift is reported, and `--force` is the
  //    only way to take Hive's copy over theirs.
  const skills: SkillInstallReport[] = [];
  // Keyed by the vendor union rather than a hand-written list: a vendor with no
  // row is a compile error here, not a CLI Hive quietly never looks for.
  const installed = CAPABILITY_PROVIDERS
    .map((tool) => ({ tool, ...VENDORS[tool] }))
    .filter((vendor) => deps.hasCli(vendor.command));
  if (installed.length === 0) {
    messages.push(
      "No Claude Code, Codex, or Grok CLI found on PATH; installed no skills and created no vendor directories.",
    );
  }
  for (const vendor of installed) {
    // Every CLI on this machine writes into the same repo root, and vendors do
    // not each get their own directory — Grok reads `.agents/skills`, which is
    // where Codex reads too. So a skill installed "for Codex" here is read by
    // Grok as well, and Hive's vendor contract is addressed to neither of them
    // in that case. Passing the detected CLIs is what lets the installer
    // withhold a contract from a directory a second vendor also reads.
    const report = await deps.installShippedSkills(cwd, vendor.tool, {
      ...(options.force === true ? { force: true } : {}),
      coresidentVendors: installed.map((other) => other.tool),
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
    if (report.withheld.length > 0) {
      // Said out loud, because a skill that quietly did not install reads
      // exactly like one that failed to. The agents Hive spawns still get their
      // contract: it is written into each worktree at spawn, where one vendor
      // reads one directory.
      messages.push(
        `${vendor.label}: left ${report.withheld.join(", ")} out of ${report.nativeDirectory}/ — another installed CLI reads that directory too, and this skill is not addressed to it. Agents still get it in their own worktree.`,
      );
    }
    if (report.drifted.length > 0) {
      messages.push(
        `${vendor.label}: ${report.drifted.join(", ")} differs from the version Hive ships — your copy is untouched. Re-run \`hive init --force\` to take Hive's.`,
      );
    }
  }

  // 3. .gitignore: `.hive/memory/` is daemon-written derived state and must
  //    never be committed. The entry is exactly `.hive/memory/` — never a bare
  //    `.hive/` entry (a parent-dir entry caused a worktree-deletion incident;
  //    board issue #78). Idempotent: any line that already covers the directory
  //    counts, and an existing .gitignore is only ever appended to.
  messages.push(await ensureHiveMemoryGitignored(cwd, deps));

  // 4. Seed narrative facts (source: init): genuinely narrative knowledge an
  //    agent should start with, distinct from the facts an agent earns.
  const facts = options.facts ?? [];
  const factsSeeded = facts.length === 0
    ? []
    : await seedInitFacts(cwd, facts, today, deps);
  if (factsSeeded.length > 0) {
    const articles = `${factsSeeded.length} narrative memory article${
      factsSeeded.length === 1 ? "" : "s"
    }`;
    try {
      const indexing = await deps.reindexMemory(cwd);
      messages.push(
        indexing === "indexed"
          ? `Seeded and indexed ${articles} (source: init).`
          : `Seeded ${articles} (source: init); the daemon will rebuild the memory index when it starts.`,
      );
    } catch (error) {
      messages.push(
        `Seeded ${articles} (source: init), but memory indexing failed: ${
          error instanceof Error ? error.message : String(error)
        }\nFix: after the daemon starts, run \`hive memory reindex\`.`,
      );
    }
  }

  // 5. Graphify. The choice is the human's, and init is where it gets made:
  //    flags always win and never prompt; a TTY without a flag is asked once
  //    (recommended, default yes); non-interactive without a flag safely
  //    declines for this run and says how to enable. An enable failure is
  //    reported and init continues — nothing in init ever blocks on graphify.
  messages.push(await decideGraphify(cwd, options.graphify, deps));

  await deps.writeInitStamp(cwd);

  return { agentsScaffolded, factsSeeded, skills, messages };
}

const GRAPHIFY_ENABLED_LINE =
  "Graphify: enabled — agents get a local, code-only knowledge graph.";
const GRAPHIFY_LATER_HINT = "`hive graphify enable` turns it on any time.";

function graphifyQuestion(): string {
  return [
    "Graphify (recommended) gives agents a local code knowledge graph of this repo.",
    `Yes installs Hive's graphify bundle (graphifyy==${graphifyPin()}, sha256-verified from Hive's own release) under ~/.hive/tools`,
    "and builds graphify-out/ here. Code is parsed locally — no LLM calls, nothing leaves this machine.",
    "Enable graphify?",
  ].join("\n");
}

async function decideGraphify(
  cwd: string,
  flag: boolean | undefined,
  deps: InitDeps,
): Promise<string> {
  const state = await deps.readGraphifyState(cwd);
  if (state.enabled) return GRAPHIFY_ENABLED_LINE;

  const enable = async (): Promise<string> =>
    (await deps.enableGraphify(cwd)) === 0
      ? GRAPHIFY_ENABLED_LINE
      : "Graphify: could not be enabled (details above); everything else is ready. " +
        GRAPHIFY_LATER_HINT;
  const decline = async (): Promise<string> => {
    await deps.writeGraphifyState(cwd, { enabled: false, pin: null });
    return `Graphify: declined. ${GRAPHIFY_LATER_HINT}`;
  };

  if (flag === true) return enable();
  if (flag === false) return decline();
  if (deps.graphifyDecisionRecorded(cwd)) {
    return `Graphify: not enabled (declined earlier). ${GRAPHIFY_LATER_HINT}`;
  }
  if (!deps.graphifyAvailable()) {
    return (
      "Graphify: no bundle is published for this platform in this Hive build; " +
      "everything else works identically."
    );
  }
  const answer = await deps.confirm(graphifyQuestion(), true);
  if (answer === null) {
    return (
      "Graphify: not installed (non-interactive, no --graphify flag given). " +
      "`hive init --graphify` or `hive graphify enable` installs it."
    );
  }
  return answer ? enable() : decline();
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

/** CLI entry: `hive init [--scaffold-agents] [--seed-facts <path>]`.
 * Prints what it did and stops. */
export async function runInitCli(options: {
  /** The project root; defaults to the git toplevel of process.cwd(), so
   * `hive init` from a repo subdirectory initializes the repo, not the
   * subdirectory. */
  cwd?: string;
  scaffoldAgents?: boolean;
  seedFacts?: string;
  force?: boolean;
  graphify?: boolean;
}): Promise<void> {
  const root = options.cwd ?? projectRootOrCwd();
  const repaired = await repairLeakedProjectConfig(root);
  if (repaired.length > 0) {
    console.log(`Removed stale Hive runtime config: ${repaired.join(", ")}`);
  }
  const facts = options.seedFacts === undefined
    ? []
    : await readSeedFactsFile(options.seedFacts);
  const result = await runInit(root, {
    ...(options.scaffoldAgents === undefined
      ? {}
      : { scaffoldAgents: options.scaffoldAgents }),
    ...(options.force === true ? { force: true } : {}),
    ...(options.graphify === undefined ? {} : { graphify: options.graphify }),
    facts,
  });
  for (const line of result.messages) console.log(line);
}
