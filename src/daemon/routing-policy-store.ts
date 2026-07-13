import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  CAPABILITY_PROVIDERS,
  emptyRoutingPolicy,
  modelPolicyState,
  ROUTING_CATEGORIES,
  RoutingPolicyMutationSchema,
  RoutingPolicySchema,
  type CapabilityProvider,
  type ChainEntry,
  type RoutingCategory,
  type RoutingPolicy,
  type RoutingPolicyMutation,
} from "../schemas";
import type { HiveDatabase } from "./db";

/**
 * The policy store: one revisioned document in hive.db, the daemon its sole
 * writer. SQLite was the ruling (governing doc §3.1) because policy writes
 * need compare-and-set plus an audit trail, and Hive already runs this
 * database; the document is stored whole — one row, canonical JSON — because
 * every reader and writer handles the whole policy, and a whole-document
 * schema parse on every read is what makes corruption LOUD instead of
 * permissive.
 *
 * THIS IS THE CONSENT RECORD, not a preferences blob: with the approval
 * prompts retired (user directive 2026-07-12), a model enabled here IS the
 * user's standing authorization to spend on it. Every write path below is a
 * safety surface.
 *
 * FAIL-CLOSED: a store with no policy row reads as the empty revision-0
 * document — nothing configured, and not-configured never means allowed. A
 * row that exists but does not parse THROWS; it never degrades to the empty
 * document, because "I could not read your policy" and "you have no policy"
 * are different facts and only one of them may be answered with defaults
 * (repo memory: unknown-read-as-permission).
 */

/** A write raced another writer: the caller's revision is stale. The current
 * revision rides along so the client can reload and re-apply. */
export class RoutingPolicyConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`revision conflict: policy is at revision ${currentRevision}`);
    this.name = "RoutingPolicyConflictError";
  }
}

/** The stored policy exists but cannot be trusted. Deliberately NOT recovered
 * from: an unreadable policy must stop policy-dependent work, not silently
 * become an empty (permissive-looking) one. */
export class RoutingPolicyCorruptError extends Error {
  constructor(detail: string) {
    super(
      `the stored routing policy is unreadable and Hive will not guess: ${detail}. ` +
        "Nothing was reset; inspect routing_policy in hive.db.",
    );
    this.name = "RoutingPolicyCorruptError";
  }
}

export class RoutingPolicyStore {
  constructor(private readonly db: HiveDatabase) {
    this.db.database.exec(`
      CREATE TABLE IF NOT EXISTS routing_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        updatedAt TEXT NOT NULL,
        document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routing_policy_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        operation TEXT NOT NULL,
        revision INTEGER NOT NULL,
        before TEXT,
        after TEXT NOT NULL
      );
    `);
  }

  /** The whole policy. No row → the empty revision-0 document (nothing
   * configured). An unparseable row → RoutingPolicyCorruptError, never a
   * quiet empty. */
  read(now: Date = new Date()): RoutingPolicy {
    const row = this.db.database.query(
      "SELECT document FROM routing_policy WHERE id = 1",
    ).get() as { document: string } | null;
    if (row === null) return emptyRoutingPolicy(now.toISOString());
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.document);
    } catch (error) {
      throw new RoutingPolicyCorruptError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const parsed = RoutingPolicySchema.safeParse(decoded);
    if (!parsed.success) {
      throw new RoutingPolicyCorruptError(parsed.error.message);
    }
    return parsed.data;
  }

  /**
   * Apply one validated mutation with compare-and-set. The transaction
   * re-reads the live revision, so a concurrent write loses loudly
   * (RoutingPolicyConflictError names the revision to reload) instead of
   * clobbering. Every accepted write appends a routing_policy_events row and
   * clears `provisional` — the document stops being Hive's suggestion the
   * moment a human edits it.
   */
  apply(
    mutation: RoutingPolicyMutation,
    actor: string,
    now: Date = new Date(),
  ): RoutingPolicy {
    const validated = RoutingPolicyMutationSchema.parse(mutation);
    return this.db.database.transaction(() => {
      const current = this.read(now);
      if (validated.expectedRevision !== current.revision) {
        throw new RoutingPolicyConflictError(current.revision);
      }
      const next = RoutingPolicySchema.parse({
        ...applyMutation(current, validated),
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
        provisional: false,
      });
      this.write(next, current, validated.op, actor, now);
      return next;
    })();
  }

  /** Whether any policy has ever been written. Callers use this to decide
   * whether first-boot seeding (and its billing probes) are worth running. */
  isEmpty(): boolean {
    return this.db.database.query(
      "SELECT id FROM routing_policy WHERE id = 1",
    ).get() === null;
  }

  /**
   * First-boot seeding: when NO policy row exists, write the provisional
   * baseline so the router ships ready to use. Every chain entry names an
   * EXACT model id (user ruling 2026-07-13: "we are specific on the models
   * that we choose"): `vendorDefaults` carries each vendor's then-current
   * default AS READ FROM ITS LIVE CATALOG by the caller — frozen here as a
   * specific id, never re-resolved, never a training-memory guess. A vendor
   * whose catalog could not be read is simply absent from seeded chains
   * (skipped, not invented). Efforts seed provider-controlled — never
   * invented either.
   *
   * ENABLEMENT IS CONSENT (user directive 2026-07-12: "no more prompting,
   * the user sets it up"), so the seed may enable ONLY what is measured safe:
   * `coveredModels` is the set of models whose billing Hive has actually READ
   * as plan-covered — those ship enabled and the router works out of the box.
   * Everything else stays UNCONFIGURED, which reads as not-enabled: visible
   * in the UI, off until the user's own click, and that click is the consent.
   * There is no path from "we could not tell" to "we spent his money" — a
   * caller that could not read billing passes an empty list and the seed
   * enables nothing. A store that already has a policy — even revision 1 from
   * an earlier boot — is left exactly alone.
   */
  seedProvisionalBaseline(
    facts: {
      coveredModels: readonly { provider: CapabilityProvider; model: string }[];
      vendorDefaults: Partial<Record<CapabilityProvider, string>>;
    },
    now: Date = new Date(),
  ): { seeded: boolean; policy: RoutingPolicy } {
    return this.db.database.transaction(() => {
      if (!this.isEmpty()) return { seeded: false, policy: this.read(now) };
      const policy = RoutingPolicySchema.parse({
        ...emptyRoutingPolicy(now.toISOString()),
        revision: 1,
        provisional: true,
        models: facts.coveredModels.map(({ provider, model }) => ({
          provider,
          model,
          state: "enabled" as const,
        })),
        chains: provisionalBaselineChains(facts.vendorDefaults),
      });
      this.write(policy, null, "seed-provisional-baseline", "hive", now);
      return { seeded: true, policy };
    })();
  }

  private write(
    next: RoutingPolicy,
    before: RoutingPolicy | null,
    operation: string,
    actor: string,
    now: Date,
  ): void {
    const document = canonicalRoutingPolicyJson(next);
    this.db.database.run(
      `INSERT INTO routing_policy (id, revision, updatedAt, document)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE
       SET revision = excluded.revision,
           updatedAt = excluded.updatedAt,
           document = excluded.document`,
      [next.revision, next.updatedAt, document],
    );
    this.db.database.run(
      `INSERT INTO routing_policy_events (at, actor, operation, revision, before, after)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        now.toISOString(),
        actor,
        operation,
        next.revision,
        before === null ? null : canonicalRoutingPolicyJson(before),
        document,
      ],
    );
  }
}

/** Pure mutation semantics, shared by the store and its tests. "unset"
 * deletes the row — back to inherited/unconfigured, never to an invented
 * state. A model row lives while it still says something (a state or an
 * effort) and is dropped when it says nothing. */
function applyMutation(
  policy: RoutingPolicy,
  mutation: RoutingPolicyMutation,
): RoutingPolicy {
  switch (mutation.op) {
    case "set-provider": {
      const providers = { ...policy.providers };
      if (mutation.state === "unset") delete providers[mutation.provider];
      else providers[mutation.provider] = mutation.state;
      return { ...policy, providers };
    }
    case "set-model": {
      const rest = withoutModelRow(policy, mutation.provider, mutation.model);
      const existing = modelRow(policy, mutation.provider, mutation.model);
      if (mutation.state === "unset") {
        return existing?.effort === undefined ? { ...policy, models: rest } : {
          ...policy,
          models: [...rest, {
            provider: mutation.provider,
            model: mutation.model,
            effort: existing.effort,
          }],
        };
      }
      return {
        ...policy,
        models: [...rest, {
          provider: mutation.provider,
          model: mutation.model,
          state: mutation.state,
          ...(existing?.effort === undefined ? {} : { effort: existing.effort }),
        }],
      };
    }
    case "set-effort": {
      const rest = withoutModelRow(policy, mutation.provider, mutation.model);
      const existing = modelRow(policy, mutation.provider, mutation.model);
      if (mutation.effort === "unset") {
        return existing?.state === undefined ? { ...policy, models: rest } : {
          ...policy,
          models: [...rest, {
            provider: mutation.provider,
            model: mutation.model,
            state: existing.state,
          }],
        };
      }
      return {
        ...policy,
        models: [...rest, {
          provider: mutation.provider,
          model: mutation.model,
          ...(existing?.state === undefined ? {} : { state: existing.state }),
          effort: mutation.effort,
        }],
      };
    }
    case "set-chain": {
      const chains = { ...policy.chains };
      if (mutation.entries.length === 0) delete chains[mutation.category];
      else chains[mutation.category] = mutation.entries;
      return { ...policy, chains };
    }
    case "set-selection": {
      if (mutation.category === undefined) {
        return mutation.mode === "unset" ? policy : {
          ...policy,
          selection: { ...policy.selection, global: mutation.mode },
        };
      }
      const categories = { ...policy.selection.categories };
      if (mutation.mode === "unset") delete categories[mutation.category];
      else categories[mutation.category] = mutation.mode;
      return { ...policy, selection: { ...policy.selection, categories } };
    }
  }
}

const modelRow = (
  policy: RoutingPolicy,
  provider: CapabilityProvider,
  model: string,
) =>
  policy.models.find((row) => row.provider === provider && row.model === model);

const withoutModelRow = (
  policy: RoutingPolicy,
  provider: CapabilityProvider,
  model: string,
) =>
  policy.models.filter((row) =>
    !(row.provider === provider && row.model === model)
  );

/** All vendors, led by the named one — a deliberate provisional ORDER over
 * the whole union, so a newly added vendor appears in seeded chains instead
 * of being invisible until someone edits policy. */
const leadWith = (leader: CapabilityProvider): CapabilityProvider[] => [
  leader,
  ...CAPABILITY_PROVIDERS.filter((provider) => provider !== leader),
];

/**
 * The provisional baseline (governing doc §2.8): every entry is an EXACT
 * model id — the vendor's own current default, read live at seed time and
 * frozen — in an assumed order per category: strong-reasoning vendor first
 * for deep work, the coding specialist first for code-shaped work, the
 * unmetered generalist first for light work to spread load off the coding
 * pools. Assumed, labeled provisional, fully editable; no outcome data backs
 * it yet. The binary ships the ORDER only; every model id comes from the
 * live catalog, and an unreadable vendor is skipped rather than guessed.
 */
function provisionalBaselineChains(
  vendorDefaults: Partial<Record<CapabilityProvider, string>>,
): Partial<Record<RoutingCategory, ChainEntry[]>> {
  const chainOf = (providers: CapabilityProvider[]): ChainEntry[] =>
    providers.flatMap((provider) => {
      const model = vendorDefaults[provider];
      return model === undefined ? [] : [{
        provider,
        model,
        effort: { mode: "provider-controlled" as const },
      }];
    });
  const claudeLed = chainOf(leadWith("claude"));
  const codexLed = chainOf(leadWith("codex"));
  const grokLed = chainOf(leadWith("grok"));
  const chains: Partial<Record<RoutingCategory, ChainEntry[]>> = {};
  const assign = (category: RoutingCategory, chain: ChainEntry[]): void => {
    if (chain.length > 0) chains[category] = chain;
  };
  assign("light_research", grokLed);
  assign("heavy_research", claudeLed);
  assign("simple_coding", codexLed);
  assign("complex_coding", claudeLed);
  assign("code_review", codexLed);
  assign("planning", claudeLed);
  assign("debugging", claudeLed);
  assign("summarization", grokLed);
  assign("default", codexLed);
  return chains;
}

/**
 * Deterministic serialization — the inspectability half of the SQLite ruling.
 * Key order is fixed (providers in union order, models sorted, chains in
 * category order; entry order is the user's and is preserved), so identical
 * policy is byte-identical output and two exports diff cleanly.
 */
export function canonicalRoutingPolicyJson(policy: RoutingPolicy): string {
  const providers: Record<string, string> = {};
  for (const provider of CAPABILITY_PROVIDERS) {
    const state = policy.providers[provider];
    if (state !== undefined) providers[provider] = state;
  }
  const models = [...policy.models].sort((left, right) =>
    left.provider.localeCompare(right.provider) ||
    left.model.localeCompare(right.model)
  ).map((row) => ({
    provider: row.provider,
    model: row.model,
    ...(row.state === undefined ? {} : { state: row.state }),
    ...(row.effort === undefined ? {} : { effort: row.effort }),
  }));
  const chains: Record<string, ChainEntry[]> = {};
  for (const category of ROUTING_CATEGORIES) {
    const chain = policy.chains[category];
    if (chain !== undefined) chains[category] = chain;
  }
  const selectionCategories: Record<string, string> = {};
  for (const category of ROUTING_CATEGORIES) {
    const mode = policy.selection.categories[category];
    if (mode !== undefined) selectionCategories[category] = mode;
  }
  return JSON.stringify(
    {
      schemaVersion: policy.schemaVersion,
      revision: policy.revision,
      updatedAt: policy.updatedAt,
      provisional: policy.provisional,
      selection: { global: policy.selection.global, categories: selectionCategories },
      providers,
      models,
      chains,
    },
    null,
    2,
  ) + "\n";
}

/**
 * The spawner's enablement dependency (`HiveSpawnerDependencies.
 * isModelEnabled`), answered from the policy store — THE JOIN between the
 * consent record and the AuthorizedLaunch gate. The contract, verbatim from
 * the dependency's declaration: true = enabled (the user's consent); false =
 * explicitly disabled; null = unreadable/missing — and the gate refuses
 * anything that is not exactly true, so absence stays fail-closed on both
 * sides. A corrupt store THROWS out of here deliberately: the gate turns
 * that into its "policy unreadable" refusal instead of this adapter guessing.
 *
 * Identity: policy rows are keyed by canonical id, which every vendor's
 * discovery currently sets identical to the launch token the gate passes in
 * (capability-discovery.ts). An alias-shaped explicit request therefore reads
 * unconfigured — refused with the Control Center remedy, never silently
 * enabled; alias-aware matching belongs to the wiring PR that hands the gate
 * canonical identities.
 */
export function policyModelEnablement(
  store: RoutingPolicyStore,
): (provider: CapabilityProvider, model: string) => Promise<boolean | null> {
  return async (provider, model) => {
    const { state } = modelPolicyState(store.read(), provider, model);
    if (state === "enabled") return true;
    if (state === "disabled") return false;
    return null;
  };
}

/**
 * routing.toml is dead as a policy source (user directive 2026-07-12: "i dont
 * care about legacy router"). It is renamed aside, not deleted — dropping a
 * routing preference was the user's call; destroying his file is not ours.
 * Nothing reads the renamed file, and nothing interprets the old contents.
 */
export function retireLegacyRoutingToml(hiveHome: string): string | null {
  const source = join(hiveHome, "routing.toml");
  if (!existsSync(source)) return null;
  let target = join(hiveHome, "routing.toml.legacy");
  if (existsSync(target)) {
    // A .legacy from an earlier retirement is itself preserved.
    let suffix = 2;
    while (existsSync(`${target}.${suffix}`)) suffix += 1;
    target = `${target}.${suffix}`;
  }
  renameSync(source, target);
  return target;
}
