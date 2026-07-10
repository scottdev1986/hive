import type { Database } from "bun:sqlite";
import { listMemoryFacts } from "../adapters/memory";
import {
  MemorySearchResultSchema,
  type MemoryFact,
  type MemoryScope,
  type MemorySearchResult,
} from "../schemas";

function toFtsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token}"`).join(" AND ");
}

// A disposable SQLite FTS5 search index over the Markdown facts adapters/
// memory.ts treats as the source of truth. Every row here can be reproduced
// from the files at any time via rebuild(); nothing here is authoritative.
export class MemoryIndex {
  constructor(private readonly database: Database) {
    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id, scope UNINDEXED, title, body, tags, date UNINDEXED, path UNINDEXED,
        tokenize = 'porter'
      )
    `);
  }

  private insertRow(fact: MemoryFact): void {
    this.database.query(`
      INSERT INTO memory_fts (id, scope, title, body, tags, date, path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      fact.id,
      fact.scope,
      fact.title,
      fact.body,
      fact.tags.join(" "),
      fact.date,
      fact.path,
    );
  }

  private deleteRow(scope: MemoryScope, id: string): void {
    this.database.query(`
      DELETE FROM memory_fts WHERE id = ? AND scope = ?
    `).run(id, scope);
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

  // Rebuilds the whole index from the Markdown files under `root` (repo
  // scope) and the global memory directory. Safe to call any time — on
  // daemon startup, after external edits to the files, or on demand via
  // memory_reindex — because the files are authoritative and the index is
  // not.
  async rebuild(root: string): Promise<number> {
    const facts = await listMemoryFacts(root);
    this.database.transaction((rows: MemoryFact[]) => {
      this.database.exec("DELETE FROM memory_fts");
      for (const fact of rows) {
        this.insertRow(fact);
      }
    })(facts);
    return facts.length;
  }

  search(
    query: string,
    options: { scope?: MemoryScope; limit?: number } = {},
  ): MemorySearchResult[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery === null) {
      return [];
    }
    const limit = options.limit ?? 10;
    const rows = options.scope === undefined
      ? this.database.query(`
          SELECT id, scope, title, date, tags, path,
                 snippet(memory_fts, 3, '[', ']', '…', 12) AS snippet
          FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?
        `).all(ftsQuery, limit)
      : this.database.query(`
          SELECT id, scope, title, date, tags, path,
                 snippet(memory_fts, 3, '[', ']', '…', 12) AS snippet
          FROM memory_fts WHERE memory_fts MATCH ? AND scope = ?
          ORDER BY rank LIMIT ?
        `).all(ftsQuery, options.scope, limit);
    return (rows as Array<Record<string, unknown>>).map((row) =>
      MemorySearchResultSchema.parse({
        ...row,
        tags: typeof row.tags === "string"
          ? row.tags.split(" ").filter((tag) => tag.length > 0)
          : row.tags,
      })
    );
  }
}
