// Hive's durable memory on disk: what agents have learned about a repository,
// kept as plain Markdown rather than rows in the database.
//
// The database is Hive's runtime state and is expected to be thrown away and
// rebuilt. Memory is not — it has to survive that, be readable by a human who
// has never run Hive, and be diffable in the repository it describes. Hence
// files with frontmatter, and hence every index in here being derived: a lost
// index is rebuilt from the articles, and an article is never rebuilt from an
// index.
//
// Two scopes, chosen by the writer: `repo` under the checkout's own `.hive`,
// travelling with the project; `global` under `~/.hive`, for what holds across
// every repository on this machine.
//
// Two layers within a scope, and the distinction is the heart of the design:
//
//   - `raw/` — observations, append-only. One file per thing an agent claimed,
//     never edited, never deleted.
//   - `wiki/` — articles, one per subject, rewritten as understanding changes.
//     Each carries `raw:` pointers back to the observations behind it.
//
// So an article can be corrected without destroying the evidence that produced
// the earlier version, and a reader can always get from a current claim back
// to who observed what. Superseding an article deletes the article and keeps
// its raw files, which is why `supersedes` is required to change one.

import type { Dirent } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  type MemoryFact,
  MemoryFactSchema,
  type MemoryScope,
  type MemorySource,
  MemorySourceSchema,
  type MemoryVerificationStatus,
  type MemoryWriteInput,
  MemoryWriteInputSchema,
} from "../schemas";

export type MemoryWriteFileInput = MemoryWriteInput;

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

const MEMORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEMORY_INDEX_MAX_ENTRIES = 30;

function validateMemoryId(id: string): void {
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

function rawRoot(root: string, scope: MemoryScope): string {
  return join(scopeRoot(root, scope), "raw");
}

function wikiRoot(root: string, scope: MemoryScope): string {
  return join(scopeRoot(root, scope), "wiki");
}

// The form two article titles are compared in to decide they are the same
// article: case-folded, every non-alphanumeric run collapsed to one dash,
// trimmed. Unlike slugify it never truncates, so two titles that differ only
// past the slug cutoff still collide — which is the point, since the slug is
// what the id was built from and is exactly where a near-duplicate hides.
//
// Exported so that callers writing memory on an agent's behalf can normalize
// before they write, and re-issue a duplicate as an update to the existing id
// rather than being rejected by the check in writeMemoryFact.
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugify(value: string, max = 40): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "fact";
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseList(raw: string): string[] {
  const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return trimmed.length === 0
    ? []
    : trimmed
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
}

function serializeList(values: string[]): string {
  return `[${values.join(", ")}]`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * One article as it appears on disk: frontmatter, then the body verbatim.
 *
 * The format is hand-rolled rather than YAML because it has to round-trip
 * through `parseMemoryFile` and be edited by hand without a library present.
 * Values are flattened to one line each on the way in for the same reason —
 * a wrapped value would parse as a field named whatever the next line starts
 * with.
 */
export function serializeMemoryFile(
  fact: Pick<
    MemoryFact,
    | "title"
    | "date"
    | "topic"
    | "source"
    | "evidence"
    | "status"
    | "kind"
    | "supersedes"
    | "raw"
    | "tags"
    | "body"
  > &
    Partial<Pick<MemoryFact, "verified">>,
): string {
  const lines = [
    "---",
    `title: ${oneLine(fact.title)}`,
    `updated: ${fact.date}`,
    `topic: ${fact.topic}`,
    `source: ${fact.source}`,
    `status: ${fact.status}`,
  ];
  // "article" is the default and stays implicit, keeping plain articles free
  // of a frontmatter line that carries no information.
  if (fact.kind === "pitfall") lines.push(`kind: ${fact.kind}`);
  if (fact.verified !== undefined) lines.push(`verified: ${fact.verified}`);
  lines.push(
    `evidence: ${oneLine(fact.evidence)}`,
    `tags: ${serializeList(fact.tags)}`,
    `supersedes: ${serializeList(fact.supersedes)}`,
    `raw: ${serializeList(fact.raw)}`,
    "---",
    "",
    fact.body.trimEnd(),
    "",
  );
  return lines.join("\n");
}

/**
 * Read one article back. Throws on anything it cannot make sense of.
 *
 * A human edits these files, so malformed input is expected — and it is an
 * error rather than a skipped file on purpose. A memory article that silently
 * stops loading is worse than one that fails loudly: the agent simply does not
 * know the thing any more, and nothing says so.
 *
 * The id comes from the filename, not the frontmatter, so renaming the file is
 * how an article is renamed and the two can never disagree.
 */
export function parseMemoryFile(
  id: string,
  scope: MemoryScope,
  path: string,
  contents: string,
): MemoryFact {
  const lines = contents.split(/\r?\n/);
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (lines[0]?.trim() !== "---" || closingIndex < 1) {
    throw new Error(`Malformed compiled memory article: ${path}`);
  }
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, closingIndex)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    fields.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }
  const source = MemorySourceSchema.safeParse(fields.get("source"));
  return MemoryFactSchema.parse({
    id,
    scope,
    topic: fields.get("topic"),
    title: fields.get("title"),
    body: lines
      .slice(closingIndex + 1)
      .join("\n")
      .trim(),
    tags: parseList(fields.get("tags") ?? "[]"),
    date: fields.get("updated"),
    path,
    source: source.success ? source.data : undefined,
    evidence: fields.get("evidence"),
    status: fields.get("status"),
    kind: fields.get("kind"),
    supersedes: parseList(fields.get("supersedes") ?? "[]"),
    raw: parseList(fields.get("raw") ?? "[]"),
    verified: ISO_DATE.test(fields.get("verified") ?? "")
      ? fields.get("verified")
      : undefined,
  });
}

async function readTopicDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

export async function discoverMemoryFacts(
  root: string,
  scope: MemoryScope,
): Promise<MemoryFact[]> {
  const directory = wikiRoot(root, scope);
  const facts: MemoryFact[] = [];
  for (const topic of await readTopicDirectories(directory)) {
    const topicDirectory = join(directory, topic);
    for (const entry of await readdir(topicDirectory, {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(topicDirectory, entry.name);
      facts.push(
        parseMemoryFile(
          entry.name.slice(0, -3),
          scope,
          path,
          await readFile(path, "utf8"),
        ),
      );
    }
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

async function findMemoryFact(
  root: string,
  scope: MemoryScope,
  id: string,
): Promise<MemoryFact | null> {
  const matches = (await discoverMemoryFacts(root, scope)).filter(
    (fact) => fact.id === id,
  );
  if (matches.length > 1) {
    throw new Error(`Duplicate compiled memory article id: [${scope}] ${id}`);
  }
  return matches[0] ?? null;
}

export async function readMemoryFact(
  root: string,
  scope: MemoryScope,
  id: string,
): Promise<MemoryFact | null> {
  validateMemoryId(id);
  return findMemoryFact(root, scope, id);
}

/**
 * A free filename for one new observation, named `<date>-<article-id>` with a
 * counter appended if that is taken.
 *
 * Raw files are append-only, so the name has to be new every time rather than
 * merely stable — several observations about the same article on the same day
 * are the ordinary case, not a collision to resolve. The caller writes with
 * `wx`, which is what actually decides the race; this only picks a candidate.
 */
async function nextRawPath(
  root: string,
  input: MemoryWriteInput,
  id: string,
  date: string,
): Promise<string> {
  const directory = join(rawRoot(root, input.scope), input.topic);
  await mkdir(directory, { recursive: true });
  const base = `${date}-${id}`;
  let path = join(directory, `${base}.md`);
  let suffix = 2;
  while (await pathExists(path)) {
    path = join(directory, `${base}-${suffix}.md`);
    suffix += 1;
  }
  return path;
}

function serializeRawObservation(
  input: MemoryWriteInput,
  id: string,
  date: string,
): string {
  const lines = [
    "---",
    `article: ${id}`,
    `topic: ${input.topic}`,
    `recorded: ${date}`,
    `source: ${input.source}`,
    `status: ${input.status}`,
  ];
  if (input.verified !== undefined) lines.push(`verified: ${input.verified}`);
  lines.push(
    `supersedes: ${serializeList(input.supersedes)}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    "## Evidence",
    "",
    input.evidence.trim(),
    "",
    "## Observation",
    "",
    input.body.trim(),
    "",
  );
  return lines.join("\n");
}

async function appendLog(
  root: string,
  scope: MemoryScope,
  date: string,
  operation: string,
): Promise<void> {
  const directory = wikiRoot(root, scope);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "log.md");
  try {
    await readFile(path);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    await writeFile(path, "# Hive Memory Log\n");
  }
  await appendFile(path, `\n## [${date}] ${operation}\n`);
}

async function rebuildScopeIndex(
  root: string,
  scope: MemoryScope,
): Promise<void> {
  try {
    await readdir(scopeRoot(root, scope));
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  const directory = wikiRoot(root, scope);
  await mkdir(directory, { recursive: true });
  const facts = await discoverMemoryFacts(root, scope);
  const rows = [...facts]
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .map(
      (fact) =>
        `- [${scope}/${fact.topic}] ${fact.id} (${fact.date}) [${fact.status}]` +
        `${fact.kind === "pitfall" ? " [pitfall]" : ""}: ${fact.title}`,
    );
  await writeFile(
    join(directory, "index.md"),
    ["# Hive Memory Index", "", ...rows, ""].join("\n"),
  );
}

export type MemoryWriteFileResult = MemoryFact & {
  rawPath: string;
  supersededIds: string[];
};

/**
 * Record an observation and compile it into an article, in that order.
 *
 * The raw file is written first and with `wx`, so it cannot overwrite an
 * existing observation and so a failure part-way through leaves the evidence
 * on disk without a claim built on it — the recoverable direction. The article
 * follows, then the index is rebuilt from what is now on disk.
 *
 * Most of the length here is refusals, and they share one shape: this function
 * would rather reject a write than silently lose an article someone else
 * wrote. Changing an existing article's body demands `supersedes` naming it,
 * moving one between topics is refused outright, and a title that normalizes
 * onto an existing article is rejected with the id to update instead. None of
 * these are validation for its own sake — each is a way an agent, working from
 * an incomplete picture, would otherwise quietly overwrite what another agent
 * had already established.
 */
export async function writeMemoryFact(
  root: string,
  input: MemoryWriteInput,
): Promise<MemoryWriteFileResult> {
  input = MemoryWriteInputSchema.parse(input);
  const date = input.date ?? todayIsoDate();
  const verified = input.verified;
  if (
    input.status === "verified" &&
    verified !== undefined &&
    verified < date
  ) {
    throw new Error(
      "verified date predates the article update; use status stale",
    );
  }
  if (input.status === "stale" && verified !== undefined && verified >= date) {
    throw new Error(
      "stale status requires verified to predate the article update",
    );
  }
  let id = input.id;
  if (id === undefined) {
    const base = slugify(input.title);
    id = base;
    let suffix = 2;
    while ((await findMemoryFact(root, input.scope, id)) !== null) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
  }
  validateMemoryId(id);

  // A normalized-title match under a different id is a duplicate fact, not a
  // new article. Checked against on-disk articles, never the FTS index, which
  // may be stale — a dedup check that reads a stale index admits the
  // duplicates it exists to stop. A same-id
  // match falls through to the normal update path below, and an id this
  // write supersedes away stops colliding the moment the write lands.
  const normalizedTitle = normalizeTitle(input.title);
  const collision = (await discoverMemoryFacts(root, input.scope)).find(
    (fact) =>
      fact.id !== id &&
      !input.supersedes.includes(fact.id) &&
      normalizeTitle(fact.title) === normalizedTitle,
  );
  if (collision !== undefined) {
    throw new Error(
      `Duplicate memory article title: [${input.scope}] ${collision.id} ` +
        `already covers "${collision.title}". Re-issue as an update to that ` +
        `id: write with id "${collision.id}" and supersedes: ["${collision.id}"].`,
    );
  }

  const existing = await findMemoryFact(root, input.scope, id);
  if (existing !== null && existing.topic !== input.topic) {
    throw new Error(
      `Memory article [${input.scope}] ${id} already belongs to topic ${existing.topic}`,
    );
  }
  if (
    existing !== null &&
    existing.body !== input.body &&
    !input.supersedes.includes(id)
  ) {
    throw new Error(
      `Updating memory article [${input.scope}] ${id} requires supersedes: [${id}]`,
    );
  }
  const supersededFacts: MemoryFact[] = [];
  for (const supersededId of input.supersedes) {
    validateMemoryId(supersededId);
    if (supersededId === id) continue;
    const superseded = await findMemoryFact(root, input.scope, supersededId);
    if (superseded === null) {
      throw new Error(
        `Superseded memory article not found: [${input.scope}] ${supersededId}`,
      );
    }
    supersededFacts.push(superseded);
  }

  const rawPath = await nextRawPath(root, input, id, date);
  await writeFile(rawPath, serializeRawObservation(input, id, date), {
    flag: "wx",
  });
  const articlePath = join(
    wikiRoot(root, input.scope),
    input.topic,
    `${id}.md`,
  );
  await mkdir(dirname(articlePath), { recursive: true });
  const rawReference = relative(dirname(articlePath), rawPath);
  const fact = MemoryFactSchema.parse({
    id,
    scope: input.scope,
    topic: input.topic,
    title: input.title,
    body: input.body,
    tags: input.tags ?? existing?.tags ?? [],
    date,
    path: articlePath,
    source: input.source,
    evidence: oneLine(input.evidence),
    status: input.status,
    kind: input.kind,
    supersedes: [
      ...new Set([...(existing?.supersedes ?? []), ...input.supersedes]),
    ],
    raw: [
      ...new Set([
        ...(existing?.raw ?? []),
        ...supersededFacts.flatMap((superseded) => superseded.raw),
        rawReference,
      ]),
    ],
    verified: input.verified,
  });
  await writeFile(articlePath, serializeMemoryFile(fact));
  for (const superseded of supersededFacts) await rm(superseded.path);
  await rebuildScopeIndex(root, input.scope);
  await appendLog(root, input.scope, date, `ingest | ${fact.title}`);
  return {
    ...fact,
    rawPath,
    supersededIds: supersededFacts.map((superseded) => superseded.id),
  };
}

export async function deleteMemoryFact(
  root: string,
  scope: MemoryScope,
  id: string,
): Promise<boolean> {
  validateMemoryId(id);
  const fact = await findMemoryFact(root, scope, id);
  if (fact === null) return false;
  // Deleting an article another article still supersedes would dangle a
  // provenance pointer: the supersession chain is how readers trace current
  // truth back through its raw evidence.
  // TODO: also check WorkManifest references when the manifest store lands.
  const blockers = (await discoverMemoryFacts(root, scope)).filter(
    (other) => other.id !== id && other.supersedes.includes(id),
  );
  if (blockers.length > 0) {
    throw new Error(
      `Cannot delete memory article [${scope}] ${id}: still referenced in ` +
        `supersedes by ${blockers.map((other) => `[${scope}] ${other.id}`).join(", ")}. ` +
        `Update or delete the referencing article first.`,
    );
  }
  await rm(fact.path);
  await rebuildScopeIndex(root, scope);
  await appendLog(root, scope, todayIsoDate(), `delete | ${fact.title}`);
  return true;
}

/**
 * Age out a verification: a `verified` article whose check has grown old
 * becomes `stale` — visible in the index, still readable, never deleted.
 * Knowledge that has not been re-confirmed is not knowledge that has been
 * disproved, and deleting it would throw away the only record of what was
 * once true here. This is a status update on the
 * existing article, not a new observation, so unlike writeMemoryFact it
 * appends no raw file; the article file is rewritten through the same
 * serializer and the scope index and log stay consistent. Returns the demoted
 * article, or null when there is no verified article with that id.
 */
export async function demoteMemoryFact(
  root: string,
  scope: MemoryScope,
  id: string,
  options: { date?: string } = {},
): Promise<MemoryFact | null> {
  validateMemoryId(id);
  const fact = await findMemoryFact(root, scope, id);
  if (fact === null || fact.status !== "verified") return null;
  const date = options.date ?? todayIsoDate();
  const demoted = MemoryFactSchema.parse({ ...fact, status: "stale", date });
  await writeFile(fact.path, serializeMemoryFile(demoted));
  await rebuildScopeIndex(root, scope);
  await appendLog(root, scope, date, `stale-demote | ${fact.title}`);
  return demoted;
}

interface LegacyFact {
  id: string;
  title: string;
  body: string;
  tags: string[];
  date: string;
  source?: MemorySource;
  verified?: string;
  path: string;
  contents: string;
}

function parseLegacyFile(path: string, contents: string): LegacyFact {
  const id = basename(path, ".md");
  const lines = contents.split(/\r?\n/);
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  const fields = new Map<string, string>();
  if (lines[0]?.trim() === "---" && closingIndex > 0) {
    for (const line of lines.slice(1, closingIndex)) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      fields.set(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      );
    }
  }
  const source = MemorySourceSchema.safeParse(fields.get("source"));
  const fieldDate = fields.get("date");
  return {
    id,
    title: fields.get("title") ?? id,
    body: lines
      .slice(closingIndex > 0 ? closingIndex + 1 : 0)
      .join("\n")
      .trim(),
    tags: parseList(fields.get("tags") ?? "[]"),
    date:
      fieldDate !== undefined && ISO_DATE.test(fieldDate)
        ? fieldDate
        : todayIsoDate(),
    source: source.success ? source.data : undefined,
    verified: ISO_DATE.test(fields.get("verified") ?? "")
      ? fields.get("verified")
      : undefined,
    path,
    contents,
  };
}

async function discoverLegacyFacts(
  root: string,
  scope: MemoryScope,
): Promise<LegacyFact[]> {
  const directory = scopeRoot(root, scope);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  const facts: LegacyFact[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(directory, entry.name);
    facts.push(parseLegacyFile(path, await readFile(path, "utf8")));
  }
  return facts;
}

function legacyTopic(fact: LegacyFact): string {
  const aliases: Record<string, string> = {
    router: "routing",
    routing: "routing",
    model: "routing",
    fable: "routing",
    codex: "routing",
    quota: "quota",
    delivery: "delivery",
    telemetry: "telemetry",
    landing: "landing",
    graphify: "graphify",
    orchestration: "delivery",
    workspace: "workspace-ui",
    "workspace-ui": "workspace-ui",
    swiftterm: "workspace-ui",
    release: "release",
    update: "release",
    packaging: "release",
    skill: "skills",
    skills: "skills",
    memory: "memory",
    autonomy: "autonomy",
    spawn: "spawn",
    lifecycle: "lifecycle",
    testing: "testing",
    discovery: "discovery",
    "stranded-work": "stranded-work",
    context: "context",
    handoff: "operations",
    restart: "operations",
    session: "operations",
  };
  for (const tag of fact.tags) {
    if (aliases[tag] !== undefined) return aliases[tag];
  }
  return slugify(fact.tags[0] ?? "general", 60);
}

export interface MemoryMigrationReport {
  scanned: number;
  migrated: number;
  flagged: Array<{
    scope: MemoryScope;
    id: string;
    status: MemoryVerificationStatus;
  }>;
  backups: Array<{ scope: MemoryScope; path: string }>;
  alreadyMigrated: MemoryScope[];
}

const LEGACY_MIGRATION_MARKER = ".legacy-migration-v1.json";

async function migrationMarker(
  root: string,
  scope: MemoryScope,
): Promise<{ backup: string; completedAt: string } | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(
        join(wikiRoot(root, scope), LEGACY_MIGRATION_MARKER),
        "utf8",
      ),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Invalid legacy memory migration marker");
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => key !== "backup" && key !== "completedAt",
      ) ||
      typeof record.backup !== "string" ||
      record.backup.length === 0 ||
      typeof record.completedAt !== "string" ||
      !Number.isFinite(Date.parse(record.completedAt))
    )
      throw new Error("Invalid legacy memory migration marker");
    return { backup: record.backup, completedAt: record.completedAt };
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function backupLegacyMemory(
  root: string,
  scope: MemoryScope,
): Promise<string> {
  const source = scopeRoot(root, scope);
  const backupRoot = join(dirname(source), "memory-backups");
  await mkdir(backupRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let destination = join(backupRoot, `legacy-v1-${timestamp}`);
  let suffix = 2;
  while (true) {
    try {
      await cp(source, destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      return destination;
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ERR_FS_CP_EEXIST"
        )
      )
        throw error;
      destination = join(backupRoot, `legacy-v1-${timestamp}-${suffix}`);
      suffix += 1;
    }
  }
}

async function restoreLegacyBackup(
  root: string,
  scope: MemoryScope,
  backup: string,
): Promise<void> {
  const source = scopeRoot(root, scope);
  const parent = dirname(source);
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const restored = join(parent, `memory-restore-${suffix}`);
  const failed = join(parent, `memory-failed-${suffix}`);
  await cp(backup, restored, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await rename(source, failed);
  try {
    await rename(restored, source);
  } catch (error) {
    await rename(failed, source);
    await rm(restored, { recursive: true, force: true });
    throw error;
  }
  await rm(failed, { recursive: true, force: true });
}

async function migrateLegacyScope(
  root: string,
  scope: MemoryScope,
): Promise<MemoryMigrationReport> {
  const legacy = await discoverLegacyFacts(root, scope);
  if (legacy.length === 0) {
    return {
      scanned: 0,
      migrated: 0,
      flagged: [],
      backups: [],
      alreadyMigrated: [],
    };
  }
  if ((await migrationMarker(root, scope)) !== null) {
    return {
      scanned: legacy.length,
      migrated: 0,
      flagged: [],
      backups: [],
      alreadyMigrated: [scope],
    };
  }

  // This is deliberately the first write associated with migration. The
  // destination is outside the memory root, so the snapshot sees the complete
  // pre-migration corpus and cannot recursively include itself.
  const backup = await backupLegacyMemory(root, scope);
  console.error(`Hive backed up [${scope}] legacy memory to ${backup}`);
  try {
    const flagged: MemoryMigrationReport["flagged"] = [];
    let migrated = 0;
    for (const old of legacy) {
      const topic = legacyTopic(old);
      const status: MemoryVerificationStatus =
        old.verified === undefined
          ? "unverified"
          : old.verified < old.date
            ? "stale"
            : "verified";
      if (status !== "verified") flagged.push({ scope, id: old.id, status });
      const destination = join(
        rawRoot(root, scope),
        topic,
        `${old.date}-${old.id}.md`,
      );
      await mkdir(dirname(destination), { recursive: true });
      try {
        await writeFile(destination, old.contents, { flag: "wx" });
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
        if ((await readFile(destination, "utf8")) !== old.contents) {
          throw new Error(
            `Legacy raw destination already contains different evidence: ${destination}`,
          );
        }
      }
      const existing = await findMemoryFact(root, scope, old.id);
      const articlePath =
        existing?.path ?? join(wikiRoot(root, scope), topic, `${old.id}.md`);
      await mkdir(dirname(articlePath), { recursive: true });
      const rawReference = relative(dirname(articlePath), destination);
      if (existing !== null) {
        if (existing.raw.includes(rawReference)) continue;
        const conflicted = MemoryFactSchema.parse({
          ...existing,
          body:
            `${existing.body}\n\n## Uncompiled legacy observation\n\n` +
            `A newly discovered legacy source disagrees with or duplicates this article. ` +
            `Reconcile the raw observation before treating either account as current.`,
          date: todayIsoDate(),
          evidence: `${existing.evidence}; conflicting legacy flat memory ${old.id}`,
          status: "conflicted",
          raw: [...existing.raw, rawReference],
        });
        await writeFile(articlePath, serializeMemoryFile(conflicted));
        flagged.push({ scope, id: old.id, status: "conflicted" });
        migrated += 1;
        await appendLog(
          root,
          scope,
          todayIsoDate(),
          `migrate-conflict | ${existing.title}`,
        );
        continue;
      }
      const article = MemoryFactSchema.parse({
        id: old.id,
        scope,
        topic,
        title: old.title.replace(/^CORRECTED:\s*/i, ""),
        body: old.body,
        tags: old.tags,
        date: old.date,
        path: articlePath,
        source: old.source ?? "legacy",
        evidence: `Migrated verbatim from legacy flat memory ${old.id}`,
        status,
        supersedes: [],
        raw: [rawReference],
        verified: old.verified,
      });
      await writeFile(articlePath, serializeMemoryFile(article));
      migrated += 1;
      await appendLog(
        root,
        scope,
        todayIsoDate(),
        `migrate | ${article.title}`,
      );
    }
    await rebuildScopeIndex(root, scope);
    await writeFile(
      join(wikiRoot(root, scope), LEGACY_MIGRATION_MARKER),
      `${JSON.stringify(
        { completedAt: new Date().toISOString(), backup },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    return {
      scanned: legacy.length,
      migrated,
      flagged,
      backups: [{ scope, path: backup }],
      alreadyMigrated: [],
    };
  } catch (error) {
    await restoreLegacyBackup(root, scope, backup);
    throw error;
  }
}

export async function migrateLegacyMemory(
  root: string,
): Promise<MemoryMigrationReport> {
  const [repo, global] = await Promise.all([
    migrateLegacyScope(root, "repo"),
    migrateLegacyScope(root, "global"),
  ]);
  return {
    scanned: repo.scanned + global.scanned,
    migrated: repo.migrated + global.migrated,
    flagged: [...repo.flagged, ...global.flagged],
    backups: [...repo.backups, ...global.backups],
    alreadyMigrated: [...repo.alreadyMigrated, ...global.alreadyMigrated],
  };
}

export function factVerificationFlag(fact: {
  status?: MemoryVerificationStatus;
  date: string;
  verified?: string;
}): "unverified" | "stale" | "conflicted" | null {
  if (
    fact.status === "unverified" ||
    fact.status === "stale" ||
    fact.status === "conflicted"
  )
    return fact.status;
  if (fact.status === "verified") return null;
  if (fact.verified === undefined) return "unverified";
  return fact.verified < fact.date ? "stale" : null;
}

export async function rebuildMemoryIndexFiles(
  root: string,
): Promise<MemoryMigrationReport> {
  const migration = await migrateLegacyMemory(root);
  await Promise.all([
    rebuildScopeIndex(root, "repo"),
    rebuildScopeIndex(root, "global"),
  ]);
  return migration;
}

async function readIndexRows(
  root: string,
  scope: MemoryScope,
): Promise<string[]> {
  try {
    return (await readFile(join(wikiRoot(root, scope), "index.md"), "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- ["));
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

// Deciding which memory is relevant to a task keeps its stopword list tiny on
// purpose: the length floor does most of the filtering, and a bigger list is
// more ways to silently drop a token that would have matched.
const BRIEF_STOPWORDS = new Set([
  "the",
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "were",
  "your",
  "task",
  "agent",
]);

function significantTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const token = match[0];
    if (token.length >= 4 && !BRIEF_STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

export interface BuildMemoryIndexOptions {
  /** The assignment brief; rows sharing a significant token outrank the rest. */
  brief?: string;
}

export async function buildMemoryIndex(
  root: string,
  options: BuildMemoryIndexOptions = {},
): Promise<string> {
  await rebuildMemoryIndexFiles(root);
  const briefTokens =
    options.brief === undefined
      ? new Set<string>()
      : significantTokens(options.brief);
  const rows = [
    ...(await readIndexRows(root, "repo")),
    ...(await readIndexRows(root, "global")),
  ]
    .map((row) => {
      const rowTokens = briefTokens.size === 0 ? null : significantTokens(row);
      let matches = 0;
      if (rowTokens !== null) {
        for (const token of briefTokens) {
          if (rowTokens.has(token)) matches += 1;
        }
      }
      return {
        row,
        date: row.match(/\((\d{4}-\d{2}-\d{2})\)/)?.[1] ?? "",
        pitfall: row.includes("[pitfall]"),
        matches,
      };
    })
    .sort((a, b) => {
      // Pitfalls first, newest-first within the class; then articles sharing a
      // significant brief token (most distinct matches, then recency); then
      // newest fill. Each row is sorted exactly once, so no row appears twice.
      if (a.pitfall !== b.pitfall) return a.pitfall ? -1 : 1;
      if (!a.pitfall && a.matches !== b.matches) return b.matches - a.matches;
      return b.date.localeCompare(a.date) || a.row.localeCompare(b.row);
    })
    .map(({ row }) => row);
  if (rows.length === 0) return "";
  const shown = rows.slice(0, MEMORY_INDEX_MAX_ENTRIES);
  const omitted = rows.length - shown.length;
  return [
    "Hive memory index — compiled durable repo knowledge. Pull the full article with memory_read(scope, id); [unverified], [stale], and [conflicted] articles are claims to reconcile before acting. Search more with memory_search.",
    ...shown,
    ...(omitted > 0
      ? [
          `(${omitted} older article${omitted === 1 ? "" : "s"} omitted — use memory_search)`,
        ]
      : []),
  ].join("\n");
}
