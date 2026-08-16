// agent-standards.ts Reads the standing engineering and protocol rules that every spawn prompt carries, from AGENT_STANDARDS.md in the primary checkout. The rules used to be string constants in the spawner. That made a wording change a code change: commit, review, land, promote, restart — and a promote kills every working agent. Standards belong to the project, so they live in a committed file the user edits directly and a spawn reads. The file declares its own sections, and each declaration names the audience that section is for. Nothing here knows which categories a project has: this module knows only HOW to route — to everyone, to writers, to read-only agents, or to one routing category — and the project says WHICH of those each of its sections wants. Adding a category is an edit to the file; adding a way to route is a change here, and those are different kinds of decision on purpose. Every failure to produce complete standards throws. There is no fallback text: an agent that spawned without its standards would behave subtly wrong for a whole session with nothing in the logs to say why, and a refused spawn is the cheaper failure by a wide margin. That is why the declaration exists at all rather than the file simply being a bag of sections — a section that disappears from a file nobody declared anything about disappears silently, and silence is the failure this module was written to prevent.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ROUTING_CATEGORIES,
  type RoutingCategory,
  RoutingCategorySchema,
} from "../../schemas/routing-policy";

export type StandardsAudience =
  | { kind: "everyone" }
  | { kind: "writers" }
  | { kind: "read-only" }
  | { kind: "category"; category: RoutingCategory };

export interface AgentStandardsSection {
  heading: string;
  audience: StandardsAudience;
  text: string;
}

export interface AgentStandards {
  sections: readonly AgentStandardsSection[];
}

export interface AgentAudienceFacts {
  readOnly: boolean;
  category?: RoutingCategory;
}

export const AGENT_STANDARDS_FILE = "AGENT_STANDARDS.md";

/**
 * Product standards for a repository that has not written its own yet.
 * Hive protocol only — no bun, typecheck, or any other toolchain. Init
 * writes this file when it is missing; spawn uses it in memory when the
 * file is absent so a stranger's repo can start workers.
 */
export function scaffoldAgentStandardsMd(): string {
  return [
    "# Agent standards",
    "",
    "Generic Hive product standards, scaffolded by `hive init`. This file is",
    "this repository's standing procedure. Edit it as you learn how this",
    "project works. Hive does not assume bun or any other toolchain.",
    "",
    "```standards",
    "Hive protocol: everyone",
    "Writer agents: writers",
    "Read-only agents: read-only",
    "```",
    "",
    "## Hive protocol",
    "",
    "Hive protocol (non-negotiable):",
    '1. An absent field is unknown, never false. A missing or misspelled key does not raise — it reads back as "no". Before trusting a negative, prove your reader can see a positive (a positive control): an all-empty result is usually a bad key, not an empty world.',
    '2. Measure, do not infer. Never accept an ACT as proof of a STATE: "the command exited 0" is not "the message was received"; "the skill shipped" is not "the agent read it"; "the screen redrew" is not "the agent is alive". Read the thing that records the state.',
    "3. Skills live in the primary checkout, not an agent worktree. Resolve and read them there.",
    "4. Full deliverables go into the artifact store, not into mail. Store reports, designs, reviews, and findings with `hive_artifact_put` keyed to your board task or run; your mail to queen carries the `artifactId` plus a short summary, never the full body. Settled mail bodies cannot be read again — an artifact can. Status, completions, and measurements go on the work lane; the control lane is for a design fork, a scope change, a rebase conflict, or an irreversible destroy/salvage decision. Do not wait for GO or a reply to status.",
    "",
    "## Writer agents",
    "",
    "Complete writer work must be committed, verified after rebasing the primary checkout's current branch using this repository's own verification, and landed through hive_land. Do not wait for queen to authorise the landing. Learn what \"green\" means from this file, AGENTS.md, and Hive memory — never from a compiled-in toolchain. If no verification command is known, discover it from the tree and record it with memory_write (topic verification) before treating it as standing procedure. Abort and report any rebase conflict; never merge into the primary checkout directly.",
    "",
    "## Read-only agents",
    "",
    "This process is capability-enforced read-only: it may read the repo, run permitted read-only commands, use MCP tools, and report with hive_mail_publish. It cannot change the worktree or land its branch. Persist findings in durable Hive messages; do not attempt a commit.",
    "",
  ].join("\n");
}

export const VERIFICATION_SECTION = "Verification";
const GENERIC_STANDARDS_MARKER =
  "Generic Hive product standards, scaffolded by `hive init`.";

export function verificationSectionText(command: string): string {
  return [
    `This repository's measured verification command is \`${command}\`.`,
    "",
    "Run it on the rebased branch before hive_land. Re-check the command still exists in the tree; if it does not, discover the current one and record it with memory_write (topic verification).",
  ].join("\n");
}

/** Insert or replace the Verification section. Generic scaffolds may gain the section; a custom file is updated only when it already declares one. Returns null when the file should not be touched. */
export function withPromotedVerification(
  source: string,
  command: string,
): string | null {
  const generic = source.includes(GENERIC_STANDARDS_MARKER);
  const declared = source.includes(`${VERIFICATION_SECTION}:`);
  if (!generic && !declared) return null;
  const body = verificationSectionText(command);
  if (source.includes(`## ${VERIFICATION_SECTION}`)) {
    return replaceSection(source, VERIFICATION_SECTION, body);
  }
  return appendVerificationSection(source, body);
}

export async function promoteVerificationToStandards(
  repoRoot: string,
  command: string,
): Promise<"promoted" | "unchanged" | "skipped"> {
  const path = join(repoRoot, AGENT_STANDARDS_FILE);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code !== "ENOENT") throw error;
    source = scaffoldAgentStandardsMd();
  }
  const next = withPromotedVerification(source, command);
  if (next === null) return "skipped";
  if (next === source) return "unchanged";
  parseAgentStandards(next, path);
  await writeFile(path, next);
  return "promoted";
}

function replaceSection(source: string, heading: string, body: string): string {
  const marker = `## ${heading}\n`;
  const start = source.indexOf(marker);
  if (start === -1) return source;
  const after = start + marker.length;
  const next = source.indexOf("\n## ", after);
  const end = next === -1 ? source.length : next;
  const prefix = source.slice(0, after);
  const suffix = next === -1 ? "" : source.slice(end).replace(/^\n*/, "\n\n");
  return `${prefix}\n${body}\n${suffix}`;
}

function appendVerificationSection(source: string, body: string): string {
  const fence = source.indexOf(DECLARATION_FENCE);
  const close = source.indexOf("\n```", fence);
  if (fence === -1 || close === -1) return source;
  const withDecl = `${source.slice(0, close)}\n${VERIFICATION_SECTION}: writers${source.slice(close)}`;
  const trimmed = withDecl.endsWith("\n") ? withDecl : `${withDecl}\n`;
  return `${trimmed}\n## ${VERIFICATION_SECTION}\n\n${body}\n`;
}

const DECLARATION_FENCE = "```standards";

const AUDIENCE_SYNTAX =
  'audiences are "everyone", "writers", "read-only", or "category <name>" ' +
  `naming one of: ${ROUTING_CATEGORIES.join(", ")}`;

/** Reads and validates the standards for one spawn. Read per spawn rather than cached, so an edit reaches the next agent started after it. A cache would put the wording back behind a restart, which is the problem this file exists to remove; spawns are seconds apart at their fastest and the file is a few kilobytes. Throws if the file is missing, unreadable, declares nothing, or disagrees with itself about which sections it has. */
export async function loadAgentStandards(
  repoRoot: string,
): Promise<AgentStandards> {
  const path = join(repoRoot, AGENT_STANDARDS_FILE);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") {
      return parseAgentStandards(scaffoldAgentStandardsMd(), path);
    }
    throw new Error(
      `Cannot spawn: agent standards are unreadable at ${path}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
  return parseAgentStandards(source, path);
}

/** The sections this agent is given, in file order. Each entry is the section's `##` heading plus its body. The heading is not optional decoration: without it, a body that never restates its own title is present but un-citable, and open-taxonomy sections inherit that trap. Emitting the heading here makes section-name citability a property of the assembler, not of each author's first sentence. */
export function standardsFor(
  standards: AgentStandards,
  facts: AgentAudienceFacts,
): string[] {
  return standards.sections
    .filter((section) => audienceIncludes(section.audience, facts))
    .map((section) => `## ${section.heading}\n\n${section.text}`);
}

function audienceIncludes(
  audience: StandardsAudience,
  facts: AgentAudienceFacts,
): boolean {
  switch (audience.kind) {
    case "everyone":
      return true;
    case "writers":
      return !facts.readOnly;
    case "read-only":
      return facts.readOnly;
    case "category":
      return facts.category === audience.category;
  }
}

function parseAudience(
  raw: string,
  heading: string,
  path: string,
): StandardsAudience {
  if (raw === "everyone") return { kind: "everyone" };
  if (raw === "writers") return { kind: "writers" };
  if (raw === "read-only") return { kind: "read-only" };
  const named = /^category\s+(.+)$/.exec(raw)?.[1]?.trim();
  if (named !== undefined) {
    const category = RoutingCategorySchema.safeParse(named);
    if (!category.success) {
      throw new Error(
        `Cannot spawn: ${path} sends "${heading}" to category "${named}", which is not a routing category Hive has; ${AUDIENCE_SYNTAX}`,
      );
    }
    return { kind: "category", category: category.data };
  }
  throw new Error(
    `Cannot spawn: ${path} gives "${heading}" the audience "${raw}", which Hive cannot route; ${AUDIENCE_SYNTAX}`,
  );
}

/** Reads the declaration block: one `Heading: audience` per line. A section is delivered because the file declared it, so an audience that cannot be routed refuses the spawn rather than quietly reaching nobody — delivering a standard to an empty audience looks identical to delivering it, right up until the rule turns out not to have been in force. */
function parseDeclarations(
  source: string,
  path: string,
): Map<string, StandardsAudience> {
  const lines = source.split("\n");
  const opened = lines.findIndex((line) => line.trim() === DECLARATION_FENCE);
  const firstHeading = lines.findIndex((line) => /^## /.test(line));
  if (opened === -1 || (firstHeading !== -1 && opened > firstHeading)) {
    throw new Error(
      `Cannot spawn: ${path} declares no sections. Above the first "##" heading it needs a ${DECLARATION_FENCE} block with one "Section heading: audience" line per section; ${AUDIENCE_SYNTAX}`,
    );
  }
  const closed = lines.findIndex(
    (line, index) => index > opened && line.trim() === "```",
  );
  if (closed === -1) {
    throw new Error(
      `Cannot spawn: ${path} opens a ${DECLARATION_FENCE} block that is never closed`,
    );
  }

  const declarations = new Map<string, StandardsAudience>();
  for (const line of lines.slice(opened + 1, closed)) {
    const entry = line.trim();
    if (entry === "") continue;
    const separator = entry.indexOf(":");
    if (separator === -1) {
      throw new Error(
        `Cannot spawn: ${path} declares "${entry}", which names no audience. Each line reads "Section heading: audience"; ${AUDIENCE_SYNTAX}`,
      );
    }
    const heading = entry.slice(0, separator).trim();
    if (declarations.has(heading)) {
      throw new Error(
        `Cannot spawn: ${path} declares the "${heading}" section twice, so which audience it has is undefined`,
      );
    }
    declarations.set(
      heading,
      parseAudience(entry.slice(separator + 1).trim(), heading, path),
    );
  }
  if (declarations.size === 0) {
    throw new Error(
      `Cannot spawn: ${path} has an empty ${DECLARATION_FENCE} block, so no agent would receive any standards`,
    );
  }
  return declarations;
}

function parseAgentStandards(source: string, path: string): AgentStandards {
  const declarations = parseDeclarations(source, path);
  const sections = new Map<string, string>();
  let heading: string | undefined;
  let body: string[] = [];
  const closeSection = (): void => {
    if (heading === undefined) {
      return;
    }
    if (sections.has(heading)) {
      throw new Error(
        `Cannot spawn: ${path} declares the "${heading}" section twice, so which text an agent gets is undefined`,
      );
    }
    sections.set(heading, body.join("\n").trim());
  };
  for (const line of source.split("\n")) {
    const match = /^## (.*)$/.exec(line);
    if (match === null) {
      body.push(line);
      continue;
    }
    closeSection();
    heading = match[1]?.trim() ?? "";
    body = [];
  }
  closeSection();

  const unknown = [...sections.keys()].filter(
    (name) => !declarations.has(name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Cannot spawn: ${path} has section(s) no agent is given: ${unknown.join(", ")}. ` +
        `Every section reaches an agent or none does; declare it in the ${DECLARATION_FENCE} block, or put notes above the first heading instead.`,
    );
  }

  const absent = [...declarations.keys()].filter(
    (name) => (sections.get(name) ?? "") === "",
  );
  if (absent.length > 0) {
    throw new Error(
      `Cannot spawn: ${path} is missing or empty in section(s): ${absent.join(", ")}. ` +
        "Hive refuses to start an agent that would run without its standards.",
    );
  }

  // Ordered by the file rather than by the declaration block: an agent reads its standards in the order the file presents them, and the declaration is about audience, not sequence.
  return {
    sections: [...sections].map(([name, text]) => ({
      heading: name,
      audience: declarations.get(name) as StandardsAudience,
      text,
    })),
  };
}
