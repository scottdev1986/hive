import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { machineModelControlDatabase } from "../../src/daemon/routing-service/instance-settings";
import { RoutingPolicyStore } from "../../src/daemon/routing-policy-store";
import type {
  RoutePolicy,
  RoutingPolicyMutation,
} from "../../src/schemas/routing-policy";

const priorDefaultHome = process.env.HIVE_DEFAULT_HOME;

afterEach(() => {
  if (priorDefaultHome === undefined) delete process.env.HIVE_DEFAULT_HOME;
  else process.env.HIVE_DEFAULT_HOME = priorDefaultHome;
});

const plannedRoute: RoutePolicy = {
  mode: "user-weighted",
  candidates: [
    {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "exact", value: "xhigh" },
      weight: 85,
    },
  ],
};

const planningEdit: RoutingPolicyMutation = {
  op: "set-route",
  expectedRevision: 0,
  scope: "planning",
  route: plannedRoute,
};

test("an edit made from a per-run home survives that home being destroyed", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-machine-policy-"));
  const machineHome = join(root, "machine");
  const runHome = join(root, "run-one");
  mkdirSync(machineHome, { recursive: true });
  mkdirSync(runHome, { recursive: true });
  process.env.HIVE_DEFAULT_HOME = machineHome;

  // Boot one: a daemon on an ephemeral per-run home. The user edits routing.
  const firstRunDb = new HiveDatabase(join(runHome, "hive.db"));
  const firstPolicyDb = machineModelControlDatabase(firstRunDb);
  try {
    expect(firstPolicyDb.opened).toBeTrue();
    new RoutingPolicyStore(firstPolicyDb.database).apply(planningEdit, "user");
  } finally {
    firstPolicyDb.database.close();
    firstRunDb.close();
  }

  // A fresh installed session retires its per-run home wholesale.
  rmSync(runHome, { recursive: true, force: true });
  expect(existsSync(join(runHome, "hive.db"))).toBeFalse();

  // Boot two: a brand new per-run home, as a rebuild produces.
  const secondRunHome = join(root, "run-two");
  mkdirSync(secondRunHome, { recursive: true });
  const secondRunDb = new HiveDatabase(join(secondRunHome, "hive.db"));
  const secondPolicyDb = machineModelControlDatabase(secondRunDb);
  try {
    const store = new RoutingPolicyStore(secondPolicyDb.database);
    expect(store.isEmpty()).toBeFalse();
    const policy = store.read();
    expect(policy.revision).toBe(1);
    expect(policy.categories.planning).toEqual(plannedRoute);
  } finally {
    secondPolicyDb.database.close();
    secondRunDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a home that is already the machine default reuses its own connection", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-machine-policy-same-"));
  process.env.HIVE_DEFAULT_HOME = root;
  const db = new HiveDatabase(join(root, "hive.db"));
  try {
    const resolved = machineModelControlDatabase(db);
    expect(resolved.opened).toBeFalse();
    expect(resolved.database).toBe(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an isolated HIVE_DEFAULT_HOME never reads or writes the real machine home", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-machine-policy-isolated-"));
  const realHome = join(root, "real");
  const qaDefaultHome = join(root, "qa-default");
  const qaRunHome = join(root, "qa-run");
  for (const home of [realHome, qaDefaultHome, qaRunHome]) {
    mkdirSync(home, { recursive: true });
  }

  // The user's real consent record, written by a daemon on the real machine
  // home. This stands in for ~/.hive.
  process.env.HIVE_DEFAULT_HOME = realHome;
  const realDb = new HiveDatabase(join(realHome, "hive.db"));
  try {
    new RoutingPolicyStore(realDb).apply(planningEdit, "user");
  } finally {
    realDb.close();
  }

  // A QA rig isolates itself the documented way: its own HIVE_DEFAULT_HOME.
  process.env.HIVE_DEFAULT_HOME = qaDefaultHome;
  const qaRunDb = new HiveDatabase(join(qaRunHome, "hive.db"));
  const qaPolicyDb = machineModelControlDatabase(qaRunDb);
  try {
    expect(qaPolicyDb.database.path).toBe(join(qaDefaultHome, "hive.db"));
    const qaStore = new RoutingPolicyStore(qaPolicyDb.database);
    // It cannot READ the user's policy...
    expect(qaStore.isEmpty()).toBeTrue();
    // ...and its own writes cannot reach it.
    qaStore.apply(
      {
        op: "set-provider",
        expectedRevision: 0,
        provider: "grok",
        state: "disabled",
      },
      "qa-rig",
    );
  } finally {
    qaPolicyDb.database.close();
    qaRunDb.close();
  }

  // The real home is untouched: same revision, same route, no QA write.
  process.env.HIVE_DEFAULT_HOME = realHome;
  const realReread = new HiveDatabase(join(realHome, "hive.db"));
  try {
    const policy = new RoutingPolicyStore(realReread).read();
    expect(policy.revision).toBe(1);
    expect(policy.categories.planning).toEqual(plannedRoute);
    expect(policy.providers.grok).toBeUndefined();
  } finally {
    realReread.close();
    rmSync(root, { recursive: true, force: true });
  }
});
