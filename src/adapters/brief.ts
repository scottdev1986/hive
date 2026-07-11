import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { ensureProfile } from "./profile";

// A spawned agent that is told "read the spec" reads all ~20K tokens of it to
// find the two sections its task actually names. The brief inverts that: the
// daemon does the extraction once, at spawn, and hands the agent the sections
// plus a `file:line` outline of everything it did not embed. Reading deeper is
// then an opt-in the agent makes with a specific destination, not a reflex.
//
// *What* is briefable is not compiled in — it would tie the brief mechanism to
// hive's own doc names and break on any other repo (SPEC.md decision 14). The
// allowlist, the briefable directories, and which doc earns the bare-name
// `§`-selector rule all come from the repo profile, read per-repo.

/** The repo-specific inputs the brief mechanism needs, sourced from the repo
 * profile rather than hardcoded. `primaryDoc` is the design doc
 * that earns the bare-name selector rule (a task citing "DESIGN §3" in a repo
 * whose profile names `DESIGN.md` primary), and is null when the repo has none
 * — dropping a special case it never needed. */
export interface BriefConfig {
  /** Docs an agent may be pointed at. A task naming any other path is ignored:
   * the brief must never become a way to paste arbitrary repo files into a
   * prompt, and every entry is a document written to be excerpted. */
  briefableDocs: readonly string[];
  /** Directories whose `.md` files are briefable — the artifacts agents hand
   * each other; source and config are not. */
  briefableDirectories: readonly string[];
  /** The primary design doc (basename addressable by bare name), or null. */
  primaryDoc: string | null;
}

const EMPTY_BRIEF_CONFIG: BriefConfig = {
  briefableDocs: [],
  briefableDirectories: [],
  primaryDoc: null,
};

/** Derive the brief inputs from the repo profile, generating it if this repo has
 * never been profiled — a fresh clone's very first spawn is briefed like any
 * other. A repo whose profile cannot be built at all briefs nothing rather than
 * assuming hive's own doc names: the safe, portable default. */
export async function loadBriefConfig(root: string): Promise<BriefConfig> {
  const profile = await ensureProfile(root).catch(() => null);
  if (profile === null) return EMPTY_BRIEF_CONFIG;
  return {
    briefableDocs: profile.docs.briefable,
    briefableDirectories: profile.docs.briefableDirectories,
    primaryDoc: profile.docs.primary,
  };
}

/** A whole doc under this size is cheaper to embed than to make the agent open
 * a file, burn a tool call, and read it anyway. */
export const WHOLE_DOC_MAX_CHARS = 4_000;
/** One section's embedded body. Beyond this the agent gets a pointer. */
export const SECTION_MAX_CHARS = 6_000;
/** Everything the brief may add to a spawn prompt, across all docs. */
export const BRIEF_MAX_CHARS = 12_000;

export interface DocSection {
  /** Heading text without its leading `#` markers. */
  heading: string;
  /** Leading integer of a numbered heading (`### 6. Who picks the model`), the
   * form `SPEC §6` addresses. Null for unnumbered headings. */
  ordinal: number | null;
  level: number;
  /** 1-indexed line of the heading itself. */
  startLine: number;
  /** 1-indexed last line of the section body. */
  endLine: number;
  /** Heading line plus body, verbatim. */
  body: string;
}

export interface DocReference {
  /** Repo-relative path as written in the task. */
  path: string;
  /** Section selectors the task named: `§6` → 6, `"Who picks the model"` →
   * that string. Empty means the task named the doc but no section. */
  sections: (number | string)[];
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const ORDINAL = /^(\d+)[.)]?\s/;

/** Split a markdown source into sections at every heading. Text before the
 * first heading belongs to no section and is not addressable. */
export function parseDocOutline(source: string): DocSection[] {
  const lines = source.split("\n");
  const starts: { level: number; heading: string; index: number }[] = [];
  for (const [index, line] of lines.entries()) {
    const match = HEADING.exec(line ?? "");
    if (match !== null) {
      starts.push({
        level: match[1]!.length,
        heading: match[2]!.trim(),
        index,
      });
    }
  }
  return starts.map((start, position) => {
    // A section runs to the next heading of any level: nesting a subsection's
    // text inside its parent would double-embed it whenever both are named.
    const endIndex = (starts[position + 1]?.index ?? lines.length) - 1;
    const ordinalMatch = ORDINAL.exec(start.heading);
    return {
      heading: start.heading,
      ordinal: ordinalMatch === null ? null : Number(ordinalMatch[1]),
      level: start.level,
      startLine: start.index + 1,
      endLine: endIndex + 1,
      body: lines.slice(start.index, endIndex + 1).join("\n").trimEnd(),
    };
  });
}

const isBriefable = (path: string, config: BriefConfig): boolean =>
  config.briefableDocs.includes(path) ||
  config.briefableDirectories.some((directory) => path.startsWith(directory));

/** Resolve a task-named path to an absolute path inside `root`, or null when it
 * escapes the repo or is not a briefable doc. */
export function resolveBriefablePath(
  root: string,
  path: string,
  config: BriefConfig,
): string | null {
  if (isAbsolute(path) || !isBriefable(path, config)) {
    return null;
  }
  const absolute = resolve(root, path);
  const inside = relative(resolve(root), absolute);
  if (inside.startsWith("..")) {
    return null;
  }
  return absolute;
}

// A `.md` path anywhere: `DESIGN.md`, `docs/research/x.md`. Trailing punctuation
// is stripped by the character class, so "read DESIGN.md, then..." yields
// "DESIGN.md". Which of these are actually briefable is the profile's call.
const DOC_PATH = /\b((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.md)\b/g;
// `§6`, `§ 6`, `section 6`, `sections 6 and 7`, `§6.2` (major number wins).
const SECTION_SELECTOR =
  /(?:§\s*(\d+)|\bsections?\s+(\d+)(?:\s*(?:and|,|&)\s*(\d+))?)/gi;
// `"Who picks the model"` or `“Who picks the model”` immediately after a doc.
const QUOTED_HEADING = /["“]([^"”]{3,80})["”]/g;

/** How far after a doc mention a section selector still binds to that doc. */
const SELECTOR_WINDOW = 80;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Read the doc references out of a task description. A doc named with no
 * section still counts: the agent gets its outline, never its full text. */
export function findTaskDocReferences(
  task: string,
  config: BriefConfig,
): DocReference[] {
  const references = new Map<string, (number | string)[]>();
  for (const match of task.matchAll(DOC_PATH)) {
    const path = match[1]!;
    if (!isBriefable(path, config)) {
      continue;
    }
    // Selectors may precede ("§6 of DESIGN.md") or follow ("DESIGN.md §6") the
    // path, so scan a window on both sides of the mention.
    const from = Math.max(0, match.index - SELECTOR_WINDOW);
    const to = match.index + path.length + SELECTOR_WINDOW;
    const window = task.slice(from, to);
    const sections = references.get(path) ?? [];
    for (const selector of window.matchAll(SECTION_SELECTOR)) {
      for (const group of [selector[1], selector[2], selector[3]]) {
        if (group !== undefined) {
          sections.push(Number(group));
        }
      }
    }
    for (const quoted of window.matchAll(QUOTED_HEADING)) {
      sections.push(quoted[1]!.trim());
    }
    references.set(path, sections);
  }
  // The primary doc referred to by bare name and section: `SPEC §6`, `DESIGN §3`
  // — whatever the profile names primary — with no `.md`. A repo with no primary
  // doc simply has no such special case.
  if (config.primaryDoc !== null) {
    const bareName = basename(config.primaryDoc).replace(/\.md$/i, "");
    const bareRule = new RegExp(`\\b${escapeRegExp(bareName)}\\s*(?:§|section)`, "i");
    if (!references.has(config.primaryDoc) && bareRule.test(task)) {
      const sections: (number | string)[] = [];
      for (const selector of task.matchAll(SECTION_SELECTOR)) {
        for (const group of [selector[1], selector[2], selector[3]]) {
          if (group !== undefined) {
            sections.push(Number(group));
          }
        }
      }
      references.set(config.primaryDoc, sections);
    }
  }
  return [...references].map(([path, sections]) => ({
    path,
    sections: [...new Set(sections)],
  }));
}

const normalize = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Match a task's selector against the doc's sections. Numeric selectors match
 * a heading's leading ordinal; string selectors match heading text loosely. */
export function selectSections(
  outline: DocSection[],
  selectors: (number | string)[],
): DocSection[] {
  const selected: DocSection[] = [];
  for (const selector of selectors) {
    const match = typeof selector === "number"
      ? outline.find((section) => section.ordinal === selector)
      : outline.find((section) => {
          const heading = normalize(section.heading);
          const wanted = normalize(selector);
          return heading === wanted || heading.includes(wanted);
        });
    if (match !== undefined && !selected.includes(match)) {
      selected.push(match);
    }
  }
  return selected;
}

function truncate(
  body: string,
  path: string,
  section: DocSection,
  limit: number,
): string {
  if (body.length <= limit) {
    return body;
  }
  const kept = body.slice(0, limit).trimEnd();
  const firstOmitted = section.startLine + kept.split("\n").length;
  return `${kept}\n\n[…truncated. The rest of this section is ${path}:${firstOmitted}-${section.endLine}.]`;
}

const pointer = (path: string, section: DocSection): string =>
  `${path}:${section.startLine}-${section.endLine}`;

function renderOutline(path: string, outline: DocSection[]): string {
  const lines = outline.map(
    (section) =>
      `  ${path}:${section.startLine}  ${"  ".repeat(Math.max(0, section.level - 2))}${section.heading}`,
  );
  return [`Outline of ${path} (read a section only if you need it):`, ...lines]
    .join("\n");
}

export interface BriefOptions {
  readDoc?: (absolutePath: string) => Promise<string>;
  maxChars?: number;
  /** The profile-derived brief inputs. Omitted in production, where it is read
   * from the repo profile at `root`; passed explicitly in tests. */
  config?: BriefConfig;
}

const readDocDefault = (path: string): Promise<string> => readFile(path, "utf8");

/**
 * Build the spawn-time brief for a task. Returns "" when the task names no
 * briefable doc — most tasks — so the prompt is unchanged for them.
 */
export async function buildScopedBrief(
  root: string,
  task: string,
  options: BriefOptions = {},
): Promise<string> {
  const config = options.config ?? await loadBriefConfig(root);
  const readDoc = options.readDoc ?? readDocDefault;
  const budget = options.maxChars ?? BRIEF_MAX_CHARS;
  const blocks: string[] = [];
  let used = 0;

  for (const reference of findTaskDocReferences(task, config)) {
    const absolute = resolveBriefablePath(root, reference.path, config);
    if (absolute === null) {
      continue;
    }
    let source: string;
    try {
      source = await readDoc(absolute);
    } catch {
      // A task naming a doc that does not exist here is not a spawn failure;
      // the agent simply gets no brief for it.
      continue;
    }
    const outline = parseDocOutline(source);
    const selected = selectSections(outline, reference.sections);

    if (selected.length === 0 && source.length <= WHOLE_DOC_MAX_CHARS) {
      const block = `--- ${reference.path} (whole document, ${source.length} chars) ---\n${source.trimEnd()}`;
      if (used + block.length > budget) continue;
      used += block.length;
      blocks.push(block);
      continue;
    }

    if (selected.length === 0) {
      // The task named the doc but no section. The outline is the whole brief:
      // it is what replaces "go read this 82K-char file".
      const block = renderOutline(reference.path, outline);
      if (used + block.length > budget) continue;
      used += block.length;
      blocks.push(block);
      continue;
    }

    for (const section of selected) {
      const body = truncate(
        section.body,
        reference.path,
        section,
        SECTION_MAX_CHARS,
      );
      const block = `--- ${pointer(reference.path, section)} ---\n${body}`;
      if (used + block.length > budget) {
        blocks.push(
          `[Brief budget exhausted. Read ${pointer(reference.path, section)} directly: ${section.heading}]`,
        );
        break;
      }
      used += block.length;
      blocks.push(block);
    }
    const unselected = outline.filter((section) => !selected.includes(section));
    if (unselected.length > 0) {
      const block = renderOutline(reference.path, unselected);
      if (used + block.length <= budget) {
        used += block.length;
        blocks.push(block);
      }
    }
  }

  if (blocks.length === 0) {
    return "";
  }
  return [
    "Scoped brief — your task names these documents, so Hive extracted the parts it names and left you pointers to the rest. Do not read these files whole: the excerpts below are verbatim and carry `path:line` ranges, and each outline lists every section that was not embedded. Open a file only when a pointer tells you the answer is somewhere you cannot see.",
    ...blocks,
  ].join("\n\n");
}
