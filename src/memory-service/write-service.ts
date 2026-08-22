import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../adapters/file-lock";
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
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: MemoryWriteServiceDeps) {
    this.repoRoot = deps.repoRoot;
    this.index = deps.index;
    this.embeddingIndex = deps.embeddingIndex;
  }

  /** Runs an operation inside the memory critical section. Writes, deletes, reindexes and the retention sweep share one promise chain so concurrent MCP calls never race on slug generation or interleave a rebuild with an in-flight upsert, and one file lock so a second process cannot do the same. Public because a caller that has to fence on a revision needs its read and its write inside ONE section. */
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const locked = async (): Promise<T> => {
      const directory = join(this.repoRoot, ".hive");
      await mkdir(directory, { recursive: true });
      return withFileLock(join(directory, "memory.lock"), operation);
    };
    const run = this.chain.then(locked, locked);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    return this.serialize(() => this.writeLocked(input));
  }

  async writeLocked(input: MemoryWriteInput): Promise<MemoryWriteResult> {
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
    return this.serialize(async () => {
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
    return this.serialize(() => this.deleteLocked(scope, id));
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
