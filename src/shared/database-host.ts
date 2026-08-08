import type { Database } from "bun:sqlite";

/** The shared SQLite capabilities required by domain stores. This contract lives below every domain layer so mail, memory, usage, and the daemon do not need to import one another merely to share a connection. */
export interface DatabaseHost {
  readonly database: Database;
  transaction<T>(operation: () => T): T;
}
