import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelPolicyState,
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

  test("provider-off overrides an explicitly enabled model; enabling a provider covers its unlisted models; nothing means nothing", () => {
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
      .toEqual({ state: "enabled", source: "provider" });
    expect(modelPolicyState(policy, "codex", "gpt-anything"))
      .toEqual({ state: "unconfigured", source: "none" });
  });
});

describe("mutations and compare-and-set", () => {
  test("every accepted write increments the revision and clears the provisional flag", () => {
    const seeded = store.seedProvisionalBaseline([], NOW).policy;
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

  test("unset deletes the row — back to inherited/unconfigured, never to an invented state", () => {
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
    expect(policy.models).toEqual([]);
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
    expect(emptied.models).toEqual([]);
  });

  test("a chain stores in the user's order, replaces whole, and clears on empty", () => {
    const chain = store.apply(
      {
        op: "set-chain",
        expectedRevision: 0,
        category: "complex_coding",
        entries: [
          {
            mode: "exact",
            provider: "claude",
            model: "claude-fable-5",
            effort: { mode: "exact", value: "xhigh" },
          },
          {
            mode: "vendor-default",
            provider: "grok",
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

  test('a bare "default" model id is rejected — the labeled vendor-default mode is the only way to track a moving default', () => {
    expect(() =>
      store.apply(
        {
          op: "set-chain",
          expectedRevision: 0,
          category: "planning",
          entries: [{
            mode: "exact",
            provider: "grok",
            model: "default",
            effort: { mode: "provider-controlled" },
          }],
        },
        "test",
        NOW,
      )
    ).toThrow(/vendor-default/);
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
              mode: "exact",
              provider: "claude",
              model: "claude-fable-5",
              effort: { mode: "provider-controlled" },
            },
            {
              mode: "exact",
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

describe("first-boot seeding — enablement is consent", () => {
  test("seeds every category with a labeled vendor-default chain and enables ONLY measured-covered models", () => {
    const { seeded, policy } = store.seedProvisionalBaseline(
      [
        { provider: "claude", model: "claude-fable-5" },
        { provider: "codex", model: "gpt-5.6-sol" },
      ],
      NOW,
    );
    expect(seeded).toBeTrue();
    expect(policy.revision).toBe(1);
    expect(policy.provisional).toBeTrue();
    for (const category of ROUTING_CATEGORIES) {
      const chain = policy.chains[category];
      expect(chain).toBeDefined();
      expect(chain!.length).toBeGreaterThan(0);
      for (const entry of chain!) {
        expect(entry.mode).toBe("vendor-default");
        expect(entry.effort).toEqual({ mode: "provider-controlled" });
      }
    }
    expect(modelPolicyState(policy, "claude", "claude-fable-5").state).toBe("enabled");
    expect(modelPolicyState(policy, "codex", "gpt-5.6-sol").state).toBe("enabled");
    // Grok's billing is unreadable, so nothing of grok's arrives covered — it
    // is present in every seeded chain yet NOT enabled: visible, off, waiting
    // for the user's own click, which is the consent.
    expect(policy.chains.default?.some((entry) => entry.provider === "grok")).toBeTrue();
    expect(modelPolicyState(policy, "grok", "grok-4.5"))
      .toEqual({ state: "unconfigured", source: "none" });
  });

  test("a caller that could not read billing seeds chains with NOTHING enabled — unknown never becomes spend", () => {
    const { policy } = store.seedProvisionalBaseline([], NOW);
    expect(policy.models).toEqual([]);
    expect(Object.keys(policy.chains).sort())
      .toEqual([...ROUTING_CATEGORIES].sort());
  });

  test("seeding never touches an existing policy — not even one seeded by an earlier boot", () => {
    store.seedProvisionalBaseline([], NOW);
    const again = store.seedProvisionalBaseline(
      [{ provider: "claude", model: "claude-fable-5" }],
      NOW,
    );
    expect(again.seeded).toBeFalse();
    expect(again.policy.models).toEqual([]);

    const edited = store.apply(
      { op: "set-provider", expectedRevision: 1, provider: "grok", state: "enabled" },
      "test",
      NOW,
    );
    const afterEdit = store.seedProvisionalBaseline([], NOW);
    expect(afterEdit.seeded).toBeFalse();
    expect(afterEdit.policy.revision).toBe(edited.revision);
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
      [{ provider: "claude", model: "claude-fable-5" }],
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
  test("a seeded plan-covered model answers true — a first-boot spawn on claude/codex PASSES the gate", async () => {
    store.seedProvisionalBaseline(
      [
        { provider: "claude", model: "claude-fable-5" },
        { provider: "codex", model: "gpt-5.6-sol" },
      ],
      NOW,
    );
    const isModelEnabled = policyModelEnablement(store);
    expect(await isModelEnabled("claude", "claude-fable-5")).toBeTrue();
    expect(await isModelEnabled("codex", "gpt-5.6-sol")).toBeTrue();
  });

  test("grok (seeded off, billing unreadable) answers null — the gate REFUSES until the user's click enables it", async () => {
    store.seedProvisionalBaseline(
      [{ provider: "claude", model: "claude-fable-5" }],
      NOW,
    );
    const isModelEnabled = policyModelEnablement(store);
    expect(await isModelEnabled("grok", "grok-4.5")).toBeNull();

    store.apply(
      { op: "set-provider", expectedRevision: 1, provider: "grok", state: "enabled" },
      "the-user",
      NOW,
    );
    expect(await isModelEnabled("grok", "grok-4.5")).toBeTrue();
  });

  test("an explicit disable answers false; provider-off answers false for every model under it", async () => {
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
    store.apply(
      { op: "set-provider", expectedRevision: 1, provider: "claude", state: "disabled" },
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
