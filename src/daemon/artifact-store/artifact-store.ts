// Where an agent's finished work products live. Mail is a conversation: a
// settled message body is gone, so an analysis delivered only by mail dies with
// the mailbox. An artifact is a file — one Markdown document per work product,
// under the project's own artifacts directory, named by the same `art_` id the
// board's task records already accept as evidence. So a task can point at the
// analysis that justified it, and the analysis is still there to read.
//
// A file, not a row: the hive database is runtime state and is expected to be
// thrown away, and a work product has to outlive that and be readable by a
// user with no Hive at all. The frontmatter carries what the file's path
// cannot (who wrote it, when, what it is called); everything after the closing
// fence is the body exactly as it was handed in.
//
// The board cites artifacts as permanent evidence, so the store lives at the
// machine-level home, not under the live HIVE_HOME: an installed session runs
// out of a fresh per-run instance home, and an artifact written there would be
// stranded every session. Writes go only to the machine-level root. Artifacts
// written before the move stay where they are — nothing here deletes them —
// and reads fall back to that pre-move root so an id minted before the move
// still resolves.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getHiveHome, machineHiveHome } from "../../hive-home/home";
import { ArtifactRefIdSchema } from "../../schemas/hierarchy-ids";
import { projectKey } from "../project-identity-core/state";

const FENCE = "---";
const DAY_MS = 24 * 3_600_000;

/** What the store knows about an artifact besides its body. */
export interface ArtifactMetadata {
  artifactId: string;
  /** The board task or run this work product belongs to. */
  taskOrRunId: string;
  title: string | null;
  /** The capability subject that put it here. */
  author: string;
  createdAt: string;
  storagePath: string;
}

export interface StoredArtifact extends ArtifactMetadata {
  body: string;
}

/** This project's artifact root, where every new artifact is written: the machine-level home behind the live HIVE_HOME. A named or per-repo instance home resolves back to the default home, so artifacts are not trapped inside one instance directory. Keyed by the same project uuid the rest of Hive's per-project state uses, so moving or renaming the checkout does not orphan what agents wrote. */
export function artifactsRoot(repoRoot: string): string {
  return join(machineHiveHome(), "artifacts", projectKey(repoRoot));
}

/** Where artifacts written before the store moved to the machine-level home live: under the instance's own home. Read-only fallback — nothing is ever written here anymore, and nothing here deletes what is already there. */
export function legacyArtifactsRoot(repoRoot: string): string {
  return join(getHiveHome(), "artifacts", projectKey(repoRoot));
}

/** Every root a read may find an artifact under, durable first. One entry when the live home already is the machine-level one. */
export function artifactReadRoots(repoRoot: string): string[] {
  const durable = artifactsRoot(repoRoot);
  const legacy = legacyArtifactsRoot(repoRoot);
  return resolve(durable) === resolve(legacy) ? [durable] : [durable, legacy];
}

function serialize(metadata: ArtifactMetadata, body: string): string {
  const lines = [
    FENCE,
    `artifact: ${metadata.artifactId}`,
    `belongsTo: ${metadata.taskOrRunId}`,
    `author: ${metadata.author}`,
    `created: ${metadata.createdAt}`,
  ];
  if (metadata.title !== null) lines.push(`title: ${metadata.title}`);
  lines.push(FENCE, "");
  return `${lines.join("\n")}${body}`;
}

/** Reads one artifact file back. Returns null for anything this store did not write: a file with no readable frontmatter is left alone rather than guessed at. */
function parse(storagePath: string, contents: string): StoredArtifact | null {
  const lines = contents.split("\n");
  if (lines[0] !== FENCE) return null;
  const closing = lines.indexOf(FENCE, 1);
  if (closing < 0) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, closing)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const artifactId = fields.get("artifact");
  const taskOrRunId = fields.get("belongsTo");
  const author = fields.get("author");
  const createdAt = fields.get("created");
  if (
    artifactId === undefined ||
    taskOrRunId === undefined ||
    author === undefined ||
    createdAt === undefined
  ) {
    return null;
  }
  return {
    artifactId,
    taskOrRunId,
    title: fields.get("title") ?? null,
    author,
    createdAt,
    storagePath,
    body: lines.slice(closing + 1).join("\n"),
  };
}

/** Mints the id and writes the file. The id is parsed through the board's own ArtifactRef schema, so an id this store hands out is always one hive_task_update will accept as evidence. */
export function putArtifact(input: {
  root: string;
  taskOrRunId: string;
  title: string | null;
  author: string;
  body: string;
  now: Date;
}): ArtifactMetadata {
  const artifactId = ArtifactRefIdSchema.parse(`art_${Bun.randomUUIDv7()}`);
  const directory = join(input.root, input.taskOrRunId);
  mkdirSync(directory, { recursive: true });
  const metadata: ArtifactMetadata = {
    artifactId,
    taskOrRunId: input.taskOrRunId,
    title: input.title,
    author: input.author,
    createdAt: input.now.toISOString(),
    storagePath: join(directory, `${artifactId}.md`),
  };
  writeFileSync(metadata.storagePath, serialize(metadata, input.body));
  return metadata;
}

function taskDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

/** Finds an artifact by id alone: the caller knows the id it was given, not which task directory holds it. */
export function getArtifact(
  root: string,
  artifactId: string,
): StoredArtifact | null {
  for (const directory of taskDirectories(root)) {
    const storagePath = join(directory, `${artifactId}.md`);
    if (existsSync(storagePath)) {
      return parse(storagePath, readFileSync(storagePath, "utf8"));
    }
  }
  return null;
}

/** Deletes artifacts older than the configured retention and returns how many went. Ages are read from the recorded `created` stamp rather than the file's mtime, so copying the store around does not reset the clock. The root can be shared by two daemons now that it resolves to the machine-level home, so a file another sweeper took first is skipped, not an error. */
export function sweepArtifacts(
  root: string,
  retentionDays: number,
  now: Date,
): number {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  let deleted = 0;
  for (const directory of taskDirectories(root)) {
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".md")) continue;
      const storagePath = join(directory, file);
      const stored = parse(storagePath, readFileSync(storagePath, "utf8"));
      if (stored === null || stored.createdAt >= cutoff) continue;
      try {
        rmSync(storagePath);
        deleted += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (readdirSync(directory).length === 0) {
      try {
        rmdirSync(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A peer sweeper emptied it first, or a peer writer refilled it.
        if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
      }
    }
  }
  return deleted;
}
