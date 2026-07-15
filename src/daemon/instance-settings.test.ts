import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HiveDatabase } from "./db";
import {
  inheritDefaultModelControlSettings,
  inheritOrdinaryWorkspaceSelection,
} from "./instance-settings";
import { RoutingPolicyStore } from "./routing-policy-store";
import { SelectionPreferenceStore } from "./selection-preferences";

test("a named instance reads the live default database and imports Model Control once", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-instance-settings-"));
  const defaultHome = join(root, "default");
  const namedHome = join(root, "named");
  mkdirSync(defaultHome, { recursive: true });
  mkdirSync(namedHome, { recursive: true });
  const defaultDb = new HiveDatabase(join(defaultHome, "hive.db"));
  const namedDb = new HiveDatabase(join(namedHome, "hive.db"));
  try {
    const source = new RoutingPolicyStore(defaultDb);
    source.apply(
      { op: "set-provider", expectedRevision: 0, provider: "codex", state: "enabled" },
      "human",
    );
    source.apply({
      op: "set-chain",
      expectedRevision: 1,
      category: "simple_coding",
      entries: [{
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: { mode: "exact", value: "high" },
      }],
    }, "human");

    const target = new RoutingPolicyStore(namedDb);
    target.seedProvisionalBaseline(
      { vendorDefaults: { codex: "old-suggestion" } },
    );
    expect(inheritDefaultModelControlSettings(target, {
      currentHome: namedHome,
      sourceHome: defaultHome,
    })).toBeTrue();
    expect(target.read().providers.codex).toBe("enabled");
    expect(target.read().chains.simple_coding?.[0]).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "exact", value: "high" },
    });

    // A later local edit is ownership: inheritance is one-time, not sync.
    const revision = target.read().revision;
    target.apply(
      { op: "set-provider", expectedRevision: revision, provider: "codex", state: "disabled" },
      "named-instance-user",
    );
    expect(inheritDefaultModelControlSettings(target, {
      currentHome: namedHome,
      sourceHome: defaultHome,
    })).toBeFalse();
    expect(target.read().providers.codex).toBe("disabled");
  } finally {
    namedDb.close();
    defaultDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("selection written in one ordinary runtime overlays a later fresh runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-ordinary-selection-"));
  const defaultHome = join(root, "default");
  const firstHome = join(root, "run-first");
  const secondHome = join(root, "run-second");
  const thirdHome = join(root, "run-third");
  const preferencePath = join(root, "routing-selection.json");
  mkdirSync(defaultHome, { recursive: true });
  mkdirSync(firstHome, { recursive: true });
  mkdirSync(secondHome, { recursive: true });
  mkdirSync(thirdHome, { recursive: true });
  const defaultDb = new HiveDatabase(join(defaultHome, "hive.db"));
  const firstDb = new HiveDatabase(join(firstHome, "hive.db"));
  const secondDb = new HiveDatabase(join(secondHome, "hive.db"));
  const thirdDb = new HiveDatabase(join(thirdHome, "hive.db"));
  try {
    const source = new RoutingPolicyStore(defaultDb);
    source.apply(
      { op: "set-provider", expectedRevision: 0, provider: "codex", state: "enabled" },
      "human",
    );
    source.apply({
      op: "set-chain",
      expectedRevision: 1,
      category: "debugging",
      entries: [{
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: { mode: "exact", value: "high" },
      }],
    }, "human");

    const first = new RoutingPolicyStore(firstDb);
    expect(inheritDefaultModelControlSettings(first, {
      currentHome: firstHome,
      sourceHome: defaultHome,
    })).toBeTrue();
    let selected = first.apply(
      { op: "set-selection", expectedRevision: 1, mode: "choice" },
      "human",
    );
    selected = first.apply(
      {
        op: "set-selection",
        expectedRevision: 2,
        category: "debugging",
        mode: "auto",
      },
      "human",
    );
    const preferences = new SelectionPreferenceStore(preferencePath);
    await preferences.apply(
      {
        op: "set-selection",
        expectedRevision: 2,
        category: "debugging",
        mode: "auto",
      },
      selected.selection,
    );

    const second = new RoutingPolicyStore(secondDb);
    expect(inheritDefaultModelControlSettings(second, {
      currentHome: secondHome,
      sourceHome: defaultHome,
    })).toBeTrue();
    expect(inheritOrdinaryWorkspaceSelection(second, {
      ordinaryWorkspace: true,
      preferences,
    })).toBeTrue();
    expect(second.read().selection).toEqual({
      global: "choice",
      categories: { debugging: "auto" },
    });
    expect(second.read().providers).toEqual({ codex: "enabled" });
    expect(second.read().chains.debugging?.[0]?.model).toBe("gpt-5.6-sol");
    expect(second.read().models[0]?.effort).toEqual({ mode: "exact", value: "high" });

    const cleared = first.apply(
      {
        op: "set-selection",
        expectedRevision: 3,
        category: "debugging",
        mode: "unset",
      },
      "human",
    );
    await preferences.apply(
      {
        op: "set-selection",
        expectedRevision: 3,
        category: "debugging",
        mode: "unset",
      },
      cleared.selection,
    );
    expect(preferences.read()).toEqual({ global: "choice", categories: {} });

    const third = new RoutingPolicyStore(thirdDb);
    expect(inheritDefaultModelControlSettings(third, {
      currentHome: thirdHome,
      sourceHome: defaultHome,
    })).toBeTrue();
    expect(inheritOrdinaryWorkspaceSelection(third, {
      ordinaryWorkspace: true,
      preferences,
    })).toBeTrue();
    expect(third.read().selection).toEqual({ global: "choice", categories: {} });
  } finally {
    thirdDb.close();
    secondDb.close();
    firstDb.close();
    defaultDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing/corrupt shared selection never overwrites named or default policy", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-selection-boundary-"));
  const preferencePath = join(root, "routing-selection.json");
  const db = new HiveDatabase(":memory:");
  const target = new RoutingPolicyStore(db);
  const preferences = new SelectionPreferenceStore(preferencePath);
  const warnings: string[] = [];
  try {
    target.apply(
      { op: "set-selection", expectedRevision: 0, mode: "choice" },
      "named-user",
    );
    expect(inheritDefaultModelControlSettings(target, {
      currentHome: root,
      sourceHome: root,
    })).toBeFalse();
    expect(inheritOrdinaryWorkspaceSelection(target, {
      ordinaryWorkspace: false,
      preferences: { read: () => ({ global: "auto", categories: {} }) },
    })).toBeFalse();
    expect(target.read().selection.global).toBe("choice");

    expect(inheritOrdinaryWorkspaceSelection(target, {
      ordinaryWorkspace: true,
      preferences,
      warn: (warning) => warnings.push(warning),
    })).toBeFalse();
    expect(warnings).toEqual([]);

    writeFileSync(preferencePath, "not json\n");
    expect(inheritOrdinaryWorkspaceSelection(target, {
      ordinaryWorkspace: true,
      preferences,
      warn: (warning) => warnings.push(warning),
    })).toBeFalse();
    expect(warnings[0]).toContain("Could not inherit");
    expect(target.read().selection.global).toBe("choice");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
