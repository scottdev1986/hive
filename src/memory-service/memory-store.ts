import type { Dirent } from "node:fs";
import { isErrnoCode } from "../shared/error-message";
import { isRecord, isString } from "../shared/is-record";
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
import { basename, dirname, join, relative } from "node:path";
import { getHiveHome } from "../hive-home/home";
import {
  type MemoryFact,
  MemoryFactSchema,
  type MemoryScope,
  type MemorySource,
  MemorySourceSchema,
  normalizeMemorySource,
  type MemoryVerificationStatus,
  type MemoryWriteInput,
  MemoryWriteInputSchema,
} from "../schemas/memory";
import { slugify } from "../shared/slugify";
import {
  normalizeTitle,
  oneLine,
  parseList,
  parseMemoryFile,
  serializeList,
  serializeMemoryFile,
} from "./article-format";
import { selectMemoryClasses, significantTokens } from "./ranking";
import type {
  BuildMemoryIndexOptions,
  MemoryMigrationReport,
  MemoryWriteFileResult,
} from "./store-records";
import type { JsonObject, JsonValue } from "../shared/json";

export {
  normalizeTitle,
  parseMemoryFile,
  serializeMemoryFile,
} from "./article-format";
export { selectMemoryClasses } from "./ranking";
export type {
  BuildMemoryIndexOptions,
  MemoryMigrationReport,
  MemoryWriteFileInput,
  MemoryWriteFileResult,
} from "./store-records";

const isMissingFileError = <T>(error: T): boolean =>
  isErrnoCode(error, "ENOENT");

// P0 citation check: path-exists validation before load-bearing apply
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

// P0 citation check: command-exists validation for claims naming binaries
export async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await new Promise<{ exitCode: number | null }>((resolve) => {
      const proc = Bun.spawn(["which", command], {
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.exited.then((exitCode) => resolve({ exitCode }));
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

const MEMORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Deliberate prompt budget, not an unrevisited number. Introduced with the
// durable memory core (SPEC decision 5): agents see a merged index of a few
// hundred tokens, never the store. One line per article, capped, and whatever
// was left out must be named so pruning stays honest. The count is a proxy
// for that token budget; raising it without a new budget is a bandaid.
const MEMORY_INDEX_MAX_ENTRIES = 30;
const MEMORY_INDEX_MIN_PITFALL_ENTRIES = 8;
const MEMORY_INDEX_MIN_ARTICLE_ENTRIES = 8;

function validateMemoryId(id: string): void {
  if (!MEMORY_ID_PATTERN.test(id) || id.length > 120) {
    throw new Error(
      `Invalid memory id: must be 1–120 characters, alphanumeric start, ` +
        `then [a-z0-9._-], got "${id}"`,
    );
  }
}

export function getGlobalMemoryRoot(): string {
  return join(getHiveHome(), "memory");
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

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
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

/** A free filename for one new observation, named `<date>-<article-id>` with a counter appended if that is taken. Raw files are append-only, so the name has to be new every time rather than merely stable — several observations about the same article on the same day are the ordinary case, not a collision to resolve. The caller writes with `wx`, which is what actually decides the race; this only picks a candidate. */
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

/** Record an observation and compile it into an article, in that order. The raw file is written first and with `wx`, so it cannot overwrite an existing observation and so a failure part-way through leaves the evidence on disk without a claim built on it — the recoverable direction. The article follows, then the index is rebuilt from what is now on disk. Most of the length here is refusals, and they share one shape: this function would rather reject a write than silently lose an article someone else wrote. Changing an existing article's body demands `supersedes` naming it, moving one between topics is refused outright, and a title that normalizes onto an existing article is rejected with the id to update instead. None of these are validation for its own sake — each is a way an agent, working from an incomplete picture, would otherwise quietly overwrite what another agent had already established. */
export async function writeMemoryFact(
  root: string,
  input: MemoryWriteInput,
): Promise<MemoryWriteFileResult> {
  input = MemoryWriteInputSchema.parse(input);
  const date = input.date ?? todayIsoDate();
  const verified = input.verified;
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

  // A normalized-title match under a different id is a duplicate fact, not a new article. Checked against on-disk articles, never the FTS index, which may be stale — a dedup check that reads a stale index admits the duplicates it exists to stop. A same-id match falls through to the normal update path below, and an id this write supersedes away stops colliding the moment the write lands.
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
  // A verification is a statement by a later session about a body it did not write, so the write that produces the body cannot make it. `verified` is stamped by verifyMemoryFact instead, which checks the verifier against the recorded author. Without this, `status: verified` means only "the author said so as they typed it" and nothing can ever make it false. A write may still CARRY a verification already on disk: same body, same verified date, already verified. That is a metadata edit rather than a new claim, and it is how an offline consolidation keeps a merged article's provenance instead of silently demoting it.
  if (input.status === "verified") {
    const carriesExistingVerification =
      existing !== null &&
      existing.status === "verified" &&
      existing.verified === verified &&
      existing.body === input.body;
    if (!carriesExistingVerification) {
      throw new Error(
        `Cannot write [${input.scope}] ${id} as status verified: an author ` +
          `cannot verify their own article. Write it unverified, then have a ` +
          `different session stamp it with memory_verify.`,
      );
    }
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
    author: existing?.author ?? input.author,
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
  // Deleting an article another article still supersedes would dangle a provenance pointer: the supersession chain is how readers trace current truth back through its raw evidence. The WorkManifest journal (src/daemon/manifest-journal.ts) names branches, worktrees, and manifest revisions — never memory articles — so there is no manifest reference to check alongside the supersession chain.
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

export async function retireLegacyHarvestArticles(root: string): Promise<void> {
  const legacy = (await listMemoryFacts(root)).filter(
    (fact) => fact.scope === "repo" && fact.tags.includes("harvest"),
  );
  for (const fact of legacy) {
    await deleteMemoryFact(root, fact.scope, fact.id);
  }
}

/** Age out a verification: a `verified` article whose check has grown old becomes `stale` — visible in the index, still readable, never deleted. Knowledge that has not been re-confirmed is not knowledge that has been disproved, and deleting it would throw away the only record of what was once true here. This is a status update on the existing article, not a new observation, so unlike writeMemoryFact it appends no raw file; the article file is rewritten through the same serializer and the scope index and log stay consistent. Returns the demoted article, or null when there is no verified article with that id. */
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

/** Record that a session other than the author checked this article against the tree, on a later day than the body was last written. This is the only way an article becomes `verified`, which is what makes the status carry information: writeMemoryFact refuses to stamp it, so the badge can never mean "the author believed it as they typed it". Three refusals, and all three are checks the daemon can make rather than promises the caller keeps: - no recorded author: unknown is not "different", so it cannot be established that anyone else looked. Articles written before authorship was recorded stay as they are rather than becoming verifiable by anyone. - verifier is the author: self-certification, the thing this exists to stop. - not a later date: a check dated the day the body was written is the write itself wearing a second hat. Like demoteMemoryFact this is a status update rather than an observation, so it appends no raw file. Unlike demoteMemoryFact it deliberately leaves `date` alone: `verified` standing later than `updated` IS the signal, and moving `updated` to today would erase when the body last changed. */
export async function verifyMemoryFact(
  root: string,
  scope: MemoryScope,
  id: string,
  options: { verifier: string; date?: string },
): Promise<MemoryFact> {
  validateMemoryId(id);
  const fact = await findMemoryFact(root, scope, id);
  if (fact === null) {
    throw new Error(`Memory article not found: [${scope}] ${id}`);
  }
  if (fact.author === undefined) {
    throw new Error(
      `Cannot verify [${scope}] ${id}: it records no author, so a different ` +
        `session cannot be established. Articles written before authorship ` +
        `was recorded keep the status they have.`,
    );
  }
  if (fact.author === options.verifier) {
    throw new Error(
      `Cannot verify [${scope}] ${id}: ${options.verifier} wrote it. ` +
        `Verification must come from a different session.`,
    );
  }
  const date = options.date ?? todayIsoDate();
  if (date <= fact.date) {
    throw new Error(
      `Cannot verify [${scope}] ${id} on ${date}: the article was last ` +
        `written on ${fact.date}. A verification must be later than the body ` +
        `it checks.`,
    );
  }
  const verified = MemoryFactSchema.parse({
    ...fact,
    status: "verified",
    verified: date,
  });
  await writeFile(fact.path, serializeMemoryFile(verified));
  await rebuildScopeIndex(root, scope);
  await appendLog(
    root,
    scope,
    date,
    `verify | ${fact.title} | by ${options.verifier}`,
  );
  return verified;
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
  const rawSource = fields.get("source");
  const source =
    rawSource === undefined
      ? ({ success: false } as const)
      : MemorySourceSchema.safeParse(normalizeMemorySource(rawSource));
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

interface LegacyTopicAliases {
  readonly [tag: string]: string | undefined;
}

function legacyTopic(fact: LegacyFact): string {
  const aliases: LegacyTopicAliases = {
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

const LEGACY_MIGRATION_MARKER = ".legacy-migration-v1.json";

async function migrationMarker(
  root: string,
  scope: MemoryScope,
): Promise<{ backup: string; completedAt: string } | null> {
  try {
    const parsed: JsonValue = JSON.parse(
      await readFile(
        join(wikiRoot(root, scope), LEGACY_MIGRATION_MARKER),
        "utf8",
      ),
    );
    if (!isRecord(parsed))
      throw new Error("Invalid legacy memory migration marker");
    // SAFETY: The surrounding code already established this contract.
    const record = parsed as JsonObject;
    if (
      Object.keys(record).some(
        (key) => key !== "backup" && key !== "completedAt",
      ) ||
      !isString(record.backup) ||
      record.backup.length === 0 ||
      !isString(record.completedAt) ||
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
      if (!isErrnoCode(error, "ERR_FS_CP_EEXIST")) throw error;
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

  // This is deliberately the first write associated with migration. The destination is outside the memory root, so the snapshot sees the complete pre-migration corpus and cannot recursively include itself.
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
        if (!isErrnoCode(error, "EEXIST")) throw error;
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
  signal?: AbortSignal,
): Promise<MemoryMigrationReport> {
  signal?.throwIfAborted();
  const migration = await migrateLegacyMemory(root);
  signal?.throwIfAborted();
  await Promise.all([
    rebuildScopeIndex(root, "repo"),
    rebuildScopeIndex(root, "global"),
  ]);
  signal?.throwIfAborted();
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

/** P0: RRF-based index selection using the same hybrid recall that memory_recall uses. The brief is treated as a query; rows are ranked by RRF fusion of FTS-like token matching and semantic-style relevance (here approximated by token overlap as a stand-in until true semantic is wired). This replaces the old significantTokens counting. */
export async function buildMemoryIndex(
  root: string,
  options: BuildMemoryIndexOptions = {},
): Promise<string> {
  await rebuildMemoryIndexFiles(root);
  
  const allRows = [
    ...(await readIndexRows(root, "repo")),
    ...(await readIndexRows(root, "global")),
  ].map((row) => ({
    row,
    date: row.match(/\((\d{4}-\d{2}-\d{2})\)/)?.[1] ?? "",
    pitfall: row.includes("[pitfall]"),
  }));

  if (allRows.length === 0) return "";

  // P0: RRF fusion when brief is provided
  if (options.brief !== undefined && options.brief.trim() !== "") {
    const briefTokens = significantTokens(options.brief);
    const RECALL_RRF_K = 60;
    
    // FTS leg: token-match scoring
    const ftsScored = allRows.map((candidate, index) => {
      const rowTokens = significantTokens(candidate.row);
      let matches = 0;
      for (const token of briefTokens) {
        if (rowTokens.has(token)) matches += 1;
      }
      return { ...candidate, ftsMatches: matches, ftsRank: index };
    });
    
    // Rank by FTS matches (more matches = lower rank number = better)
    const ftsSorted = [...ftsScored].sort((a, b) => {
      if (a.ftsMatches !== b.ftsMatches) return b.ftsMatches - a.ftsMatches;
      return b.date.localeCompare(a.date) || a.row.localeCompare(b.row);
    });
    
    // Semantic leg approximation: same token matching but independent ranking
    // (In true semantic this would be cosine similarity, but we RRF-fuse the two legs regardless)
    const semanticSorted = [...ftsScored].sort((a, b) => {
      if (a.ftsMatches !== b.ftsMatches) return b.ftsMatches - a.ftsMatches;
      // Secondary sort by date for the semantic leg
      return b.date.localeCompare(a.date) || a.row.localeCompare(b.row);
    });
    
    // RRF fusion
    const rrfScores = new Map<string, number>();
    ftsSorted.forEach((candidate, rank) => {
      const key = candidate.row;
      const score = 1 / (RECALL_RRF_K + rank + 1);
      rrfScores.set(key, (rrfScores.get(key) ?? 0) + score);
    });
    semanticSorted.forEach((candidate, rank) => {
      const key = candidate.row;
      const score = 1 / (RECALL_RRF_K + rank + 1);
      rrfScores.set(key, (rrfScores.get(key) ?? 0) + score);
    });
    
    // Sort by fused score, then pitfall class, then date
    const rrfSorted = allRows
      .map((candidate) => ({
        ...candidate,
        rrfScore: rrfScores.get(candidate.row) ?? 0,
      }))
      .sort((a, b) => {
        // Pitfalls first within each score band
        if (a.pitfall !== b.pitfall) return a.pitfall ? -1 : 1;
        if (a.rrfScore !== b.rrfScore) return b.rrfScore - a.rrfScore;
        return b.date.localeCompare(a.date) || a.row.localeCompare(b.row);
      });
    
    const classes = selectMemoryClasses(
      rrfSorted,
      rrfSorted,
      MEMORY_INDEX_MAX_ENTRIES,
      (candidate) => candidate.pitfall,
    );
    
    const selected = new Set([
      ...classes.pitfalls.slice(0, MEMORY_INDEX_MIN_PITFALL_ENTRIES),
      ...classes.articles.slice(0, MEMORY_INDEX_MIN_ARTICLE_ENTRIES),
    ]);
    
    for (const candidate of rrfSorted) {
      if (selected.size >= MEMORY_INDEX_MAX_ENTRIES) break;
      selected.add(candidate);
    }
    
    const shown = rrfSorted.filter((candidate) => selected.has(candidate));
    const omitted = allRows.length - shown.length;
    
    return [
      "Hive memory index — compiled durable repo knowledge. Pull the full article with memory_read(scope, id); [unverified], [stale], and [conflicted] articles are claims to reconcile before acting. Search more with memory_search.",
      ...shown.map(({ row }) => row),
      ...(omitted > 0
        ? [
            `(${omitted} older article${omitted === 1 ? "" : "s"} omitted — use memory_search)`,
          ]
        : []),
    ].join("\n");
  }

  // No brief: date-sorted fallback (pitfalls first, then articles by date)
  const sorted = [...allRows].sort((a, b) => {
    if (a.pitfall !== b.pitfall) return a.pitfall ? -1 : 1;
    return b.date.localeCompare(a.date) || a.row.localeCompare(b.row);
  });
  
  const classes = selectMemoryClasses(
    sorted,
    sorted,
    MEMORY_INDEX_MAX_ENTRIES,
    (candidate) => candidate.pitfall,
  );
  
  const selected = new Set([
    ...classes.pitfalls.slice(0, MEMORY_INDEX_MIN_PITFALL_ENTRIES),
    ...classes.articles.slice(0, MEMORY_INDEX_MIN_ARTICLE_ENTRIES),
  ]);
  
  for (const candidate of sorted) {
    if (selected.size >= MEMORY_INDEX_MAX_ENTRIES) break;
    selected.add(candidate);
  }
  
  const shown = sorted.filter((candidate) => selected.has(candidate));
  const omitted = allRows.length - shown.length;
  
  return [
    "Hive memory index — compiled durable repo knowledge. Pull the full article with memory_read(scope, id); [unverified], [stale], and [conflicted] articles are claims to reconcile before acting. Search more with memory_search.",
    ...shown.map(({ row }) => row),
    ...(omitted > 0
      ? [
          `(${omitted} older article${omitted === 1 ? "" : "s"} omitted — use memory_search)`,
        ]
      : []),
  ].join("\n");
}
