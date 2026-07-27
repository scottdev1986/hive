import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelectionPreferenceStore } from "../../src/daemon/selection-preferences";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function store(): SelectionPreferenceStore {
  const root = mkdtempSync(join(tmpdir(), "hive-selection-preference-"));
  roots.push(root);
  return new SelectionPreferenceStore(join(root, "routing-selection.json"));
}

describe("ordinary Workspace selection preference", () => {
  test("missing is unconfigured while corrupt data refuses loudly", () => {
    const preferences = store();
    expect(preferences.read()).toBeNull();
    writeFileSync(
      preferences.path,
      '{"schemaVersion":1,"selection":{"global":"maybe"}}\n',
    );
    expect(() => preferences.read()).toThrow();
  });

  test("the global round-trips", async () => {
    const preferences = store();
    await preferences.apply(
      { op: "set-selection", expectedRevision: 4, mode: "choice" },
      { global: "choice" },
    );
    expect(preferences.read()).toEqual({ global: "choice" });

    await preferences.apply(
      { op: "set-selection", expectedRevision: 5, mode: "auto" },
      { global: "auto" },
    );
    expect(preferences.read()).toEqual({ global: "auto" });
  });

  test("a file written before per-category overrides were removed still reads, minus the overrides", () => {
    const preferences = store();
    writeFileSync(
      preferences.path,
      `${JSON.stringify({
        schemaVersion: 1,
        selection: {
          global: "choice",
          categories: { debugging: "auto", planning: "choice" },
        },
      })}\n`,
    );
    // Dropped, not refused: the retired map is a known shape, so it must not
    // read as a corrupt preference the daemon then reports and never guesses.
    expect(preferences.read()).toEqual({ global: "choice" });
  });

  test("simultaneous Workspaces serialize mutations and leave one document behind", async () => {
    const first = store();
    const second = new SelectionPreferenceStore(first.path);
    await first.apply(
      { op: "set-selection", expectedRevision: 0, mode: "choice" },
      { global: "choice" },
    );

    await Promise.all([
      first.apply(
        { op: "set-selection", expectedRevision: 1, mode: "auto" },
        { global: "auto" },
      ),
      second.apply(
        { op: "set-selection", expectedRevision: 1, mode: "auto" },
        { global: "auto" },
      ),
    ]);

    expect(first.read()).toEqual({ global: "auto" });
    expect(readdirSync(join(first.path, ".."))).toEqual([
      "routing-selection.json",
    ]);
  });

  test("the last successfully committed mutation wins", async () => {
    const preferences = store();
    await preferences.apply(
      { op: "set-selection", expectedRevision: 0, mode: "auto" },
      { global: "auto" },
    );
    await preferences.apply(
      { op: "set-selection", expectedRevision: 1, mode: "choice" },
      { global: "choice" },
    );
    expect(preferences.read()?.global).toBe("choice");
  });
});
