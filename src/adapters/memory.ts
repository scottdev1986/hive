import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MemoryFactSchema,
  MemorySourceSchema,
  type MemoryFact,
  type MemoryScope,
  type MemorySource,
} from "../schemas";

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

/** Defense-in-depth validation of memory fact IDs. The daemon rejects invalid
 * IDs at the MCP boundary (MemoryIdSchema in src/daemon/server.ts), but this
 * adapter validates before any path join so direct calls cannot traverse
 * directories with ../ paths. The regex mirrors MemoryIdSchema: alphanumeric
 * start, then [a-z0-9._-], max 120 chars. */
function validateMemoryId(id: string): void {
  const MEMORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
  if (!MEMORY_ID_PATTERN.test(id) || id.length > 120) {
    throw new Error(
      `Invalid memory id: must be 1–120 characters, alphanumeric start, ` +
        `then [a-z0-9._-], got "${id}"`,
    );
  }
}

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseSource(raw: string): MemorySource | undefined {
  // Tolerant of a hand-edited file: an unrecognized word drops to undefined
  // (legacy/earned) rather than throwing, matching how a missing key is read.
  const parsed = MemorySourceSchema.safeParse(raw.trim());
  return parsed.success ? parsed.data : undefined;
}

export function serializeMemoryFile(
  fact: Pick<MemoryFact, "title" | "date" | "tags" | "body"> &
    Partial<Pick<MemoryFact, "source" | "verified">>,
): string {
  // Provenance lines are only written when present, so a legacy fact
  // re-serialized without them stays byte-faithful to its earned/unknown
  // status instead of gaining a fabricated `source` (§5).
  const lines = ["---", `title: ${fact.title}`, `date: ${fact.date}`];
  if (fact.source !== undefined) lines.push(`source: ${fact.source}`);
  if (fact.verified !== undefined) lines.push(`verified: ${fact.verified}`);
  lines.push(`tags: ${serializeTags(fact.tags)}`, "---", "", fact.body.trimEnd(), "");
  return lines.join("\n");
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
  let source: MemorySource | undefined;
  let verified: string | undefined;
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
        else if (key === "source") source = parseSource(value);
        // A malformed verified date is dropped, not carried — an unparseable
        // confirmation is no confirmation, so the fact reads as never-verified.
        else if (key === "verified") verified = ISO_DATE.test(value) ? value : undefined;
      }
      bodyStart = closingIndex + 1;
    }
  }

  const body = lines.slice(bodyStart).join("\n").trim();
  return MemoryFactSchema.parse({
    id,
    scope,
    title,
    body,
    tags,
    date,
    path,
    source,
    verified,
  });
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
  validateMemoryId(id);
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
  source?: MemorySource;
  verified?: string;
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
  validateMemoryId(id);

  const fact = MemoryFactSchema.parse({
    id,
    scope: input.scope,
    title: input.title,
    body: input.body,
    tags: input.tags ?? [],
    date: input.date ?? todayIsoDate(),
    path: join(directory, `${id}.md`),
    source: input.source,
    verified: input.verified,
  });
  await writeFile(fact.path, serializeMemoryFile(fact));
  return fact;
}

export async function deleteMemoryFact(
  root: string,
  scope: MemoryScope,
  id: string,
): Promise<boolean> {
  validateMemoryId(id);
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

export interface LegacyFactReport {
  scope: MemoryScope;
  id: string;
  // What is missing on the legacy fact. `verified` absence is expected for old
  // facts (never re-confirmed); `source` absence is what marks it legacy.
  missingSource: boolean;
  missingVerified: boolean;
}

export interface MemoryMigrationReport {
  scanned: number;
  legacy: LegacyFactReport[];
  // Always 0 by default: the migration refuses to fabricate provenance. §5
  // binds a missing `source` to "legacy, treated as earned" and offers no
  // "unknown" member, so absence *is* the honest encoding — inventing an author
  // for an old fact would be exactly the invented precision §5 forbids.
  stamped: number;
}

// Migrate the existing `.hive/memory/` (and global) facts onto the provenance
// schema (SPEC.md decision 5). The honest migration for a fact whose author is
// unknowable is to leave `source`/`verified` absent — the parser already reads
// that as legacy/earned/never-verified and recall already flags it
// `[unverified]`, so no file is rewritten and the real committed facts are
// preserved byte-for-byte. This is a diagnostic/idempotent pass: it reports
// which facts are legacy so an operator (or `hive init`) can choose to
// re-verify and re-author them with real provenance, but it never guesses one.
export async function migrateLegacyMemory(
  root: string,
): Promise<MemoryMigrationReport> {
  const facts = await listMemoryFacts(root);
  const legacy: LegacyFactReport[] = [];
  for (const fact of facts) {
    const missingSource = fact.source === undefined;
    const missingVerified = fact.verified === undefined;
    if (missingSource || missingVerified) {
      legacy.push({
        scope: fact.scope,
        id: fact.id,
        missingSource,
        missingVerified,
      });
    }
  }
  return { scanned: facts.length, legacy, stamped: 0 };
}

// The fact-count cap on the injected index (SPEC.md decision 5). This is the
// budget knob for memory and is deliberately distinct from the profile's
// file-count budget (§14): this one is driven by how many facts exist, not by
// repo size. At ~15–25 tokens per line the ceiling holds the index tax near
// ~500 tokens no matter how large the store grows — a flat tax, not a scaling
// cost (asserted in adapters/memory.test.ts).
const MEMORY_INDEX_MAX_ENTRIES = 30;

// A recalled fact that names a concrete path, command, or flag must be
// re-checked against the repo before it drives an action (§5). The index is a
// pointer, the fact is a claim, the repo is truth — so recall marks the facts
// most in need of that check. `unverified`: never confirmed against the repo.
// `stale`: last verified *before* it was last written, so the current content
// was never re-confirmed even though an older confirmation exists.
export function factVerificationFlag(
  fact: Pick<MemoryFact, "date" | "verified">,
): "unverified" | "stale" | null {
  if (fact.verified === undefined) return "unverified";
  if (fact.verified < fact.date) return "stale";
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    // A directory or a permission error still means "there is something here";
    // only a genuine absence should suppress the pointer.
    return true;
  }
}

// The context-budget rule from SPEC.md decision 5: agents see a merged
// index of a few hundred tokens, never the store itself. One line per fact,
// newest first, capped and noting what was left out so pruning stays honest.
// The date on every line puts staleness in front of the agent at zero extra
// tool cost; a `[unverified]`/`[stale]` marker flags the facts whose concrete
// claims the reader must re-check before acting on them.
export async function buildMemoryIndex(root: string): Promise<string> {
  const facts = await listMemoryFacts(root);
  if (facts.length === 0) {
    return "";
  }
  const sorted = [...facts].sort((a, b) => b.date.localeCompare(a.date));
  const shown = sorted.slice(0, MEMORY_INDEX_MAX_ENTRIES);
  const lines = shown.map((fact) => {
    const flag = factVerificationFlag(fact);
    const marker = flag === null ? "" : ` [${flag}]`;
    return `- [${fact.scope}] ${fact.id} (${fact.date}): ${fact.title}${marker}`;
  });
  const omitted = sorted.length - shown.length;
  const header =
    "Hive memory index — durable facts from past runs. Pull the full fact with memory_read(scope, id) before relying on it; a fact marked [unverified] or [stale] that names a path, command, or flag must be re-checked against the repo before you act on it. Search more with memory_search.";
  // The index points at the profile rather than restating it (§14): structured
  // repo truth — build/test commands, entry points, doc allowlist — lives in
  // .hive/profile.toml, read by product code, never duplicated into a fact.
  const profilePointer =
    (await fileExists(join(root, ".hive", "profile.toml")))
      ? [
        "Structured repo facts (build/test commands, entry points, layout) live in .hive/profile.toml, not here — memory holds only narrative lessons.",
      ]
      : [];
  const footer = omitted > 0
    ? [`(${omitted} older fact${omitted === 1 ? "" : "s"} omitted — use memory_search to find them)`]
    : [];
  return [header, ...profilePointer, ...lines, ...footer].join("\n");
}
