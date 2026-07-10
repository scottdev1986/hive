/**
 * `hive init` — the richer, gated profiling pass (SPEC.md decision 14).
 *
 * The deterministic bootstrap used by every session boundary already
 * un-hardcodes the brief mechanism for zero quota. `hive init` is the pass that
 * does what the bootstrap cannot and must be paid for or confirmed:
 *   - (Re)write the profile, refreshing its fingerprint against the current tree
 *     (`--refresh` re-scans even when a profile already exists).
 *   - When no `AGENTS.md` exists, *offer* to scaffold one (opt-in, never blind —
 *     Codex caps the AGENTS.md chain at 32 KiB and truncates silently, so we
 *     never append to a human's existing instructions).
 *   - Seed a small set of narrative memory facts with `source: "init"` and a
 *     `verified` date (decision 5's provenance), derived and re-derivable —
 *     distinct from the earned facts an agent learns. Structured facts never
 *     become memory; they are already in the profile.
 *
 * It is human- or orchestrator-gated and never silent: running the command is
 * the authorization, and every action it takes is printed. Model-authored
 * narrative (the conventions summary, inferred gotchas) is supplied by the
 * caller — hive's models are its agents, not this CLI — and written through the
 * same seeding path, so the seam with the memory store (decision 5) is exercised
 * whether the facts came from a human, an agent, or a `--seed-facts` file.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapProfile,
  evaluateProfile,
  loadProfile,
  PROFILE_RELATIVE_PATH,
  writeProfile,
} from "../adapters/profile";
import {
  listMemoryFacts,
  writeMemoryFact,
  type MemoryWriteFileInput,
} from "../adapters/memory";
import type { RepoProfile } from "../schemas/profile";

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
  /** Re-scan and rewrite an existing profile, not just fill in a missing one. */
  refresh?: boolean;
  /** Opt-in `AGENTS.md` scaffold. Only ever writes when none exists. */
  scaffoldAgents?: boolean;
  /** Model-authored narrative facts to seed with `source: "init"`. */
  facts?: InitFact[];
  /** Injected for tests; defaults to today. */
  today?: string;
}

export interface InitResult {
  profileWritten: boolean;
  agentsScaffolded: boolean;
  /** Ids of the facts seeded (upserted) this run. */
  factsSeeded: string[];
  messages: string[];
}

export interface InitDeps {
  loadProfile: (root: string) => Promise<RepoProfile | null>;
  bootstrapProfile: (root: string) => Promise<RepoProfile>;
  writeProfile: (root: string, profile: RepoProfile) => Promise<void>;
  writeMemoryFact: (
    root: string,
    input: MemoryWriteFileInput,
  ) => Promise<{ id: string }>;
  listMemoryFacts: (root: string) => Promise<Array<{ id: string; scope: string }>>;
  fileExists: (path: string) => Promise<boolean>;
  writeFile: (path: string, contents: string) => Promise<void>;
  today: () => string;
}

const defaultDeps: InitDeps = {
  loadProfile,
  bootstrapProfile,
  writeProfile,
  writeMemoryFact,
  listMemoryFacts,
  fileExists: async (path) => {
    try {
      await readFile(path, "utf8");
      return true;
    } catch {
      return false;
    }
  },
  writeFile: async (path, contents) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, contents);
  },
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
  deps: Pick<InitDeps, "writeMemoryFact"> = defaultDeps,
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
  deps: InitDeps = defaultDeps,
): Promise<InitResult> {
  const today = options.today ?? deps.today();
  const messages: string[] = [];

  // 1. Profile: write when missing, or re-scan on --refresh.
  const existing = await deps.loadProfile(cwd);
  let profile = existing;
  let profileWritten = false;
  if (existing === null || options.refresh === true) {
    profile = await deps.bootstrapProfile(cwd);
    await deps.writeProfile(cwd, profile);
    profileWritten = true;
    messages.push(
      existing === null
        ? `Wrote ${PROFILE_RELATIVE_PATH}.`
        : `Refreshed ${PROFILE_RELATIVE_PATH} against the current tree.`,
    );
  } else {
    messages.push(
      `${PROFILE_RELATIVE_PATH} is already present; pass --refresh to re-scan.`,
    );
  }

  // 2. AGENTS.md: offer to scaffold, never overwrite. `profile` is non-null here.
  let agentsScaffolded = false;
  if (options.scaffoldAgents === true && profile !== null) {
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

  // 3. Seed narrative facts (source: init). Structured truth stays in the
  //    profile; only genuinely narrative knowledge is seeded here.
  const facts = options.facts ?? [];
  const factsSeeded = facts.length === 0
    ? []
    : await seedInitFacts(cwd, facts, today, deps);
  if (factsSeeded.length > 0) {
    messages.push(
      `Seeded ${factsSeeded.length} narrative memory fact${factsSeeded.length === 1 ? "" : "s"} (source: init).`,
    );
  }

  return { profileWritten, agentsScaffolded, factsSeeded, messages };
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

/** CLI entry: `hive init [--refresh] [--scaffold-agents] [--seed-facts <path>]`. */
export async function runInitCli(options: {
  refresh?: boolean;
  scaffoldAgents?: boolean;
  seedFacts?: string;
}): Promise<void> {
  const result = await runInitProfile(process.cwd(), options);
  for (const line of result.messages) console.log(line);
  if (result.factsSeeded.length > 0) {
    console.log(
      "Run `hive memory reindex` (or restart the daemon) to index the seeded facts.",
    );
  }
}

/** Apply the CLI policy: a normal init refreshes a stale profile automatically;
 * `--refresh` forces the same pass. Session startup remains at registration so
 * this profile operation is independently testable. */
export async function runInitProfile(
  cwd: string,
  options: { refresh?: boolean; scaffoldAgents?: boolean; seedFacts?: string },
): Promise<InitResult> {
  // Ordinary init refreshes only when declared inputs drift. `--refresh`
  // forces that same profile pass and is handled by the command registration
  // as profile-only (no session start).
  const status = await evaluateProfile(cwd);
  const refresh = options.refresh === true || status.state === "stale";
  const facts = options.seedFacts === undefined
    ? []
    : await readSeedFactsFile(options.seedFacts);
  return runInit(cwd, {
    ...(refresh ? { refresh: true } : {}),
    ...(options.scaffoldAgents === undefined
      ? {}
      : { scaffoldAgents: options.scaffoldAgents }),
    facts,
  });
}
