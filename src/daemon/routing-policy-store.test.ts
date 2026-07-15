import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelPolicyState,
  modelCategoryFit,
  providerPolicyState,
  ROUTING_CATEGORIES,
  type RoutingPolicy,
} from "../schemas";
import { HiveDatabase } from "./db";
import {
  canonicalRoutingPolicyJson,
  policyModelEnablement,
  retireLegacyRoutingToml,
  RoutingPolicyConflictError,
  RoutingPolicyCorruptError,
  RoutingPolicyStore,
} from "./routing-policy-store";

const NOW = new Date("2026-07-12T12:00:00.000Z");

let db: HiveDatabase;
let store: RoutingPolicyStore;

beforeEach(() => {
  db = new HiveDatabase(":memory:");
  store = new RoutingPolicyStore(db);
});

afterEach(() => {
  db.close();
});

describe("fail-closed reading", () => {
  test("an empty store is revision 0 with NOTHING configured — and unconfigured is not enabled", () => {
    const policy = store.read(NOW);
    expect(policy.revision).toBe(0);
    expect(policy.providers).toEqual({});
    expect(policy.models).toEqual([]);
    expect(policy.chains).toEqual({});
    expect(providerPolicyState(policy, "grok")).toBe("unconfigured");
    expect(modelPolicyState(policy, "grok", "grok-4.5"))
      .toEqual({ state: "unconfigured", source: "none" });
  });

  test("a version-1 policy migrates choices but never invents AUTO", () => {
    const { selection: _selection, ...current } = store.read(NOW);
    const legacy = { ...current, schemaVersion: 1 };
    db.database.run(
      "INSERT INTO routing_policy (id, revision, updatedAt, document) VALUES (1, 0, ?, ?)",
      [NOW.toISOString(), JSON.stringify(legacy)],
    );
    const migrated = new RoutingPolicyStore(db).read(NOW);
    expect(migrated.selection).toEqual({ global: "never-configured", categories: {} });
  });

  test("a stored policy with a retired profiling chain is migrated away rather than throwing", () => {
    const current = store.read(NOW);
    const defaultChain = [{
      provider: "codex" as const,
      model: "gpt-5.6-sol",
      effort: { mode: "provider-controlled" as const },
    }];
    // Inject the retired key via JSON so the document looks like a pre-removal
    // policy without needing the category in today's type system.
    const withProfiling = {
      ...current,
      revision: 3,
      chains: {
        default: defaultChain,
        profiling: defaultChain,
      },
      selection: {
        global: "never-configured" as const,
        categories: {
          default: "choice" as const,
          profiling: "choice",
        },
      },
    };
    db.database.run(
      "INSERT INTO routing_policy (id, revision, updatedAt, document) VALUES (1, 3, ?, ?)",
      [NOW.toISOString(), JSON.stringify(withProfiling)],
    );

    const migrated = new RoutingPolicyStore(db).read(NOW);

    expect(migrated.chains).not.toHaveProperty("profiling");
    expect(migrated.selection.categories).not.toHaveProperty("profiling");
    expect(migrated.chains.default).toEqual(defaultChain);
    expect(migrated.selection.categories.default).toBe("choice");
    expect(migrated.revision).toBe(4);
    // Durable: re-open on the same DB does not re-bump, and still has no profiling.
    const again = new RoutingPolicyStore(db).read(NOW);
    expect(again.revision).toBe(4);
    expect(again.chains).not.toHaveProperty("profiling");
  });

  test("a corrupt policy row THROWS — it never degrades to an empty, permissive-looking document", () => {
    db.database.run(
      "INSERT INTO routing_policy (id, revision, updatedAt, document) VALUES (1, 3, ?, ?)",
      [NOW.toISOString(), "{not json"],
    );
    expect(() => store.read(NOW)).toThrow(RoutingPolicyCorruptError);
  });

  test("a parseable row that fails the schema is equally corrupt, not equally empty", () => {
    db.database.run(
      "INSERT INTO routing_policy (id, revision, updatedAt, document) VALUES (1, 3, ?, ?)",
      [NOW.toISOString(), JSON.stringify({ schemaVersion: 99, everything: "fine" })],
    );
    expect(() => store.read(NOW)).toThrow(RoutingPolicyCorruptError);
  });

  test("provider-off overrides an explicitly enabled model; provider enablement never consents to unlisted models", () => {
    let policy = store.apply(
      { op: "set-provider", expectedRevision: 0, provider: "claude", state: "enabled" },
      "test",
      NOW,
    );
    policy = store.apply(
      {
        op: "set-model",
        expectedRevision: 1,
        provider: "claude",
        model: "claude-fable-5",
        state: "enabled",
      },
      "test",
      NOW,
    );
    policy = store.apply(
      { op: "set-provider", expectedRevision: 2, provider: "claude", state: "disabled" },
      "test",
      NOW,
    );
    expect(modelPolicyState(policy, "claude", "claude-fable-5"))
      .toEqual({ state: "disabled", source: "provider" });

    policy = store.apply(
      { op: "set-provider", expectedRevision: 3, provider: "claude", state: "enabled" },
      "test",
      NOW,
    );
    expect(modelPolicyState(policy, "claude", "claude-unlisted"))
      .toEqual({ state: "unconfigured", source: "none" });
    expect(modelPolicyState(policy, "codex", "gpt-anything"))
      .toEqual({ state: "unconfigured", source: "none" });
  });
});

describe("capability fit evidence", () => {
  test("coding chain placement is monotonic upward evidence, never a model-name guess", () => {
    const policy: RoutingPolicy = {
      ...store.read(NOW),
      chains: {
        standard_coding: [{
          provider: "codex",
          model: "gpt-proved",
          effort: { mode: "hive-decides" },
        }],
      },
    };
    expect(modelCategoryFit(policy, "codex", "gpt-proved", "simple_coding").fits)
      .toBeTrue();
    expect(modelCategoryFit(policy, "codex", "gpt-proved", "standard_coding").fits)
      .toBeTrue();
    expect(modelCategoryFit(policy, "codex", "gpt-proved", "complex_coding").fits)
      .toBeFalse();
    expect(modelCategoryFit(policy, "claude", "sounds-strong", "simple_coding").fits)
      .toBeFalse();
  });
});

describe("mutations and compare-and-set", () => {
  test("selection mutations set global and category modes and unset only the override", () => {
    let policy = store.apply(
      { op: "set-selection", expectedRevision: 0, mode: "choice" },
      "test",
      NOW,
    );
    expect(policy.selection).toEqual({ global: "choice", categories: {} });
    policy = store.apply(
      {
        op: "set-selection",
        expectedRevision: 1,
        category: "complex_coding",
        mode: "auto",
      },
      "test",
      NOW,
    );
    expect(policy.selection).toEqual({
      global: "choice",
      categories: { complex_coding: "auto" },
    });
    policy = store.apply(
      {
        op: "set-selection",
        expectedRevision: 2,
        category: "complex_coding",
        mode: "unset",
      },
      "test",
      NOW,
    );
    expect(policy.selection).toEqual({ global: "choice", categories: {} });
    expect(policy.revision).toBe(3);
  });

  test("every accepted write increments the revision and clears the provisional flag", () => {
    const seeded = store.seedProvisionalBaseline(
      { vendorDefaults: {} },
      NOW,
    ).policy;
    expect(seeded.revision).toBe(1);
    expect(seeded.provisional).toBeTrue();
    const edited = store.apply(
      { op: "set-provider", expectedRevision: 1, provider: "grok", state: "enabled" },
      "test",
      NOW,
    );
    expect(edited.revision).toBe(2);
    expect(edited.provisional).toBeFalse();
    expect(edited.providers.grok).toBe("enabled");
  });

  test("a stale revision is rejected loudly, names the live revision, and changes nothing", () => {
    store.apply(
      { op: "set-provider", expectedRevision: 0, provider: "claude", state: "enabled" },
      "test",
      NOW,
    );
    expect(() =>
      store.apply(
        { op: "set-provider", expectedRevision: 0, provider: "claude", state: "disabled" },
        "test",
        NOW,
      )
    ).toThrow(RoutingPolicyConflictError);
    const policy = store.read(NOW);
    expect(policy.revision).toBe(1);
    expect(policy.providers.claude).toBe("enabled");
  });

  test("unsetting consent preserves explicit never-configured effort intent", () => {
    store.apply(
      {
        op: "set-model",
        expectedRevision: 0,
        provider: "codex",
        model: "gpt-5.6-sol",
        state: "disabled",
      },
      "test",
      NOW,
    );
    const policy = store.apply(
      {
        op: "set-model",
        expectedRevision: 1,
        provider: "codex",
        model: "gpt-5.6-sol",
        state: "unset",
      },
      "test",
      NOW,
    );
    expect(policy.models).toEqual([{
      provider: "codex",
      model: "gpt-5.6-sol",
      state: undefined,
      effort: { mode: "never-configured" },
    }]);
    expect(modelPolicyState(policy, "codex", "gpt-5.6-sol"))
      .toEqual({ state: "unconfigured", source: "none" });
  });

  test("choosing an effort never blesses a model: an effort-only row still inherits its enablement", () => {
    const policy = store.apply(
      {
        op: "set-effort",
        expectedRevision: 0,
        provider: "grok",
        model: "grok-4.5",
        effort: { mode: "exact", value: "high" },
      },
      "test",
      NOW,
    );
    expect(policy.models).toEqual([
      { provider: "grok", model: "grok-4.5", effort: { mode: "exact", value: "high" } },
    ]);
    expect(modelPolicyState(policy, "grok", "grok-4.5"))
      .toEqual({ state: "unconfigured", source: "none" });
  });

  test("unsetting the state keeps a row's effort; unsetting the effort keeps its state; an empty row is dropped", () => {
    store.apply(
      {
        op: "set-model",
        expectedRevision: 0,
        provider: "claude",
        model: "claude-fable-5",
        state: "enabled",
      },
      "test",
      NOW,
    );
    store.apply(
      {
        op: "set-effort",
        expectedRevision: 1,
        provider: "claude",
        model: "claude-fable-5",
        effort: { mode: "none" },
      },
      "test",
      NOW,
    );
    const withoutState = store.apply(
      {
        op: "set-model",
        expectedRevision: 2,
        provider: "claude",
        model: "claude-fable-5",
        state: "unset",
      },
      "test",
      NOW,
    );
    expect(withoutState.models).toEqual([
      { provider: "claude", model: "claude-fable-5", effort: { mode: "none" } },
    ]);
    const emptied = store.apply(
      {
        op: "set-effort",
        expectedRevision: 3,
        provider: "claude",
        model: "claude-fable-5",
        effort: "unset",
      },
      "test",
      NOW,
    );
    expect(emptied.models).toEqual([{
      provider: "claude",
      model: "claude-fable-5",
      effort: { mode: "never-configured" },
    }]);
  });

  test("a chain stores in the user's order, replaces whole, and clears on empty", () => {
    const chain = store.apply(
      {
        op: "set-chain",
        expectedRevision: 0,
        category: "complex_coding",
        entries: [
          {
            provider: "claude",
            model: "claude-fable-5",
            effort: { mode: "exact", value: "xhigh" },
          },
          {
            provider: "grok",
            model: "grok-4.5",
            effort: { mode: "provider-controlled" },
          },
        ],
      },
      "test",
      NOW,
    );
    expect(chain.chains.complex_coding?.map((entry) => entry.provider))
      .toEqual(["claude", "grok"]);
    const cleared = store.apply(
      { op: "set-chain", expectedRevision: 1, category: "complex_coding", entries: [] },
      "test",
      NOW,
    );
    expect(cleared.chains.complex_coding).toBeUndefined();
  });

  test('a bare "default" model id is rejected — a chain names the specific model that will run', () => {
    expect(() =>
      store.apply(
        {
          op: "set-chain",
          expectedRevision: 0,
          category: "planning",
          entries: [{
            provider: "grok",
            model: "default",
            effort: { mode: "provider-controlled" },
          }],
        },
        "test",
        NOW,
      )
    ).toThrow(/not a model/);
  });

  test("a chain naming the same target twice is rejected", () => {
    expect(() =>
      store.apply(
        {
          op: "set-chain",
          expectedRevision: 0,
          category: "planning",
          entries: [
            {
              provider: "claude",
              model: "claude-fable-5",
              effort: { mode: "provider-controlled" },
            },
            {
              provider: "claude",
              model: "claude-fable-5",
              effort: { mode: "exact", value: "high" },
            },
          ],
        },
        "test",
        NOW,
      )
    ).toThrow(/twice/);
  });

  test("every accepted write appends an audit event with before and after", () => {
    store.apply(
      { op: "set-provider", expectedRevision: 0, provider: "claude", state: "enabled" },
      "the-operator",
      NOW,
    );
    const events = db.database.query(
      "SELECT actor, operation, revision, before, after FROM routing_policy_events ORDER BY id",
    ).all() as {
      actor: string;
      operation: string;
      revision: number;
      before: string | null;
      after: string;
    }[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "the-operator",
      operation: "set-provider",
      revision: 1,
    });
    expect(events[0]!.after).toContain('"claude": "enabled"');
  });
});

describe("first-boot seeding — consent is never seeded, entries are exact ids", () => {
  const DEFAULTS = {
    claude: "claude-fable-5",
    codex: "gpt-5.6-sol",
    grok: "grok-4.5",
  } as const;

  test("seeds every category with exact frozen model ids and no enablement", () => {
    const { seeded, policy } = store.seedProvisionalBaseline(
      {
        vendorDefaults: DEFAULTS,
      },
      NOW,
    );
    expect(seeded).toBeTrue();
    expect(policy.revision).toBe(1);
    expect(policy.provisional).toBeTrue();
    for (const category of ROUTING_CATEGORIES) {
      const chain = policy.chains[category];
      expect(chain).toBeDefined();
      expect(chain!.length).toBe(3);
      for (const entry of chain!) {
        // Every entry names the specific model that will run — no mode field,
        // no indirection of any kind.
        expect(entry.model).toBe(DEFAULTS[entry.provider]);
        expect(entry.effort).toEqual({ mode: "provider-controlled" });
      }
    }
    expect(policy.providers).toEqual({});
    expect(policy.models).toEqual([]);
    expect(modelPolicyState(policy, "claude", "claude-fable-5").state)
      .toBe("unconfigured");
    expect(modelPolicyState(policy, "codex", "gpt-5.6-sol").state)
      .toBe("unconfigured");
    // Every frozen default is named in the suggested chains but remains off,
    // waiting for the user's own click, which is the consent.
    expect(policy.chains.default?.some((entry) => entry.provider === "grok")).toBeTrue();
    expect(modelPolicyState(policy, "grok", "grok-4.5"))
      .toEqual({ state: "unconfigured", source: "none" });
  });

  test("an unreadable vendor is skipped in seeded chains — never guessed from training knowledge", () => {
    const { policy } = store.seedProvisionalBaseline(
      {
        vendorDefaults: { claude: "claude-fable-5" },
      },
      NOW,
    );
    for (const chain of Object.values(policy.chains)) {
      expect(chain.map((entry) => entry.provider)).toEqual(["claude"]);
    }
  });

  test("a caller that could read nothing seeds NOTHING enabled and no chains — unknown never becomes spend or a guessed id", () => {
    const { policy } = store.seedProvisionalBaseline(
      { vendorDefaults: {} },
      NOW,
    );
    expect(policy.models).toEqual([]);
    expect(policy.chains).toEqual({});
    expect(policy.provisional).toBeTrue();
  });

  test("seeding never touches an existing policy — not even one seeded by an earlier boot", () => {
    store.seedProvisionalBaseline({ vendorDefaults: {} }, NOW);
    const again = store.seedProvisionalBaseline(
      {
        vendorDefaults: DEFAULTS,
      },
      NOW,
    );
    expect(again.seeded).toBeFalse();
    expect(again.policy.models).toEqual([]);

    const edited = store.apply(
      { op: "set-provider", expectedRevision: 1, provider: "grok", state: "enabled" },
      "test",
      NOW,
    );
    const afterEdit = store.seedProvisionalBaseline(
      { vendorDefaults: {} },
      NOW,
    );
    expect(afterEdit.seeded).toBeFalse();
    expect(afterEdit.policy.revision).toBe(edited.revision);
  });
});

describe("named-instance Model Control inheritance", () => {
  function userPolicy(): { db: HiveDatabase; policy: RoutingPolicy } {
    const sourceDb = new HiveDatabase(":memory:");
    const source = new RoutingPolicyStore(sourceDb);
    source.apply(
      { op: "set-provider", expectedRevision: 0, provider: "grok", state: "enabled" },
      "human",
      NOW,
    );
    const policy = source.apply(
      {
        op: "set-chain",
        expectedRevision: 1,
        category: "light_research",
        entries: [{
          provider: "grok",
          model: "grok-4.5",
          effort: { mode: "exact", value: "low" },
        }],
      },
      "human",
      NOW,
    );
    return { db: sourceDb, policy };
  }

  test("copies chains, model consent, provider switches, and effort into an empty store", () => {
    const source = userPolicy();
    try {
      const result = store.importDefaultPolicy(source.policy, NOW);
      expect(result.imported).toBeTrue();
      expect(result.policy.revision).toBe(1);
      expect(result.policy.provisional).toBeFalse();
      expect(result.policy.providers).toEqual(source.policy.providers);
      expect(result.policy.models).toEqual(source.policy.models);
      expect(result.policy.chains).toEqual(source.policy.chains);
      expect(result.policy.selection).toEqual(source.policy.selection);
    } finally {
      source.db.close();
    }
  });

  test("replaces only Hive's untouched provisional baseline", () => {
    store.seedProvisionalBaseline(
      { vendorDefaults: { grok: "old-suggestion" } },
      NOW,
    );
    const source = userPolicy();
    try {
      const result = store.importDefaultPolicy(source.policy, NOW);
      expect(result.imported).toBeTrue();
      expect(result.policy.revision).toBe(2);
      expect(result.policy.chains.light_research?.[0]?.model).toBe("grok-4.5");
    } finally {
      source.db.close();
    }
  });

  test("never overwrites a named instance's own edit or imports provisional consent", () => {
    const provisionalDb = new HiveDatabase(":memory:");
    const provisional = new RoutingPolicyStore(provisionalDb)
      .seedProvisionalBaseline(
        { vendorDefaults: { grok: "grok-4.5" } },
        NOW,
      ).policy;
    try {
      expect(store.importDefaultPolicy(provisional, NOW).imported).toBeFalse();
      store.apply(
        { op: "set-provider", expectedRevision: 0, provider: "codex", state: "disabled" },
        "named-instance-user",
        NOW,
      );
      const source = userPolicy();
      try {
        expect(store.importDefaultPolicy(source.policy, NOW).imported).toBeFalse();
        expect(store.read(NOW).providers).toEqual({ codex: "disabled" });
      } finally {
        source.db.close();
      }
    } finally {
      provisionalDb.close();
    }
  });
});

describe("deterministic export", () => {
  test("identical logical policy exports byte-identically regardless of edit order", () => {
    const other = new HiveDatabase(":memory:");
    const otherStore = new RoutingPolicyStore(other);
    // Same rows, written in opposite order.
    store.apply(
      { op: "set-provider", expectedRevision: 0, provider: "claude", state: "enabled" },
      "test",
      NOW,
    );
    store.apply(
      {
        op: "set-model",
        expectedRevision: 1,
        provider: "grok",
        model: "grok-4.5",
        state: "disabled",
      },
      "test",
      NOW,
    );
    otherStore.apply(
      {
        op: "set-model",
        expectedRevision: 0,
        provider: "grok",
        model: "grok-4.5",
        state: "disabled",
      },
      "test",
      NOW,
    );
    otherStore.apply(
      { op: "set-provider", expectedRevision: 1, provider: "claude", state: "enabled" },
      "test",
      NOW,
    );
    expect(canonicalRoutingPolicyJson(store.read(NOW)))
      .toBe(canonicalRoutingPolicyJson(otherStore.read(NOW)));
    other.close();
  });

  test("the export round-trips: canonical output is the same document", () => {
    const policy = store.seedProvisionalBaseline(
      {
        vendorDefaults: { claude: "claude-fable-5", codex: "gpt-5.6-sol" },
      },
      NOW,
    ).policy;
    const parsed = JSON.parse(canonicalRoutingPolicyJson(policy)) as RoutingPolicy;
    expect(parsed.revision).toBe(policy.revision);
    expect(parsed.chains).toEqual(policy.chains);
    expect(parsed.models).toEqual(policy.models);
  });
});

describe("legacy routing.toml retirement", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hive-policy-test-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("renames the dead file aside without reading it, and reports where it went", () => {
    writeFileSync(join(home, "routing.toml"), "[deep.claude]\nmodel = \"whatever\"\n");
    const target = retireLegacyRoutingToml(home);
    expect(target).toBe(join(home, "routing.toml.legacy"));
    expect(existsSync(join(home, "routing.toml"))).toBeFalse();
    expect(readFileSync(target!, "utf8")).toContain("whatever");
  });

  test("does nothing when there is no file, and never overwrites an earlier retirement", () => {
    expect(retireLegacyRoutingToml(home)).toBeNull();
    writeFileSync(join(home, "routing.toml.legacy"), "older retirement\n");
    writeFileSync(join(home, "routing.toml"), "newer file\n");
    const target = retireLegacyRoutingToml(home);
    expect(target).toBe(join(home, "routing.toml.legacy.2"));
    expect(readFileSync(join(home, "routing.toml.legacy"), "utf8"))
      .toBe("older retirement\n");
    expect(readFileSync(target!, "utf8")).toBe("newer file\n");
  });
});

describe("the spawner join — policyModelEnablement answers the AuthorizedLaunch gate", () => {
  // The gate's contract (HiveSpawnerDependencies.isModelEnabled): anything
  // that is not exactly `true` refuses the launch with the Model Control
  // Center remedy, and a throw refuses as "policy unreadable". These tests
  // pin the store's side of that contract over a REAL seeded store; the
  // gate's side is pinned in spawner-impl.test.ts.
  test("a seeded chain grants no consent — first-boot models REFUSE until the user enables each provider", async () => {
    store.seedProvisionalBaseline(
      {
        vendorDefaults: { claude: "claude-fable-5", codex: "gpt-5.6-sol" },
      },
      NOW,
    );
    const isModelEnabled = policyModelEnablement(store);
    expect(await isModelEnabled("claude", "claude-fable-5"))
      .toEqual({
        refusal: "claude-fable-5 cannot launch because exact model consent is not enabled " +
          "under provider claude; enable both in the Model Control Center",
      });
    expect(await isModelEnabled("codex", "gpt-5.6-sol"))
      .toEqual({
        refusal: "gpt-5.6-sol cannot launch because exact model consent is not enabled " +
          "under provider codex; enable both in the Model Control Center",
      });
  });

  test("an unconfigured provider returns a legible refusal until the user's click enables it", async () => {
    store.seedProvisionalBaseline(
      {
        vendorDefaults: { claude: "claude-fable-5", grok: "grok-4.5" },
      },
      NOW,
    );
    const isModelEnabled = policyModelEnablement(store);
    expect(await isModelEnabled("grok", "grok-4.5"))
      .toEqual({
        refusal: "grok-4.5 cannot launch because exact model consent is not enabled " +
          "under provider grok; enable both in the Model Control Center",
      });

    store.apply(
      { op: "set-provider", expectedRevision: 1, provider: "grok", state: "enabled" },
      "the-user",
      NOW,
    );
    store.apply(
      {
        op: "set-model",
        expectedRevision: 2,
        provider: "grok",
        model: "grok-4.5",
        state: "enabled",
      },
      "the-user",
      NOW,
    );
    expect(await isModelEnabled("grok", "grok-4.5")).toBeTrue();
  });

  test("an explicit model disable answers false under an enabled provider; provider-off overrides every model", async () => {
    store.apply(
      { op: "set-provider", expectedRevision: 0, provider: "codex", state: "enabled" },
      "test",
      NOW,
    );
    store.apply(
      {
        op: "set-model",
        expectedRevision: 1,
        provider: "codex",
        model: "gpt-5.6-sol",
        state: "disabled",
      },
      "test",
      NOW,
    );
    store.apply(
      { op: "set-provider", expectedRevision: 2, provider: "claude", state: "disabled" },
      "test",
      NOW,
    );
    const isModelEnabled = policyModelEnablement(store);
    expect(await isModelEnabled("codex", "gpt-5.6-sol")).toBeFalse();
    expect(await isModelEnabled("claude", "claude-fable-5")).toBeFalse();
  });

  test("a corrupt store THROWS through the adapter — the gate renders that as its policy-unreadable refusal", async () => {
    db.database.run(
      "INSERT INTO routing_policy (id, revision, updatedAt, document) VALUES (1, 1, ?, ?)",
      [NOW.toISOString(), "{corrupt"],
    );
    const isModelEnabled = policyModelEnablement(store);
    await expect(isModelEnabled("claude", "claude-fable-5"))
      .rejects.toThrow(RoutingPolicyCorruptError);
  });
});
