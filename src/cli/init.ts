/** `hive init` — the gated enrichment pass. `hive init` is the work that *must* be asked for, because it writes into the user's repo or spends their tokens: - When no `AGENTS.md` exists, *offer* to scaffold a starter one (opt-in, never blind — Codex caps the AGENTS.md chain at 32 KiB and truncates silently, so we never append to a user's existing instructions). - Seed a small set of narrative memory articles with `source: "init"` and a `verified` date, derived and re-derivable — distinct from the earned facts an agent learns. - Ensure `.gitignore` covers Hive's exact derived-state paths, never the `.hive/` parent because that also contains user-authored project skills. Running the command is the authorization, and every action it takes is printed. Seeded facts are indexed immediately when a daemon is available; otherwise the report names the startup rebuild instead of claiming the index already changed. Graphify is provisioned on every run to build Hive's local code graph. A failed download or build is reported as a loud deferred state. Init also installs the probe-verified embedding runtime under ~/.hive/tools/embeddings. On a machine without network access, semantic memory stays on full-text search until a later `hive init` completes it, and the rest of init still finishes. Model-authored narrative is supplied by the caller — hive's models are its agents, not this CLI — and written through the same seeding path. */
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type BaseSkillInstallReport,
  globalSkillsRoot,
  installBaseSkills,
  unaddressedSkills,
} from "../adapters/skills";
import { expectedDaemonHandshake } from "../daemon/lifecycle/daemon-lifecycle";
import { probeDaemonReuse } from "../daemon/lifecycle/daemon-lifecycle";
import { projectStateDir } from "../daemon/project-identity-core/state";
import {
  listMemoryFacts,
  writeMemoryFact,
} from "../memory-service/memory-store";
import type { MemoryWriteFileInput } from "../memory-service/store-records";
import type { EmbeddingsInstallOutcome } from "../release/embeddings-install";
import { slugify } from "../shared/slugify";
import { ensureEmbeddingsRuntime } from "./embeddings-command";
import { provisionGraphify } from "./graphify-command";
import { reindexMemory } from "./mcp";
import { repairLeakedProjectConfig } from "./project-config-cleanup";
import { projectRootOrCwd } from "../daemon/project-identity-core/project-root";
import { scaffoldAgentStandardsMd } from "../daemon/spawn/agent-standards";
import { errorMessage } from "../shared/error-message";

/** A narrative fact for init to seed. A stable id keeps a re-run upserting the same fact in place rather than accumulating duplicates. */
export interface InitFact {
  title: string;
  body: string;
  tags?: string[];
  id?: string;
}

export interface InitOptions {
  scaffoldAgents?: boolean;
  facts?: InitFact[];
  force?: boolean;
  today?: string;
}

export interface InitResult {
  agentsScaffolded: boolean;
  standardsScaffolded: boolean;
  factsSeeded: string[];
  skills: BaseSkillInstallReport;
  messages: string[];
}

export interface InitDeps {
  writeMemoryFact: (
    root: string,
    input: MemoryWriteFileInput,
  ) => Promise<{ id: string }>;
  listMemoryFacts: (
    root: string,
  ) => Promise<Array<{ id: string; scope: string }>>;
  fileExists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, contents: string) => Promise<void>;
  reindexMemory: (root: string) => Promise<"indexed" | "deferred">;
  installBaseSkills: (
    root: string,
    options: { force?: boolean },
  ) => Promise<BaseSkillInstallReport>;
  provisionGraphify: (root: string) => Promise<number>;
  writeInitStamp: (root: string) => Promise<void>;
  installEmbeddings: () => Promise<EmbeddingsInstallOutcome>;
  today: () => string;
}

export const defaultInitDeps: InitDeps = {
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
  installBaseSkills,
  provisionGraphify,
  writeInitStamp: async (root) => {
    const path = initStampPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `# Written by \`hive init\`; bare \`hive\` checks it.\n`,
    );
  },
  installEmbeddings: ensureEmbeddingsRuntime,
  today: () => new Date().toISOString().slice(0, 10),
};

export function initStampPath(root: string): string {
  return join(projectStateDir(root), "initialized");
}

export function isRepoInitialized(root: string): boolean {
  return existsSync(initStampPath(root));
}

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
      // Seeded from the repository rather than checked by anyone: `hive init` reads the tree and writes what it inferred, which is a claim awaiting confirmation, not a confirmed one. A later session that checks it can stamp it with memory_verify.
      status: "unverified",
      supersedes: [id],
    });
    seeded.push(written.id);
  }
  return seeded;
}

/** Never collapse the first two entries into `.hive/`: that directory also contains project skills. */
export const HIVE_GITIGNORE_ENTRIES = [
  ".hive/memory/",
  ".hive/worktrees/",
  "graphify-out/",
  ".graphifyignore",
] as const;

function normalizedGitignoreLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) {
    return null;
  }
  return trimmed.replace(/^\//, "").replace(/\/+$/, "");
}

function gitignoreContains(entry: string, lines: readonly string[]): boolean {
  const wanted = entry.replace(/\/+$/, "");
  return lines.some((line) => normalizedGitignoreLine(line) === wanted);
}

/** Ensure the project's `.gitignore` contains every Hive derived-state entry. Existing content is never reordered or rewritten; only missing entries are appended. */
export async function ensureHiveStateGitignored(
  cwd: string,
  deps: Pick<
    InitDeps,
    "fileExists" | "readFile" | "writeFile"
  > = defaultInitDeps,
): Promise<string> {
  const path = join(cwd, ".gitignore");
  const exists = await deps.fileExists(path);
  const existing = exists ? await deps.readFile(path) : "";
  const lines = existing.split(/\r?\n/);
  const missing = HIVE_GITIGNORE_ENTRIES.filter(
    (entry) => !gitignoreContains(entry, lines),
  );
  if (missing.length === 0)
    return ".gitignore already covers Hive's local state.";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await deps.writeFile(
    path,
    `${existing}${separator}${existing === "" ? "" : "\n"}# Hive local state\n${missing.join("\n")}\n`,
  );
  return `${exists ? "Updated" : "Created"} .gitignore with Hive's local derived-state entries.`;
}

/** A minimal starter `AGENTS.md` — a starting point a user refines (every vendor's `/init` frames it that way), not a template pretending to be authoritative. Hive does not detect this repo's commands, stack, or design docs, so those sections are prompts to fill in, never invented values. */
export function scaffoldAgentsMd(): string {
  return [
    "# Agent instructions",
    "",
    "Starter conventions scaffolded by `hive init`. Review and fill these in —",
    "it is a starting point, not your team's nuance.",
    "",
    "## Commands",
    "",
    "Document how this repo builds, tests, lints, and runs.",
    "",
    "## Stack",
    "",
    "Note the language, package manager, and anything an agent should assume.",
    "",
  ].join("\n");
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
      await deps.writeFile(agentsPath, scaffoldAgentsMd());
      agentsScaffolded = true;
      messages.push(
        hasClaude
          ? "Scaffolded AGENTS.md (a CLAUDE.md is also present; reconcile them)."
          : "Scaffolded AGENTS.md — review and refine it.",
      );
    }
  }

  // 2. Skills. Hive's own skills live in the binary (src/skills/shipped.ts), so this works on a machine that has only the binary and never consults a checkout. They install into `.hive/skills/` at the same addresses a person writes by hand, beside the skills they wrote — one directory that answers "what do my agents know", rather than Hive's half of the answer living inside the binary and appearing only inside a worktree. No vendor needs to be installed for this to be right: an address carries its own vendor. Nothing the user wrote is overwritten; drift is reported, and `--force` is the only way to take Hive's copy over theirs.
  const skills = await deps.installBaseSkills(
    cwd,
    options.force === true ? { force: true } : {},
  );
  if (skills.installed.length > 0) {
    messages.push(
      `Skills: installed ${skills.installed.join(", ")} into .hive/skills/`,
    );
  }
  if (skills.unchanged.length > 0) {
    messages.push(
      `Skills: ${skills.unchanged.join(", ")} already up to date; left alone.`,
    );
  }
  if (skills.drifted.length > 0) {
    messages.push(
      `Skills: ${skills.drifted.join(", ")} differs from the version Hive ships — your copy is untouched. Re-run \`hive init --force\` to take Hive's.`,
    );
  }
  // A skill at an address nobody reads is the one failure this layout can hide, so it is named here with the path rather than left to be noticed.
  for (const root of [join(cwd, ".hive", "skills"), globalSkillsRoot()]) {
    const orphans = await unaddressedSkills(root).catch(() => []);
    if (orphans.length > 0) {
      messages.push(
        `⚠ ${root}: ${orphans.join(", ")} — no role bucket, so nobody is given ${
          orphans.length === 1 ? "it" : "them"
        }. Move each under queen/ or agent/.`,
      );
    }
  }

  // 3. AGENT_STANDARDS.md: spawn requires standing procedure. A missing file
  // used to refuse every worker. Write the generic product scaffold once;
  // never overwrite a file the project already owns.
  const standardsPath = join(cwd, "AGENT_STANDARDS.md");
  let standardsScaffolded = false;
  if (await deps.fileExists(standardsPath)) {
    messages.push("AGENT_STANDARDS.md already exists; leaving it untouched.");
  } else {
    await deps.writeFile(standardsPath, scaffoldAgentStandardsMd());
    standardsScaffolded = true;
    messages.push(
      "Scaffolded AGENT_STANDARDS.md with generic Hive protocol — edit it as this repo's standing procedure.",
    );
  }

  // 4. .gitignore: Hive's exact generated paths are local derived state. Never write a bare `.hive/`: project skills under it belong in version control.
  messages.push(await ensureHiveStateGitignored(cwd, deps));

  const facts = options.facts ?? [];
  const factsSeeded =
    facts.length === 0 ? [] : await seedInitFacts(cwd, facts, today, deps);
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
        `Seeded ${articles} (source: init), but memory indexing failed: ${errorMessage(
          error,
        )}\nFix: after the daemon starts, run \`hive memory reindex\`.`,
      );
    }
  }

  // 5. Embedding runtime. Init installs the local semantic-memory tool. When setup cannot complete, the message names `hive init` as the retry and recall stays on full-text search in the meantime.
  messages.push(await provisionEmbeddings(deps));

  const graphifyExit = await deps.provisionGraphify(cwd);
  messages.push(
    graphifyExit === 0
      ? "Graphify: ready — agents get a local, code-only knowledge graph."
      : "⚠ GRAPHIFY UNAVAILABLE — Hive initialized in a degraded state. Run `hive init` again to repair it.",
  );

  await deps.writeInitStamp(cwd);

  return {
    agentsScaffolded,
    standardsScaffolded,
    factsSeeded,
    skills,
    messages,
  };
}

const EMBEDDINGS_FIX_HINT = "re-run `hive init` once the cause is fixed";

async function provisionEmbeddings(deps: InitDeps): Promise<string> {
  let outcome: EmbeddingsInstallOutcome;
  try {
    outcome = await deps.installEmbeddings();
  } catch (error) {
    outcome = {
      ok: false,
      reason: errorMessage(error),
    };
  }
  if (outcome.ok) return `Embeddings: ${outcome.detail}.`;
  return [
    "⚠ EMBEDDINGS NOT INSTALLED — Hive memory is DEGRADED: semantic recall is",
    `unavailable and search is FTS-only until the runtime lands (${outcome.reason}).`,
    `This is not a supported end state; ${EMBEDDINGS_FIX_HINT}.`,
  ].join("\n");
}

export async function readSeedFactsFile(path: string): Promise<InitFact[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("--seed-facts file must contain a JSON array of facts");
  }
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
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

export async function runInitCli(options: {
  cwd?: string;
  scaffoldAgents?: boolean;
  seedFacts?: string;
  force?: boolean;
}): Promise<void> {
  const root = options.cwd ?? projectRootOrCwd();
  const repaired = await repairLeakedProjectConfig(root);
  if (repaired.length > 0) {
    console.log(`Removed stale Hive runtime config: ${repaired.join(", ")}`);
  }
  const facts =
    options.seedFacts === undefined
      ? []
      : await readSeedFactsFile(options.seedFacts);
  const result = await runInit(root, {
    ...(options.scaffoldAgents === undefined
      ? {}
      : { scaffoldAgents: options.scaffoldAgents }),
    ...(options.force === true ? { force: true } : {}),
    facts,
  });
  for (const line of result.messages) console.log(line);
}
