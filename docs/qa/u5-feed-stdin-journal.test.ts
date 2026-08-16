import { describe, expect, test } from "bun:test";
import {
  appendFeedStdinJournalEntry,
  feedStdinJournalEntry,
  feedStdinPositiveControlLine,
  FEED_STDIN_POSITIVE_CONTROL_KIND,
  openFeedStdinJournal,
  requireFeedStdinRecorderAlive,
  stdinLinesAfter,
} from "./u5-feed-stdin-journal";

describe("U5 feed stdin journal", () => {
  test("the recorder must capture its own probe before stdin is trusted", () => {
    const opened = openFeedStdinJournal("probe-1", "2026-08-16T04:00:00.000Z");
    expect(() => requireFeedStdinRecorderAlive(opened)).toThrow(
      "feed stdin recorder did not record its own positive-control line",
    );
    const live = appendFeedStdinJournalEntry(opened, opened.probe);
    expect(() => requireFeedStdinRecorderAlive(live)).not.toThrow();
    expect(live.entries).toHaveLength(1);
    expect(JSON.parse(live.entries[0]?.line ?? "{}")).toMatchObject({
      kind: FEED_STDIN_POSITIVE_CONTROL_KIND,
      nonce: "probe-1",
    });
  });

  test("a recorder that drops the probe is refused by name", () => {
    const journal = openFeedStdinJournal("probe-2", "2026-08-16T04:00:00.000Z");
    const dropped = appendFeedStdinJournalEntry(
      journal,
      feedStdinJournalEntry("stdin", "{}", "2026-08-16T04:00:01.000Z"),
    );
    expect(() => requireFeedStdinRecorderAlive(dropped)).toThrow(
      "feed stdin recorder did not record its own positive-control line",
    );
  });

  test("stdin after a click timestamp is distinguishable from the probe", () => {
    const opened = openFeedStdinJournal("probe-3", "2026-08-16T04:00:00.000Z");
    let journal = appendFeedStdinJournalEntry(opened, opened.probe);
    requireFeedStdinRecorderAlive(journal);
    const clickAt = "2026-08-16T04:01:00.000Z";
    journal = appendFeedStdinJournalEntry(
      journal,
      feedStdinJournalEntry(
        "stdin",
        '{"inventoryRevision":"1","terminals":[]}',
        "2026-08-16T04:01:00.250Z",
      ),
    );
    const after = stdinLinesAfter(journal, clickAt);
    expect(after).toHaveLength(1);
    expect(after[0]?.source).toBe("stdin");
    expect(stdinLinesAfter(journal, "2026-08-16T04:02:00.000Z")).toEqual([]);
    expect(feedStdinPositiveControlLine("probe-3")).toContain(
      FEED_STDIN_POSITIVE_CONTROL_KIND,
    );
  });
});
