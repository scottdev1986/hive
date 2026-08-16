// Records every NDJSON line the Workspace writes to the QA feed bridge
// stdin. The 000f measurement is "did the app write any line after the
// click?" A journal that can stay empty without a probe cannot answer
// that: empty and "recorder broken" look the same.

export const FEED_STDIN_JOURNAL_SCHEMA_VERSION = 1 as const;
export const FEED_STDIN_POSITIVE_CONTROL_KIND =
  "u5-feed-stdin-recorder-positive-control";

export interface FeedStdinJournalEntry {
  receivedAt: string;
  source: "positive-control" | "stdin";
  line: string;
  byteLength: number;
}

export interface FeedStdinJournal {
  schemaVersion: typeof FEED_STDIN_JOURNAL_SCHEMA_VERSION;
  probe: FeedStdinJournalEntry;
  entries: FeedStdinJournalEntry[];
}

export function feedStdinJournalEntry(
  source: FeedStdinJournalEntry["source"],
  line: string,
  receivedAt: string,
): FeedStdinJournalEntry {
  return {
    receivedAt,
    source,
    line,
    byteLength: Buffer.byteLength(line, "utf8"),
  };
}

export function feedStdinPositiveControlLine(nonce: string): string {
  return JSON.stringify({
    kind: FEED_STDIN_POSITIVE_CONTROL_KIND,
    nonce,
  });
}

export function appendFeedStdinJournalEntry(
  journal: FeedStdinJournal,
  entry: FeedStdinJournalEntry,
): FeedStdinJournal {
  return {
    ...journal,
    entries: [...journal.entries, entry],
  };
}

export function openFeedStdinJournal(
  nonce: string,
  receivedAt: string,
): FeedStdinJournal {
  const probe = feedStdinJournalEntry(
    "positive-control",
    feedStdinPositiveControlLine(nonce),
    receivedAt,
  );
  return {
    schemaVersion: FEED_STDIN_JOURNAL_SCHEMA_VERSION,
    probe,
    entries: [],
  };
}

/** Read-back check. The caller must have already appended the probe
 * through the same append path stdin uses. A later empty stdin log is
 * then "app sent nothing", not "we were not looking". */
export function requireFeedStdinRecorderAlive(journal: FeedStdinJournal): void {
  if (
    !journal.entries.some(
      (entry) =>
        entry.source === "positive-control" &&
        entry.line === journal.probe.line &&
        entry.byteLength === journal.probe.byteLength,
    )
  ) {
    throw new Error(
      "feed stdin recorder did not record its own positive-control line",
    );
  }
}

export function stdinLinesAfter(
  journal: FeedStdinJournal,
  isoTimestamp: string,
): FeedStdinJournalEntry[] {
  return journal.entries.filter(
    (entry) => entry.source === "stdin" && entry.receivedAt >= isoTimestamp,
  );
}
