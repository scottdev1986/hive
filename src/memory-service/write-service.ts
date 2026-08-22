import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../adapters/file-lock";
import { getHiveHome } from "../hive-home/home";
import type {
  MemoryFact,
  MemoryScope,
  MemoryWriteInput,
} from "../schemas/memory";
import {
  MemoryEmbeddingIndex,
  type MemoryEmbeddingWriteOutcome,
} from "./embeddings";
import type { MemoryIndex } from "./fts-index";
import {
  deleteMemoryFact as deleteMemoryFactFile,
  verifyMemoryFact as verifyMemoryFactFile,
  writeMemoryFact as writeMemoryFactFile,
} from "./memory-store";
import type { MemoryWriteFileResult } from "./store-records";

export interface MemoryWriteServiceDeps {
  repoRoot: string;
  index: MemoryIndex;
  embeddingIndex: MemoryEmbeddingIndex | null;
}

export type MemoryWriteResult = MemoryWriteFileResult & {
  embedding: MemoryEmbeddingWriteOutcome;
};

export class MemoryWriteService {
  readonly repoRoot: string;
  private readonly index: MemoryIndex;
  private readonly embeddingIndex: MemoryEmbeddingIndex | null;
  private repoChain: Promise<unknown> = Promise.resolve();
  private globalChain: Promise<unknown> = Promise.resolve();

  constructor(deps: MemoryWriteServiceDeps) {
    this.repoRoot = deps.repoRoot;
    this.index = deps.index;
    this.embeddingIndex = deps.embeddingIndex;
  }

  /** P0: Per-scope lock paths. Global writes take ~/.hive/memory/memory.lock; repo writes take <repo>/.hive/memory.lock. */
  private getLockPath(scope: MemoryScope): string {
    if (scope === "global") {
      return join(getHiveHome(), "memory", "memory.lock");
    }
    return join(this.repoRoot, ".hive", "memory.lock");
  }

  /** Runs an operation inside the memory critical section. Writes, deletes, reindexes and the retention sweep share one promise chain per scope so concurrent MCP calls never race on slug generation or interleave a rebuild with an in-flight upsert, and one file lock per scope so a second process cannot do the same. Public because a caller that has to fence on a revision needs its read and its write inside ONE section. */
  serialize<T>(scope: MemoryScope, operation: () => Promise<T>): Promise<T> {
    const chain = scope === "global" ? this.globalChain : this.repoChain;
    const locked = async (): Promise<T> => {
      const lockPath = this.getLockPath(scope);
      await mkdir(join(lockPath, ".."), { recursive: true });
      return withFileLock(lockPath, operation);
    };
    const run = chain.then(locked, locked);
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    if (scope === "global") {
      this.globalChain = next;
    } else {
      this.repoChain = next;
    }
    return run;
  }

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    return this.serialize(input.scope, () => this.writeLocked(input));
  }

  /** P0: Pre-write gate checks for duplicates/updates before writing. */
  private async preWriteCheck(
    input: MemoryWriteInput,
  ): Promise<"add" | "update" | "noop"> {
    // If id is provided and supersedes itself, this is an explicit update
    if (
      input.id !== undefined &&
      input.supersedes.length > 0 &&
      input.supersedes.includes(input.id)
    ) {
      return "update";
    }

    // If id is provided but not in supersedes, caller is creating with specific id
    if (input.id !== undefined && input.supersedes.length === 0) {
      return "add";
    }

    // Search for similar facts by normalized title (dedup-before-write)
    const normalizeTitle = (title: string): string =>
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    const facts = await (
      await import("./memory-store")
    ).discoverMemoryFacts(this.repoRoot, input.scope);
    const normalized = normalizeTitle(input.title);
    const duplicate = facts.find(
      (fact) => normalizeTitle(fact.title) === normalized,
    );

    if (duplicate === undefined) {
      return "add";
    }

    // Check if body is identical - if so, this is a NOOP (no write needed)
    if (duplicate.body === input.body) {
      // Mutate input to reference the existing fact for consistent return
      if (input.id === undefined) {
        input.id = duplicate.id;
      }
      input.topic = duplicate.topic;
      return "noop";
    }

    // Found duplicate with same normalized title but different body - this becomes an update
    // Mutate input to target the existing id and supersede it
    if (input.id === undefined) {
      input.id = duplicate.id;
    }
    if (!input.supersedes.includes(duplicate.id)) {
      input.supersedes = [...input.supersedes, duplicate.id];
    }
    input.topic = duplicate.topic; // preserve topic on update

    return "update";
  }

  async writeLocked(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    // P0: Pre-write gate determines ADD/UPDATE/NOOP
    const action = await this.preWriteCheck(input);

    // NOOP: identical body, skip write and return existing fact
    if (action === "noop") {
      const { readMemoryFact } = await import("./memory-store");
      const existing = await readMemoryFact(
        this.repoRoot,
        input.scope,
        input.id!,
      );
      if (existing === null) {
        throw new Error(
          `NOOP gate expected existing fact [${input.scope}] ${input.id} but not found`,
        );
      }
      // Return existing fact without writing - mark embedding as skipped
      return {
        ...existing,
        path: existing.path,
        rawPath: "", // NOOP doesn't create a new raw observation
        supersededIds: [],
        embedding: "skipped:noop",
      };
    }

    const written = await writeMemoryFactFile(this.repoRoot, input);
    for (const id of written.supersededIds) {
      this.index.removeFact(input.scope, id);
      this.embeddingIndex?.removeArticle(input.scope, id);
    }
    this.index.upsertFact(written);
    const embedding: MemoryEmbeddingWriteOutcome =
      this.embeddingIndex === null
        ? "unavailable:disabled"
        : await this.embeddingIndex.upsertArticle(
            written.scope,
            written.id,
            MemoryEmbeddingIndex.articleText(written),
          );
    return { ...written, embedding };
  }

  /** Stamp a verification from a session other than the author's. Only the FTS row is refreshed: `status` is part of what search returns, but the vector is embedded from title and body alone, and neither changes here. Re-embedding an unchanged article would spend a model call to store the same numbers. */
  async verify(
    scope: MemoryScope,
    id: string,
    options: { verifier: string; date?: string },
  ): Promise<MemoryFact> {
    return this.serialize(scope, async () => {
      const verified = await verifyMemoryFactFile(
        this.repoRoot,
        scope,
        id,
        options,
      );
      this.index.upsertFact(verified);
      return verified;
    });
  }

  async delete(scope: MemoryScope, id: string): Promise<boolean> {
    return this.serialize(scope, () => this.deleteLocked(scope, id));
  }

  async deleteLocked(scope: MemoryScope, id: string): Promise<boolean> {
    const deleted = await deleteMemoryFactFile(this.repoRoot, scope, id);
    if (deleted) {
      this.index.removeFact(scope, id);
      this.embeddingIndex?.removeArticle(scope, id);
    }
    return deleted;
  }
}
