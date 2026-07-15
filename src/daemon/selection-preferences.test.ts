import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelectionPreferenceStore } from "./selection-preferences";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
    writeFileSync(preferences.path, '{"schemaVersion":1,"selection":{"global":"maybe"}}\n');
    expect(() => preferences.read()).toThrow();
  });

  test("global, category override, and clearing round-trip", async () => {
    const preferences = store();
    await preferences.apply(
      { op: "set-selection", expectedRevision: 4, mode: "choice" },
      { global: "choice", categories: {} },
    );
    await preferences.apply(
      {
        op: "set-selection",
        expectedRevision: 5,
        category: "debugging",
        mode: "auto",
      },
      { global: "choice", categories: { debugging: "auto" } },
    );
    expect(preferences.read()).toEqual({
      global: "choice",
      categories: { debugging: "auto" },
    });

    await preferences.apply(
      {
        op: "set-selection",
        expectedRevision: 6,
        category: "debugging",
        mode: "unset",
      },
      { global: "choice", categories: {} },
    );
    expect(preferences.read()).toEqual({ global: "choice", categories: {} });
  });

  test("simultaneous Workspaces serialize mutations without losing disjoint overrides", async () => {
    const first = store();
    const second = new SelectionPreferenceStore(first.path);
    await first.apply(
      { op: "set-selection", expectedRevision: 0, mode: "choice" },
      { global: "choice", categories: {} },
    );

    await Promise.all([
      first.apply(
        {
          op: "set-selection",
          expectedRevision: 1,
          category: "debugging",
          mode: "auto",
        },
        { global: "choice", categories: { debugging: "auto" } },
      ),
      second.apply(
        {
          op: "set-selection",
          expectedRevision: 1,
          category: "planning",
          mode: "auto",
        },
        { global: "choice", categories: { planning: "auto" } },
      ),
    ]);

    expect(first.read()).toEqual({
      global: "choice",
      categories: { debugging: "auto", planning: "auto" },
    });
    expect(readdirSync(join(first.path, ".."))).toEqual(["routing-selection.json"]);
  });

  test("the last successfully committed mutation to one key wins", async () => {
    const preferences = store();
    await preferences.apply(
      { op: "set-selection", expectedRevision: 0, mode: "auto" },
      { global: "auto", categories: {} },
    );
    await preferences.apply(
      { op: "set-selection", expectedRevision: 1, mode: "choice" },
      { global: "choice", categories: {} },
    );
    expect(preferences.read()?.global).toBe("choice");
  });
});
