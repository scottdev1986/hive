import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryFactSchema, type MemoryFact, type MemoryScope } from "../schemas";

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

function hiveHome(): string {
  return Bun.env.HIVE_HOME ?? join(homedir(), ".hive");
}

export function getGlobalMemoryRoot(): string {
  return join(hiveHome(), "memory");
}

export function getRepoMemoryRoot(root: string): string {
  return join(root, ".hive", "memory");
}

export function scopeRoot(root: string, scope: MemoryScope): string {
  return scope === "repo" ? getRepoMemoryRoot(root) : getGlobalMemoryRoot();
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

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseFrontmatterValue(raw: string): string {
  return raw.trim();
}

function parseTags(raw: string): string[] {
  const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed.split(",").map((tag) => tag.trim()).filter((tag) =>
    tag.length > 0
  );
}

function serializeTags(tags: string[]): string {
  return `[${tags.join(", ")}]`;
}

export function serializeMemoryFile(
  fact: Pick<MemoryFact, "title" | "date" | "tags" | "body">,
): string {
  return [
    "---",
    `title: ${fact.title}`,
    `date: ${fact.date}`,
    `tags: ${serializeTags(fact.tags)}`,
    "---",
    "",
    fact.body.trimEnd(),
    "",
  ].join("\n");
}

export function parseMemoryFile(
  id: string,
  scope: MemoryScope,
  path: string,
  contents: string,
): MemoryFact {
  const lines = contents.split(/\r?\n/);
  let title = id;
  let date = todayIsoDate();
  let tags: string[] = [];
  let bodyStart = 0;

  if (lines[0]?.trim() === "---") {
    const closingIndex = lines.findIndex(
      (line, index) => index > 0 && line.trim() === "---",
    );
    if (closingIndex > 0) {
      for (const line of lines.slice(1, closingIndex)) {
        const separator = line.indexOf(":");
        if (separator === -1) continue;
        const key = line.slice(0, separator).trim();
        const value = parseFrontmatterValue(line.slice(separator + 1));
        if (key === "title") title = value;
        else if (key === "date") date = value;
        else if (key === "tags") tags = parseTags(value);
      }
      bodyStart = closingIndex + 1;
    }
  }

  const body = lines.slice(bodyStart).join("\n").trim();
  return MemoryFactSchema.parse({ id, scope, title, body, tags, date, path });
}

async function isMarkdownFile(path: string): Promise<boolean> {
  return path.endsWith(".md");
}

export async function discoverMemoryFacts(
  root: string,
  scope: MemoryScope,
): Promise<MemoryFact[]> {
  const directory = scopeRoot(root, scope);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const facts: MemoryFact[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !(await isMarkdownFile(entry.name))) {
      continue;
    }
    const path = join(directory, entry.name);
    const id = entry.name.slice(0, -3);
    const contents = await readFile(path, "utf8");
    facts.push(parseMemoryFile(id, scope, path, contents));
  }
  return facts;
}

export async function listMemoryFacts(root: string): Promise<MemoryFact[]> {
  const [repo, global] = await Promise.all([
    discoverMemoryFacts(root, "repo"),
    discoverMemoryFacts(root, "global"),
  ]);
  return [...repo, ...global];
}

export async function readMemoryFact(
  root: string,
  scope: MemoryScope,
  id: string,
): Promise<MemoryFact | null> {
  const path = join(scopeRoot(root, scope), `${id}.md`);
  try {
    const contents = await readFile(path, "utf8");
    return parseMemoryFile(id, scope, path, contents);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

export interface MemoryWriteFileInput {
  scope: MemoryScope;
  id?: string;
  title: string;
  body: string;
  tags?: string[];
  date?: string;
}

// Upserts a Markdown fact file: an explicit id overwrites that fact in
// place, an omitted id derives a fresh slug from the title and disambiguates
// against any file already using it. The file is the sole source of truth —
// callers are responsible for re-indexing after this returns.
export async function writeMemoryFact(
  root: string,
  input: MemoryWriteFileInput,
): Promise<MemoryFact> {
  const directory = scopeRoot(root, input.scope);
  await mkdir(directory, { recursive: true });

  let id = input.id;
  if (id === undefined) {
    const base = slugify(input.title);
    id = base;
    let suffix = 2;
    while (await readMemoryFact(root, input.scope, id) !== null) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
  }

  const fact = MemoryFactSchema.parse({
    id,
    scope: input.scope,
    title: input.title,
    body: input.body,
    tags: input.tags ?? [],
    date: input.date ?? todayIsoDate(),
    path: join(directory, `${id}.md`),
  });
  await writeFile(fact.path, serializeMemoryFile(fact));
  return fact;
}

export async function deleteMemoryFact(
  root: string,
  scope: MemoryScope,
  id: string,
): Promise<boolean> {
  const path = join(scopeRoot(root, scope), `${id}.md`);
  try {
    await rm(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

const MEMORY_INDEX_MAX_ENTRIES = 30;

// The context-budget rule from SPEC.md decision 5: agents see a merged
// index of a few hundred tokens, never the store itself. One line per fact,
// newest first, capped and noting what was left out so pruning stays honest.
export async function buildMemoryIndex(root: string): Promise<string> {
  const facts = await listMemoryFacts(root);
  if (facts.length === 0) {
    return "";
  }
  const sorted = [...facts].sort((a, b) => b.date.localeCompare(a.date));
  const shown = sorted.slice(0, MEMORY_INDEX_MAX_ENTRIES);
  const lines = shown.map((fact) =>
    `- [${fact.scope}] ${fact.id} (${fact.date}): ${fact.title}`
  );
  const omitted = sorted.length - shown.length;
  const header =
    "Hive memory index — durable facts from past runs. Pull the full fact with memory_read(scope, id) before relying on it; search more with memory_search.";
  const footer = omitted > 0
    ? [`(${omitted} older fact${omitted === 1 ? "" : "s"} omitted — use memory_search to find them)`]
    : [];
  return [header, ...lines, ...footer].join("\n");
}
