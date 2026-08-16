/** Never collapse the first two entries into `.hive/`: that directory also contains project skills. */
export const HIVE_GITIGNORE_ENTRIES = [
  ".hive/memory/",
  ".hive/worktrees/",
  "graphify-out/",
  ".graphifyignore",
] as const;

export const HIVE_GITIGNORE_HEADER = "# Hive local state";

export interface HiveGitignoreCleanup {
  readonly content: string;
  readonly removedEntries: readonly string[];
}

interface GitignoreLine {
  readonly raw: string;
  readonly text: string;
}

function gitignoreLines(content: string): readonly GitignoreLine[] {
  return (content.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((raw) => ({
    raw,
    text: raw.endsWith("\n")
      ? raw.slice(0, -1).replace(/\r$/, "")
      : raw.replace(/\r$/, ""),
  }));
}

/**
 * Remove only exact Hive entries beneath Hive's own marker. Matching paths
 * elsewhere are project rules and stay. Any other line in the marked group
 * also stays, so uninstall cannot consume a project rule added after init.
 */
export function stripHiveGitignoreEntries(
  content: string,
): HiveGitignoreCleanup {
  const lines = gitignoreLines(content);
  const hiveEntries = new Set<string>(HIVE_GITIGNORE_ENTRIES);
  const removedIndexes = new Set<number>();
  const removedEntries: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.text !== HIVE_GITIGNORE_HEADER) continue;

    let groupEnd = index + 1;
    while (groupEnd < lines.length && lines[groupEnd]?.text !== "") {
      groupEnd += 1;
    }

    const entryIndexes: number[] = [];
    for (let lineIndex = index + 1; lineIndex < groupEnd; lineIndex += 1) {
      const text = lines[lineIndex]?.text;
      if (text !== undefined && hiveEntries.has(text)) {
        entryIndexes.push(lineIndex);
        removedEntries.push(text);
      }
    }
    if (entryIndexes.length === 0) continue;

    removedIndexes.add(index);
    for (const entryIndex of entryIndexes) removedIndexes.add(entryIndex);

    const markedGroupContainsOnlyHiveEntries =
      entryIndexes.length === groupEnd - index - 1;
    if (
      markedGroupContainsOnlyHiveEntries &&
      index > 0 &&
      lines[index - 1]?.text === ""
    ) {
      // `hive init` inserted this separator before its marked group.
      removedIndexes.add(index - 1);
    }
  }

  return {
    content: lines
      .filter((_, index) => !removedIndexes.has(index))
      .map((line) => line.raw)
      .join(""),
    removedEntries,
  };
}
