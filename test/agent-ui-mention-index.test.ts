import { describe, expect, test } from "bun:test";
import {
  FileMentionIndex,
  initialView,
  mentionMenuEntries,
} from "../src/cli/agent-ui/view-state";

const FILES = [
  "README.md",
  "src/cli/agent-ui/agent-ui-exports.ts",
  "src/cli/agent-ui/view-state.ts",
  "src/cli/agent-ui/transcript-view.ts",
  "src/adapters/providers/protocol/types.ts",
  "test/agent-ui-keys.test.ts",
  "test/agent-ui-file-mentions.test.ts",
  "docs/architecture.md",
  "scripts/test-agent-ui.ts",
  "packages/ui/src/search.ts",
  "packages/server/src/session.ts",
] as const;

function naiveMatches(query: string): string[] {
  const lowered = query.toLowerCase();
  return FILES.filter((path) => path.toLowerCase().includes(lowered))
    .map((path) => {
      const base = (path.split("/").at(-1) ?? path).toLowerCase();
      return {
        path,
        rank: base.startsWith(lowered) ? 0 : base.includes(lowered) ? 1 : 2,
      };
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.path.length - right.path.length ||
        left.path.localeCompare(right.path),
    )
    .slice(0, 8)
    .map((match) => match.path);
}

describe("file mention index", () => {
  test("matches the naive projection while a query grows, changes, and shrinks", () => {
    const index = new FileMentionIndex(FILES);
    const view = initialView();

    for (const query of [
      "",
      "s",
      "sr",
      "src",
      "SRC",
      "read",
      "test",
      "x",
      "",
    ]) {
      const actual = mentionMenuEntries(view, `@${query}`, index).map(
        (entry) => entry.path,
      );
      expect(actual).toEqual(naiveMatches(query));
    }
  });

  test("reuses the prior result for the same normalized query", () => {
    const index = new FileMentionIndex(FILES);
    const first = index.matches("src");

    expect(index.matches("SRC") === first).toBe(true);
  });
});
