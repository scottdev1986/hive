import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HiveDatabase } from "../daemon/db";
import { inheritDefaultModelControlSettings } from "../daemon/instance-settings";
import { RoutingPolicyConflictError, RoutingPolicyStore } from "../daemon/routing-policy-store";
import { SelectionPreferenceStore } from "../daemon/selection-preferences";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";
import type { RoutingPolicy } from "../schemas";
import { promoteDefaultModelControl } from "./promote-default";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; currentHome: string; defaultHome: string } {
  const root = mkdtempSync(join(tmpdir(), "hive-promote-default-"));
  roots.push(root);
  const currentHome = join(root, "current");
  const defaultHome = join(root, "default");
  mkdirSync(currentHome, { recursive: true });
  mkdirSync(defaultHome, { recursive: true });
  return { root, currentHome, defaultHome };
}

function writeCurrentPolicy(home: string): RoutingPolicy {
  const db = new HiveDatabase(join(home, "hive.db"));
  try {
    const store = new RoutingPolicyStore(db);
    store.apply(
      { op: "set-provider", expectedRevision: 0, provider: "grok", state: "enabled" },
      "instance-user",
      NOW,
    );
    store.apply({
      op: "set-chain",
      expectedRevision: 1,
      category: "simple_coding",
      entries: [{
        provider: "grok",
        model: "grok-composer-2.5-fast",
        effort: { mode: "none" },
      }],
    }, "instance-user", NOW);
    return store.apply(
      { op: "set-selection", expectedRevision: 2, mode: "choice" },
      "instance-user",
      NOW,
    );
  } finally {
    db.close();
  }
}

function expectCopied(actual: RoutingPolicy, source: RoutingPolicy): void {
  expect({
    ...actual,
    revision: source.revision,
    updatedAt: source.updatedAt,
  }).toEqual(source);
}

test("promote copies an instance policy into an empty default and audits the consent write", async () => {
  const { currentHome, defaultHome } = fixture();
  const source = writeCurrentPolicy(currentHome);

  const result = await promoteDefaultModelControl({ currentHome, defaultHome, now: NOW });
  expect(result).toEqual({ sourceRevision: 3, targetRevision: 1 });

  const db = new HiveDatabase(join(defaultHome, "hive.db"));
  try {
    const store = new RoutingPolicyStore(db);
    expectCopied(store.read(NOW), source);
    expect(new SelectionPreferenceStore(join(defaultHome, "routing-selection.json")).read())
      .toEqual(source.selection);
    const event = db.database.query(
      "SELECT actor, operation, revision, before, after FROM routing_policy_events",
    ).get() as {
      actor: string;
      operation: string;
      revision: number;
      before: string;
      after: string;
    };
    expect(event).toMatchObject({
      actor: "hive-cli-promote-default",
      operation: "promote-instance-model-control",
      revision: 1,
    });
    expect(JSON.parse(event.before).revision).toBe(0);
    expect(JSON.parse(event.after)).toEqual(store.read(NOW));
  } finally {
    db.close();
  }
});

test("promote rejects a stale default revision rather than clobbering it", () => {
  const { currentHome, defaultHome } = fixture();
  const source = writeCurrentPolicy(currentHome);
  const db = new HiveDatabase(join(defaultHome, "hive.db"));
  try {
    const target = new RoutingPolicyStore(db);
    target.apply(
      { op: "set-provider", expectedRevision: 0, provider: "codex", state: "enabled" },
      "other-writer",
      NOW,
    );
    expect(() => target.promote(source, 0, "hive-cli-promote-default", NOW))
      .toThrow(RoutingPolicyConflictError);
    expect(target.read(NOW).providers).toEqual({ codex: "enabled" });
  } finally {
    db.close();
  }
});

test("promote refuses an empty revision-0 source without changing the default", async () => {
  const { currentHome, defaultHome } = fixture();
  const targetPolicy = writeCurrentPolicy(defaultHome);
  const mirrorPath = join(defaultHome, "routing-selection.json");
  const mirrorBefore = '{"schemaVersion":1,"selection":{"global":"choice","categories":{}}}\n';
  writeFileSync(mirrorPath, mirrorBefore);
  const sourceDb = new HiveDatabase(join(currentHome, "hive.db"));
  sourceDb.close();

  await expect(promoteDefaultModelControl({ currentHome, defaultHome, now: NOW }))
    .rejects.toThrow("source has no user-authored policy yet (revision 0)");

  const targetDb = new HiveDatabase(join(defaultHome, "hive.db"));
  try {
    const target = new RoutingPolicyStore(targetDb);
    expectCopied(target.read(NOW), targetPolicy);
    expect(targetDb.database.query("SELECT COUNT(*) AS count FROM routing_policy_events").get())
      .toEqual({ count: 3 });
  } finally {
    targetDb.close();
  }
  expect(readFileSync(mirrorPath, "utf8")).toBe(mirrorBefore);
});

test("promote refuses a provisional source without changing the default", async () => {
  const { currentHome, defaultHome } = fixture();
  const targetPolicy = writeCurrentPolicy(defaultHome);
  const mirrorPath = join(defaultHome, "routing-selection.json");
  const mirrorBefore = '{"schemaVersion":1,"selection":{"global":"choice","categories":{}}}\n';
  writeFileSync(mirrorPath, mirrorBefore);
  const sourceDb = new HiveDatabase(join(currentHome, "hive.db"));
  try {
    new RoutingPolicyStore(sourceDb).seedProvisionalBaseline(
      { vendorDefaults: { grok: "grok-composer-2.5-fast" } },
      NOW,
    );
  } finally {
    sourceDb.close();
  }

  await expect(promoteDefaultModelControl({ currentHome, defaultHome, now: NOW }))
    .rejects.toThrow("source still has Hive's provisional baseline");

  const targetDb = new HiveDatabase(join(defaultHome, "hive.db"));
  try {
    const target = new RoutingPolicyStore(targetDb);
    expectCopied(target.read(NOW), targetPolicy);
    expect(targetDb.database.query("SELECT COUNT(*) AS count FROM routing_policy_events").get())
      .toEqual({ count: 3 });
  } finally {
    targetDb.close();
  }
  expect(readFileSync(mirrorPath, "utf8")).toBe(mirrorBefore);
});

test("promote refuses when the current home is already the machine default", async () => {
  const { defaultHome } = fixture();
  const policy = writeCurrentPolicy(defaultHome);

  await expect(promoteDefaultModelControl({
    currentHome: defaultHome,
    defaultHome,
    now: NOW,
  })).rejects.toThrow("already the machine default; nothing to promote");

  const db = new HiveDatabase(join(defaultHome, "hive.db"));
  try {
    const store = new RoutingPolicyStore(db);
    expectCopied(store.read(NOW), policy);
    expect(db.database.query("SELECT COUNT(*) AS count FROM routing_policy_events").get())
      .toEqual({ count: 3 });
  } finally {
    db.close();
  }
});

test("promote reports a stale selection mirror after the policy succeeds", async () => {
  const { currentHome, defaultHome } = fixture();
  const source = writeCurrentPolicy(currentHome);
  writeCurrentPolicy(defaultHome);
  const replace = spyOn(SelectionPreferenceStore.prototype, "replace")
    .mockRejectedValueOnce(new Error("selection mirror unavailable"));
  try {
    await expect(promoteDefaultModelControl({ currentHome, defaultHome, now: NOW }))
      .rejects.toThrow(
        "Model Control was promoted, but the selection mirror is stale. Rerun `hive promote-default` to update ~/.hive/routing-selection.json.",
      );
  } finally {
    replace.mockRestore();
  }

  const targetDb = new HiveDatabase(join(defaultHome, "hive.db"));
  try {
    const target = new RoutingPolicyStore(targetDb);
    expectCopied(target.read(NOW), source);
    expect(targetDb.database.query("SELECT COUNT(*) AS count FROM routing_policy_events").get())
      .toEqual({ count: 4 });
  } finally {
    targetDb.close();
  }
});

test("promote refuses while the default daemon owns its database", async () => {
  const { currentHome, defaultHome } = fixture();
  writeCurrentPolicy(currentHome);
  const instanceId = hiveInstanceSuffix(defaultHome);
  writeFileSync(join(defaultHome, "daemon.lock"), JSON.stringify({
    pid: process.pid,
    instanceId,
    startedAt: NOW.toISOString(),
  }));
  writeFileSync(join(defaultHome, "daemon.port"), "4317\n");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    productVersion: "test",
    buildHash: "test",
    wireProtocol: { min: 1, max: 1 },
    schemaEpoch: 1,
    capabilities: ["daemon-handshake-v1"],
    instanceId,
    hiveUuid: "test",
    identityKey: "test",
    repoFamilyKey: null,
    generation: 1,
  }));
  try {
    await expect(promoteDefaultModelControl({ currentHome, defaultHome, now: NOW }))
      .rejects.toThrow("default Hive daemon is live");
    expect(existsSync(join(defaultHome, "hive.db"))).toBeFalse();
  } finally {
    fetchSpy.mockRestore();
  }
});

test("promote throws on a corrupt target policy without resetting it", async () => {
  const { currentHome, defaultHome } = fixture();
  writeCurrentPolicy(currentHome);
  const db = new HiveDatabase(join(defaultHome, "hive.db"));
  try {
    new RoutingPolicyStore(db);
    db.database.run(
      "INSERT INTO routing_policy (id, revision, updatedAt, document) VALUES (1, 7, ?, 'not json')",
      [NOW.toISOString()],
    );
  } finally {
    db.close();
  }

  await expect(promoteDefaultModelControl({ currentHome, defaultHome, now: NOW }))
    .rejects.toThrow("stored routing policy is unreadable");

  const checked = new HiveDatabase(join(defaultHome, "hive.db"));
  try {
    expect(checked.database.query("SELECT document FROM routing_policy WHERE id = 1").get())
      .toEqual({ document: "not json" });
  } finally {
    checked.close();
  }
  expect(existsSync(join(defaultHome, "routing-selection.json"))).toBeFalse();
});

test("a fresh instance inherits the promoted policy identically", async () => {
  const { root, currentHome, defaultHome } = fixture();
  const source = writeCurrentPolicy(currentHome);
  await promoteDefaultModelControl({ currentHome, defaultHome, now: NOW });

  const freshHome = join(root, "fresh");
  mkdirSync(freshHome, { recursive: true });
  const freshDb = new HiveDatabase(join(freshHome, "hive.db"));
  try {
    const fresh = new RoutingPolicyStore(freshDb);
    expect(inheritDefaultModelControlSettings(fresh, {
      currentHome: freshHome,
      sourceHome: defaultHome,
      now: NOW,
    })).toBeTrue();
    expectCopied(fresh.read(NOW), source);
  } finally {
    freshDb.close();
  }
});
