import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/db";
import {
  canonicalRoutingPolicyJson,
  policyModelEnablement,
  RoutingPolicyConflictError,
  RoutingPolicyCorruptError,
  RoutingPolicyStore,
  retireLegacyRoutingToml,
} from "../../src/daemon/routing-policy-store";
import {
  modelPolicyState,
  providerPolicyState,
  resolveRoute,
  type RoutePolicy,
  type RoutingPolicy,
} from "../../src/schemas";
import { required } from "../required";

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
    expect(policy.global).toBeNull();
    expect(policy.categories).toEqual({});
    expect(providerPolicyState(policy, "grok")).toBe("unconfigured");
    expect(modelPolicyState(policy, "grok", "grok-4.5")).toEqual({
      state: "unconfigured",
      source: "none",
    });
  });

  test("a stored V2 chain document migrates to weighted routes without inventing weights or consent", () => {
    const legacy = {
      schemaVersion: 2,
      revision: 6,
      updatedAt: NOW.toISOString(),
      provisional: true,
      providers: { claude: "enabled" },
      models: [
        {
          provider: "claude",
          model: "claude-fable-5",
          state: "enabled",
          effort: { mode: "hive-decides" },
        },
      ],
      chains: {
        default: [
          {
            provider: "claude",
            model: "claude-fable-5",
            effort: { mode: "exact", value: "high" },
          },
          {
            provider: "codex",
            model: "gpt-5.6-sol",
            effort: { mode: "never-configured" },
          },
        ],
        planning: [
          { provider: "grok", model: "grok-4.5", effort: { mode: "none" } },
        ],
      },
      selection: { global: "choice" },
    };
    db.database.run(
      "INSERT INTO routing_policy (id, revision, updatedAt, document) VALUES (1, 6, ?, ?)",
      [NOW.toISOString(), JSON.stringify(legacy)],
    );

    const migrated = new RoutingPolicyStore(db).read(NOW);

    // Every chain becomes a hive-equal route over the same exact candidates at
    // weight 1: rank order is dropped, never converted into invented ratings.
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.revision).toBe(7);
    expect(migrated.provisional).toBeTrue();
    expect(migrated.global).toEqual({
      mode: "hive-equal",
      candidates: [
        {
          provider: "claude",
          model: "claude-fable-5",
          effort: { mode: "exact", value: "high" },
          weight: 1,
        },
        {
          // never-configured is a model-row state, not a launchable intent.
          provider: "codex",
          model: "gpt-5.6-sol",
          effort: { mode: "provider-controlled" },
          weight: 1,
        },
      ],
    });
    expect(migrated.categories).toEqual({
      planning: {
        mode: "hive-equal",
        candidates: [
          {
            provider: "grok",
            model: "grok-4.5",
            effort: { mode: "none" },
            weight: 1,
          },
        ],
      },
    });
    // Enablement copies through untouched: no new consent is created.
    expect(migrated.providers).toEqual({ claude: "enabled" });
    expect(migrated.models).toEqual([
      {
        provider: "claude",
        model: "claude-fable-5",
        state: "enabled",
        effort: { mode: "hive-decides" },
      },
    ]);
    const event = db.database
      .query(
        "SELECT operation, revision FROM routing_policy_events ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(event).toEqual({
      operation: "migrate-v2-weighted-routes",
      revision: 7,
    });
    // Durable: re-open on the same DB does not re-bump.
    expect(new RoutingPolicyStore(db).read(NOW).revision).toBe(7);
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
      [
        NOW.toISOString(),
        JSON.stringify({ schemaVersion: 99, everything: "fine" }),
      ],
    );
    expect(() => store.read(NOW)).toThrow(RoutingPolicyCorruptError);
  });

  test("provider-off overrides a model; provider enablement covers models not explicitly disabled", () => {
    let policy = store.apply(
      {
        op: "set-provider",
        expectedRevision: 0,
        provider: "claude",
        state: "enabled",
      },
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
      {
        op: "set-provider",
        expectedRevision: 2,
        provider: "claude",
        state: "disabled",
      },
      "test",
      NOW,
    );
    expect(modelPolicyState(policy, "claude", "claude-fable-5")).toEqual({
      state: "disabled",
      source: "provider",
    });

    policy = store.apply(
      {
        op: "set-provider",
        expectedRevision: 3,
        provider: "claude",
        state: "enabled",
      },
      "test",
      NOW,
    );
    expect(modelPolicyState(policy, "claude", "claude-unlisted")).toEqual({
      state: "enabled",
      source: "provider",
    });
    expect(modelPolicyState(policy, "codex", "gpt-anything")).toEqual({
      state: "unconfigured",
      source: "none",
    });
  });
});

describe("route resolution", () => {
  const route = (model: string): RoutePolicy => ({
    mode: "hive-equal",
    candidates: [
      {
        provider: "claude",
        model,
        effort: { mode: "provider-controlled" },
        weight: 1,
      },
    ],
  });

  test("a category's own route answers; otherwise global; otherwise nothing — never an appended fallback", () => {
    const policy: RoutingPolicy = {
      ...store.read(NOW),
      global: route("claude-fable-5"),
      categories: { planning: route("claude-opus-5") },
    };
    expect(resolveRoute(policy, "planning")).toEqual({
      scope: "planning",
      route: route("claude-opus-5"),
    });
    expect(resolveRoute(policy, "debugging")).toEqual({
      scope: "global",
      route: route("claude-fable-5"),
    });
    expect(
      resolveRoute({ ...policy, global: null, categories: {} }, "planning"),
    ).toBeNull();
  });
});

describe("mutations and compare-and-set", () => {
  test("every accepted write increments the revision and clears the provisional flag", () => {
    const seeded = store.seedProvisionalBaseline(
      { vendorDefaults: {} },
      NOW,
    ).policy;
    expect(seeded.revision).toBe(1);
    expect(seeded.provisional).toBeTrue();
    const edited = store.apply(
      {
        op: "set-provider",
        expectedRevision: 1,
        provider: "grok",
        state: "enabled",
      },
      "test",
      NOW,
    );
    expect(edited.revision).toBe(2);
    expect(edited.provisional).toBeFalse();
    expect(edited.providers.grok).toBe("enabled");
  });

  test("a stale revision is rejected loudly, names the live revision, and changes nothing", () => {
    store.apply(
      {
        op: "set-provider",
        expectedRevision: 0,
        provider: "claude",
        state: "enabled",
      },
      "test",
      NOW,
    );
    expect(() =>
      store.apply(
        {
          op: "set-provider",
          expectedRevision: 0,
          provider: "claude",
          state: "disabled",
        },
        "test",
        NOW,
      ),
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
    expect(policy.models).toEqual([
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        state: undefined,
        effort: { mode: "never-configured" },
      },
    ]);
    expect(modelPolicyState(policy, "codex", "gpt-5.6-sol")).toEqual({
      state: "unconfigured",
      source: "none",
    });
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
      {
        provider: "grok",
        model: "grok-4.5",
        effort: { mode: "exact", value: "high" },
      },
    ]);
    expect(modelPolicyState(policy, "grok", "grok-4.5")).toEqual({
      state: "unconfigured",
      source: "none",
    });
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
    expect(emptied.models).toEqual([
      {
        provider: "claude",
        model: "claude-fable-5",
        effort: { mode: "never-configured" },
      },
    ]);
  });

  test("a route replaces its scope whole, and null clears it back to unconfigured", () => {
    const withRoute = store.apply(
      {
        op: "set-route",
        expectedRevision: 0,
        scope: "complex_coding",
        route: {
          mode: "user-weighted",
          candidates: [
            {
              provider: "claude",
              model: "claude-fable-5",
              effort: { mode: "exact", value: "xhigh" },
              weight: 3,
            },
            {
              provider: "grok",
              model: "grok-4.5",
              effort: { mode: "provider-controlled" },
              weight: 1,
            },
          ],
        },
      },
      "test",
      NOW,
    );
    expect(
      withRoute.categories.complex_coding?.candidates.map(
        (candidate) => candidate.provider,
      ),
    ).toEqual(["claude", "grok"]);
    const cleared = store.apply(
      {
        op: "set-route",
        expectedRevision: 1,
        scope: "complex_coding",
        route: null,
      },
      "test",
      NOW,
    );
    expect(cleared.categories.complex_coding).toBeUndefined();
  });

  test("setting a route upserts an enabled model row per candidate, keeping an existing effort choice", () => {
    store.apply(
      {
        op: "set-effort",
        expectedRevision: 0,
        provider: "claude",
        model: "claude-fable-5",
        effort: { mode: "exact", value: "high" },
      },
      "test",
      NOW,
    );
    const policy = store.apply(
      {
        op: "set-route",
        expectedRevision: 1,
        scope: "global",
        route: {
          mode: "hive-equal",
          candidates: [
            {
              provider: "claude",
              model: "claude-fable-5",
              effort: { mode: "hive-decides" },
              weight: 1,
            },
            {
              provider: "grok",
              model: "grok-4.5",
              effort: { mode: "none" },
              weight: 1,
            },
          ],
        },
      },
      "test",
      NOW,
    );
    expect(policy.global?.candidates).toHaveLength(2);
    expect(policy.models).toContainEqual({
      provider: "claude",
      model: "claude-fable-5",
      state: "enabled",
      effort: { mode: "exact", value: "high" },
    });
    expect(policy.models).toContainEqual({
      provider: "grok",
      model: "grok-4.5",
      state: "enabled",
      effort: { mode: "none" },
    });
  });

  test('a bare "default" model id is rejected — a route names the specific model that will run', () => {
    expect(() =>
      store.apply(
        {
          op: "set-route",
          expectedRevision: 0,
          scope: "planning",
          route: {
            mode: "hive-equal",
            candidates: [
              {
                provider: "grok",
                model: "default",
                effort: { mode: "provider-controlled" },
                weight: 1,
              },
            ],
          },
        },
        "test",
        NOW,
      ),
    ).toThrow(/not a model/);
  });

  test("a route naming the same target twice is rejected", () => {
    expect(() =>
      store.apply(
        {
          op: "set-route",
          expectedRevision: 0,
          scope: "planning",
          route: {
            mode: "hive-equal",
            candidates: [
              {
                provider: "claude",
                model: "claude-fable-5",
                effort: { mode: "provider-controlled" },
                weight: 1,
              },
              {
                provider: "claude",
                model: "claude-fable-5",
                effort: { mode: "exact", value: "high" },
                weight: 2,
              },
            ],
          },
        },
        "test",
        NOW,
      ),
    ).toThrow(/twice/);
  });

  test("every accepted write appends an audit event with before and after", () => {
    store.apply(
      {
        op: "set-provider",
        expectedRevision: 0,
        provider: "claude",
        state: "enabled",
      },
      "the-operator",
      NOW,
    );
    const events = db.database
      .query(
        "SELECT actor, operation, revision, before, after FROM routing_policy_events ORDER BY id",
      )
      .all() as {
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
    expect(events[0]?.after).toContain('"claude": "enabled"');
  });
});

describe("first-boot seeding — consent is never seeded, candidates are exact ids", () => {
  const DEFAULTS = {
    claude: "claude-fable-5",
    codex: "gpt-5.6-sol",
    grok: "grok-4.5",
    kimi: "kimi-code/kimi-for-coding",
    opencode: "opencode/big-pickle",
  } as const;

  test("seeds ONE global hive-equal route of exact frozen model ids, no per-category routes, no enablement", () => {
    const { seeded, policy } = store.seedProvisionalBaseline(
      {
        vendorDefaults: DEFAULTS,
      },
      NOW,
    );
    expect(seeded).toBeTrue();
    expect(policy.revision).toBe(1);
    expect(policy.provisional).toBeTrue();
    const global = required(policy.global);
    expect(global.mode).toBe("hive-equal");
    expect(global.candidates).toHaveLength(5);
    for (const candidate of global.candidates) {
      // Every candidate names the specific model that will run — no mode
      // field, no indirection of any kind.
      expect(candidate.model).toBe(DEFAULTS[candidate.provider]);
      expect(candidate.effort).toEqual({ mode: "provider-controlled" });
      expect(candidate.weight).toBe(1);
    }
    expect(policy.categories).toEqual({});
    expect(policy.providers).toEqual({});
    expect(policy.models).toEqual([]);
    // Every frozen default is named in the suggested route but remains off,
    // waiting for the user's own click, which is the consent.
    expect(modelPolicyState(policy, "claude", "claude-fable-5")).toEqual({
      state: "unconfigured",
      source: "none",
    });
    expect(modelPolicyState(policy, "grok", "grok-4.5")).toEqual({
      state: "unconfigured",
      source: "none",
    });
  });

  test("an unreadable vendor is skipped in the seeded route — never guessed from training knowledge", () => {
    const { policy } = store.seedProvisionalBaseline(
      {
        vendorDefaults: { claude: "claude-fable-5" },
      },
      NOW,
    );
    expect(
      required(policy.global).candidates.map((candidate) => candidate.provider),
    ).toEqual(["claude"]);
  });

  test("a caller that could read nothing seeds NOTHING enabled and no route — unknown never becomes spend or a guessed id", () => {
    const { policy } = store.seedProvisionalBaseline(
      { vendorDefaults: {} },
      NOW,
    );
    expect(policy.models).toEqual([]);
    expect(policy.global).toBeNull();
    expect(policy.categories).toEqual({});
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
      {
        op: "set-provider",
        expectedRevision: 1,
        provider: "grok",
        state: "enabled",
      },
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
      {
        op: "set-provider",
        expectedRevision: 0,
        provider: "grok",
        state: "enabled",
      },
      "human",
      NOW,
    );
    const policy = source.apply(
      {
        op: "set-route",
        expectedRevision: 1,
        scope: "light_research",
        route: {
          mode: "user-weighted",
          candidates: [
            {
              provider: "grok",
              model: "grok-4.5",
              effort: { mode: "exact", value: "low" },
              weight: 2,
            },
          ],
        },
      },
      "human",
      NOW,
    );
    return { db: sourceDb, policy };
  }

  test("copies routes, model consent, provider switches, and effort into an empty store", () => {
    const source = userPolicy();
    try {
      const result = store.importDefaultPolicy(source.policy, NOW);
      expect(result.imported).toBeTrue();
      expect(result.policy.revision).toBe(1);
      expect(result.policy.provisional).toBeFalse();
      expect(result.policy.providers).toEqual(source.policy.providers);
      expect(result.policy.models).toEqual(source.policy.models);
      expect(result.policy.global).toEqual(source.policy.global);
      expect(result.policy.categories).toEqual(source.policy.categories);
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
      expect(
        result.policy.categories.light_research?.candidates[0]?.model,
      ).toBe("grok-4.5");
    } finally {
      source.db.close();
    }
  });

  test("never overwrites a named instance's own edit or imports provisional consent", () => {
    const provisionalDb = new HiveDatabase(":memory:");
    const provisional = new RoutingPolicyStore(
      provisionalDb,
    ).seedProvisionalBaseline(
      { vendorDefaults: { grok: "grok-4.5" } },
      NOW,
    ).policy;
    try {
      expect(store.importDefaultPolicy(provisional, NOW).imported).toBeFalse();
      store.apply(
        {
          op: "set-provider",
          expectedRevision: 0,
          provider: "codex",
          state: "disabled",
        },
        "named-instance-user",
        NOW,
      );
      const source = userPolicy();
      try {
        expect(
          store.importDefaultPolicy(source.policy, NOW).imported,
        ).toBeFalse();
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
      {
        op: "set-provider",
        expectedRevision: 0,
        provider: "claude",
        state: "enabled",
      },
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
      {
        op: "set-provider",
        expectedRevision: 1,
        provider: "claude",
        state: "enabled",
      },
      "test",
      NOW,
    );
    expect(canonicalRoutingPolicyJson(store.read(NOW))).toBe(
      canonicalRoutingPolicyJson(otherStore.read(NOW)),
    );
    other.close();
  });

  test("the export round-trips: canonical output is the same document", () => {
    const policy = store.seedProvisionalBaseline(
      {
        vendorDefaults: { claude: "claude-fable-5", codex: "gpt-5.6-sol" },
      },
      NOW,
    ).policy;
    const parsed = JSON.parse(
      canonicalRoutingPolicyJson(policy),
    ) as RoutingPolicy;
    expect(parsed.revision).toBe(policy.revision);
    expect(parsed.global).toEqual(policy.global);
    expect(parsed.categories).toEqual(policy.categories);
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
    writeFileSync(
      join(home, "routing.toml"),
      '[deep.claude]\nmodel = "whatever"\n',
    );
    const target = retireLegacyRoutingToml(home);
    expect(target).toBe(join(home, "routing.toml.legacy"));
    expect(existsSync(join(home, "routing.toml"))).toBeFalse();
    expect(readFileSync(required(target), "utf8")).toContain("whatever");
  });

  test("does nothing when there is no file, and never overwrites an earlier retirement", () => {
    expect(retireLegacyRoutingToml(home)).toBeNull();
    writeFileSync(join(home, "routing.toml.legacy"), "older retirement\n");
    writeFileSync(join(home, "routing.toml"), "newer file\n");
    const target = retireLegacyRoutingToml(home);
    expect(target).toBe(join(home, "routing.toml.legacy.2"));
    expect(readFileSync(join(home, "routing.toml.legacy"), "utf8")).toBe(
      "older retirement\n",
    );
    expect(readFileSync(required(target), "utf8")).toBe("newer file\n");
  });
});

describe("the spawner join — policyModelEnablement answers the AuthorizedLaunch gate", () => {
  // The gate's contract (HiveSpawnerDependencies.isModelEnabled): anything
  // that is not exactly `true` refuses the launch with the Model Control
  // Center remedy, and a throw refuses as "policy unreadable". These tests
  // pin the store's side of that contract over a REAL seeded store; the
  // gate's side is pinned in spawner-impl.test.ts.
  test("a seeded route grants no consent — first-boot models REFUSE until the user enables each provider", async () => {
    store.seedProvisionalBaseline(
      {
        vendorDefaults: { claude: "claude-fable-5", codex: "gpt-5.6-sol" },
      },
      NOW,
    );
    const isModelEnabled = policyModelEnablement(store);
    expect(await isModelEnabled("claude", "claude-fable-5")).toEqual({
      refusal:
        "claude-fable-5 cannot launch because provider claude is not enabled " +
        "in the Model Control Center",
    });
    expect(await isModelEnabled("codex", "gpt-5.6-sol")).toEqual({
      refusal:
        "gpt-5.6-sol cannot launch because provider codex is not enabled " +
        "in the Model Control Center",
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
    expect(await isModelEnabled("grok", "grok-4.5")).toEqual({
      refusal:
        "grok-4.5 cannot launch because provider grok is not enabled " +
        "in the Model Control Center",
    });

    store.apply(
      {
        op: "set-provider",
        expectedRevision: 1,
        provider: "grok",
        state: "enabled",
      },
      "the-user",
      NOW,
    );
    expect(await isModelEnabled("grok", "grok-4.5")).toBeTrue();
  });

  test("an explicit model disable answers false under an enabled provider; provider-off overrides every model", async () => {
    store.apply(
      {
        op: "set-provider",
        expectedRevision: 0,
        provider: "codex",
        state: "enabled",
      },
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
      {
        op: "set-provider",
        expectedRevision: 2,
        provider: "claude",
        state: "disabled",
      },
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
    await expect(isModelEnabled("claude", "claude-fable-5")).rejects.toThrow(
      RoutingPolicyCorruptError,
    );
  });
});
