import type { DatabaseHost } from "../../shared/database-host";

export class HistoryStore {
  constructor(private readonly host: DatabaseHost) {}

  pruneHistory(
    now: string,
    keepDays = 14,
  ): { events: number; approvals: number } {
    const cutoff = new Date(
      Date.parse(now) - keepDays * 86_400_000,
    ).toISOString();
    return this.host.transaction(() => ({
      events: this.host.database
        .query("DELETE FROM events WHERE timestamp < ?")
        .run(cutoff).changes,
      approvals: this.host.database
        .query(
          "DELETE FROM approvals WHERE status != 'pending' AND createdAt < ?",
        )
        .run(cutoff).changes,
    }));
  }
}
