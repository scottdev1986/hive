import type { Database } from "bun:sqlite";
import {
  type MemoryFact,
  type MemoryKind,
  type MemoryScope,
  type MemorySearchResult,
  MemorySearchResultSchema,
  type MemorySimilarCandidate,
} from "../schemas/memory";
import {
  listMemoryFacts,
  rebuildMemoryIndexFiles,
  retireLegacyHarvestArticles,
} from "./memory-store";
import type { MemoryMigrationReport } from "./store-records";

const FTS_STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "get",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "over",
  "should",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

export function ftsQueryPasses(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) {
    return [];
  }
  const content = tokens.filter(
    (token) => !FTS_STOPWORDS.has(token.toLowerCase()),
  );
  const searchable = content.length === 0 ? tokens : content;
  const quoted = searchable.map((token) => `"${token}"`);
  if (quoted.length === 1) {
    return [quoted.join("")];
  }
  return [quoted.join(" AND "), quoted.join(" OR ")];
}

// Dedup layer 2 (HiveMemory plan D1): advisory FTS bm25 candidates over the index the caller has just upserted the written fact into, so the freshly written article is searchable here. The write already succeeded — candidates only tell the calling agent what to resolve with a follow-up update. Pure query helper shared by the daemon's memory_write tool and the memory self-test, so both exercise the exact same candidate logic.
export function findSimilarMemoryCandidates(
  index: MemoryIndex,
  written: Pick<MemoryFact, "scope" | "id" | "title">,
): MemorySimilarCandidate[] {
  return index
    .search(written.title, { limit: 4 })
    .filter(
      (result) => !(result.scope === written.scope && result.id === written.id),
    )
    .slice(0, 3)
    .map(({ scope, id, title }) => ({ scope, id, title }));
}

function encodeTags(tags: string[]): string {
  return JSON.stringify(tags);
}

function decodeTags(tags: unknown): string[] {
  if (typeof tags !== "string") return [];
  const parsed: unknown = JSON.parse(tags);
  return Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string")
    ? parsed
    : [];
}

export class MemoryIndex {
  constructor(private readonly database: Database) {
    this.database.exec(`
      DROP TABLE IF EXISTS memory_fts;
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        id, scope UNINDEXED, topic UNINDEXED, title, body, tags,
        date UNINDEXED, status UNINDEXED, path UNINDEXED,
        kind UNINDEXED, source UNINDEXED,
        tokenize = 'porter'
      )
    `);
  }

  private insertRow(fact: MemoryFact): void {
    this.database
      .query(
        `
      INSERT INTO memory_fts (id, scope, topic, title, body, tags, date, status, path, kind, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        fact.id,
        fact.scope,
        fact.topic,
        fact.title,
        fact.body,
        encodeTags(fact.tags),
        fact.date,
        fact.status,
        fact.path,
        fact.kind,
        fact.source,
      );
  }

  private deleteRow(scope: MemoryScope, id: string): void {
    this.database
      .query(
        `
      DELETE FROM memory_fts WHERE id = ? AND scope = ?
    `,
      )
      .run(id, scope);
  }

  upsertFact(fact: MemoryFact): void {
    this.database.transaction(() => {
      this.deleteRow(fact.scope, fact.id);
      this.insertRow(fact);
    })();
  }

  removeFact(scope: MemoryScope, id: string): void {
    this.deleteRow(scope, id);
  }

  async rebuild(
    root: string,
    signal?: AbortSignal,
  ): Promise<{
    count: number;
    migration: MemoryMigrationReport;
  }> {
    signal?.throwIfAborted();
    const migration = await rebuildMemoryIndexFiles(root, signal);
    signal?.throwIfAborted();
    await retireLegacyHarvestArticles(root);
    signal?.throwIfAborted();
    const facts = await listMemoryFacts(root);
    signal?.throwIfAborted();
    this.database.transaction((rows: MemoryFact[]) => {
      this.database.exec("DELETE FROM memory_fts");
      for (const fact of rows) {
        this.insertRow(fact);
      }
    })(facts);
    return { count: facts.length, migration };
  }

  count(): number {
    const row = this.database
      .query("SELECT COUNT(*) AS n FROM memory_fts")
      .get() as { n: number };
    return row.n;
  }

  /** `kind` narrows the search in SQL rather than after it. A caller that wants only pitfalls and filters the results itself gets the limit applied to all articles first, so a pitfall ranked below the limit is discarded before the caller ever sees it. */
  search(
    query: string,
    options: {
      scope?: MemoryScope;
      limit?: number;
      kind?: MemoryKind;
    } = {},
  ): MemorySearchResult[] {
    const limit = options.limit ?? 10;
    const filters: string[] = [];
    const filterValues: string[] = [];
    if (options.scope !== undefined) {
      filters.push("scope = ?");
      filterValues.push(options.scope);
    }
    if (options.kind !== undefined) {
      filters.push("kind = ?");
      filterValues.push(options.kind);
    }
    const statement = this.database.query(`
      SELECT id, scope, topic, title, date, status, tags, path, source,
             snippet(memory_fts, 4, '[', ']', '…', 12) AS snippet
      FROM memory_fts
      WHERE memory_fts MATCH ?${filters.map((filter) => ` AND ${filter}`).join("")}
      ORDER BY rank LIMIT ?
    `);
    for (const ftsQuery of ftsQueryPasses(query)) {
      const rows = statement.all(ftsQuery, ...filterValues, limit) as Array<
        Record<string, unknown>
      >;
      if (rows.length === 0) continue;
      return rows.map((row) => {
        const tags = decodeTags(row.tags);
        const { source: _source, ...result } = row;
        return MemorySearchResultSchema.parse({
          ...result,
          tags,
        });
      });
    }
    return [];
  }
}
