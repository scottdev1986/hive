import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CAPABILITY_PROVIDERS,
  emptyRoutingPolicy,
  modelPolicyState,
  ROUTING_CATEGORIES,
  RoutingPolicyMutationSchema,
  RoutingPolicySchema,
  type CapabilityProvider,
  type ChainEntry,
  type ModelEnablementDecision,
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
    // Strip retired categories before any schema-strict parse: an unknown
    // category key makes RoutingPolicySchema.safeParse throw on load.
    this.migrateStoredStripProfilingCategory();
    this.migrateStoredV1();
  }

  /**
   * The `profiling` routing category was removed (product decision). A
   * persisted policy may still carry a `profiling` chain or selection row from
   * an older baseline seed. RoutingPolicySchema rejects unknown categories —
   * it does not drop them — so load would throw RoutingPolicyCorruptError.
   * Strip the retired key(s) and rewrite, same defensive style as v1 migrate:
   * unparseable JSON is left alone for the corrupt-row path to surface.
   */
  private migrateStoredStripProfilingCategory(now: Date = new Date()): void {
    const row = this.db.database.query(
      "SELECT document FROM routing_policy WHERE id = 1",
    ).get() as { document: string } | null;
    if (row === null) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.document);
    } catch {
      return;
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return;
    }
    const doc = { ...(decoded as Record<string, unknown>) };
    let changed = false;

    if (
      typeof doc.chains === "object" &&
      doc.chains !== null &&
      !Array.isArray(doc.chains) &&
      Object.prototype.hasOwnProperty.call(doc.chains, "profiling")
    ) {
      const { profiling: _removed, ...chains } = doc.chains as Record<string, unknown>;
      doc.chains = chains;
      changed = true;
    }

    if (
      typeof doc.selection === "object" &&
      doc.selection !== null &&
      !Array.isArray(doc.selection)
    ) {
      const selection = { ...(doc.selection as Record<string, unknown>) };
      if (
        typeof selection.categories === "object" &&
        selection.categories !== null &&
        !Array.isArray(selection.categories) &&
        Object.prototype.hasOwnProperty.call(selection.categories, "profiling")
      ) {
        const { profiling: _removed, ...categories } =
          selection.categories as Record<string, unknown>;
        selection.categories = categories;
        doc.selection = selection;
        changed = true;
      }
    }

    if (!changed) return;

    if (typeof doc.revision === "number" && Number.isFinite(doc.revision)) {
      doc.revision = doc.revision + 1;
    }
    doc.updatedAt = now.toISOString();

    // Prefer canonical v2 form when the rest of the document is already valid;
    // otherwise keep the stripped raw document so a later v1 migration can run.
    const parsed = RoutingPolicySchema.safeParse(doc);
    const after = parsed.success
      ? canonicalRoutingPolicyJson(parsed.data)
      : JSON.stringify(doc);
    const revision = parsed.success
      ? parsed.data.revision
      : typeof doc.revision === "number" ? doc.revision : 0;
    const updatedAt = parsed.success
      ? parsed.data.updatedAt
      : typeof doc.updatedAt === "string" ? doc.updatedAt : now.toISOString();

    this.db.database.transaction(() => {
      this.db.database.run(
        "UPDATE routing_policy SET revision = ?, updatedAt = ?, document = ? WHERE id = 1",
        [revision, updatedAt, after],
      );
      this.db.database.run(
        `INSERT INTO routing_policy_events
           (at, actor, operation, revision, before, after)
         VALUES (?, 'hive', 'migrate-strip-profiling-category', ?, ?, ?)`,
        [now.toISOString(), revision, row.document, after],
      );
    }).immediate();
  }

  /**
   * Version 1 represented preference as spread/strict and let missing model
   * rows inherit provider enablement. The migration writes the three-state
   * answer explicitly: every existing exact chain is CHOICE, every category
   * without one is NEVER_CONFIGURED, and only exact targets from a
   * non-provisional user policy become model consent. Nothing becomes AUTO.
   */
  private migrateStoredV1(now: Date = new Date()): void {
    const row = this.db.database.query(
      "SELECT document FROM routing_policy WHERE id = 1",
    ).get() as { document: string } | null;
    if (row === null) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.document);
    } catch {
      return;
    }
    const header = z.object({ schemaVersion: z.literal(1) }).passthrough()
      .safeParse(decoded);
    if (!header.success) return;
    const legacy = z.object({
      schemaVersion: z.literal(1),
      revision: z.number().int().nonnegative(),
      updatedAt: z.string(),
      provisional: z.boolean(),
      providers: z.record(z.string(), z.unknown()),
      models: z.array(z.unknown()),
      chains: z.record(z.string(), z.array(z.unknown())),
    }).passthrough().safeParse(decoded);
    if (!legacy.success) return;

    const categories: Record<string, "choice"> = {};
    for (const [category, entries] of Object.entries(legacy.data.chains)) {
      if (entries.length > 0) categories[category] = "choice";
    }
    const models: Record<string, unknown>[] = legacy.data.models.map((model) => ({
      ...(model as object),
      effort: (model as { effort?: unknown }).effort ?? { mode: "never-configured" },
    }));
    if (!legacy.data.provisional) {
      for (const entries of Object.values(legacy.data.chains)) {
        for (const entry of entries) {
          const target = z.object({
            provider: z.string(),
            model: z.string(),
          }).passthrough().safeParse(entry);
          if (!target.success) continue;
          const index = models.findIndex((model) => {
            const parsed = z.object({ provider: z.string(), model: z.string() })
              .passthrough().safeParse(model);
            return parsed.success &&
              parsed.data.provider === target.data.provider &&
              parsed.data.model === target.data.model;
          });
          if (index >= 0) {
            models[index] = { ...(models[index] as object), state: "enabled" };
          } else {
            models.push({
              ...target.data,
              state: "enabled",
              effort: { mode: "never-configured" },
            });
          }
        }
      }
    }
    const next = RoutingPolicySchema.safeParse({
      ...legacy.data,
      schemaVersion: 2,
      revision: legacy.data.revision + 1,
      updatedAt: now.toISOString(),
      models,
      selection: { global: "never-configured", categories },
    });
    if (!next.success) return;
    const after = canonicalRoutingPolicyJson(next.data);
    this.db.database.transaction(() => {
      this.db.database.run(
        "UPDATE routing_policy SET revision = ?, updatedAt = ?, document = ? WHERE id = 1",
        [next.data.revision, next.data.updatedAt, after],
      );
      this.db.database.run(
        `INSERT INTO routing_policy_events
           (at, actor, operation, revision, before, after)
         VALUES (?, 'hive', 'migrate-v1-explicit-intent', ?, ?, ?)`,
        [now.toISOString(), next.data.revision, row.document, after],
      );
    }).immediate();
  }

  /** The whole policy. No row → the empty revision-0 document (nothing
   * configured). An unparseable row → RoutingPolicyCorruptError, never a
   * quiet empty. */
  read(now: Date = new Date()): RoutingPolicy {
    return readRoutingPolicyDatabase(this.db, now);
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
   * First-boot seeding: when NO policy row exists, write provisional route
   * suggestions without granting launch consent. Every chain entry names an
   * EXACT model id (user ruling 2026-07-13: "we are specific on the models
   * that we choose"): `vendorDefaults` carries each vendor's then-current
   * default AS READ FROM ITS LIVE CATALOG by the caller — frozen here as a
   * specific id, never re-resolved, never a training-memory guess. A vendor
   * whose catalog could not be read is simply absent from seeded chains
   * (skipped, not invented). Efforts seed provider-controlled — never
   * invented either.
   *
   * ENABLEMENT IS CONSENT, so the seed writes no provider or model enablement
   * at all. It may suggest exact chain order, but only the user's own click can
   * make a provider launchable. A store that already has a policy — even
   * revision 1 from an earlier boot — is left exactly alone.
   */
  seedProvisionalBaseline(
    facts: {
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
        chains: provisionalBaselineChains(facts.vendorDefaults),
      });
      this.write(policy, null, "seed-provisional-baseline", "hive", now);
      return { seeded: true, policy };
    })();
  }

  /**
   * A named instance gets a COPY of the default instance's user-authored
   * Model Control settings on first boot. Runtime state remains isolated and
   * later edits diverge normally. A local human edit always wins; only an
   * empty store or Hive's untouched provisional suggestions may be replaced.
   * Provisional source policy carries no consent and is never imported.
   */
  importDefaultPolicy(
    source: RoutingPolicy,
    now: Date = new Date(),
  ): { imported: boolean; policy: RoutingPolicy } {
    return this.db.database.transaction(() => {
      const current = this.isEmpty() ? null : this.read(now);
      if (
        source.revision === 0 || source.provisional ||
        (current !== null && !current.provisional)
      ) {
        return {
          imported: false,
          policy: current ?? this.read(now),
        };
      }
      const next = RoutingPolicySchema.parse({
        ...source,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: now.toISOString(),
        provisional: false,
      });
      this.write(next, current, "import-default-policy", "hive", now);
      return { imported: true, policy: next };
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

/** Read without constructing a store, so a named daemon can inspect the live
 * default database through a genuinely read-only connection. */
export function readRoutingPolicyDatabase(
  db: HiveDatabase,
  now: Date = new Date(),
): RoutingPolicy {
  const table = db.database.query(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'routing_policy'
  `).get();
  if (table === null) return emptyRoutingPolicy(now.toISOString());
  const row = db.database.query(
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

/** Pure mutation semantics, shared by the store and its tests. "unset"
 * returns to explicit never-configured intent, never to an invented AUTO.
 * Model consent and effort remain independent fields. */
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
      if (mutation.state === "unset") return existing === undefined
        ? { ...policy, models: rest }
        : { ...policy, models: [...rest, { ...existing, state: undefined }] };
      return {
        ...policy,
        models: [...rest, {
          provider: mutation.provider,
          model: mutation.model,
          state: mutation.state,
          effort: existing?.effort ?? { mode: "never-configured" },
        }],
      };
    }
    case "set-effort": {
      const rest = withoutModelRow(policy, mutation.provider, mutation.model);
      const existing = modelRow(policy, mutation.provider, mutation.model);
      if (mutation.effort === "unset") {
        if (existing === undefined) return { ...policy, models: rest };
        return { ...policy, models: [...rest, {
          ...existing,
          effort: { mode: "never-configured" },
        }] };
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
      if (mutation.entries.length === 0) return { ...policy, chains };
      // Accepting an exact chain is also exact model consent. It never enables
      // the provider master switch, and clearing/reordering a chain never
      // revokes a model that another category or explicit model row may use.
      let models = [...policy.models];
      for (const entry of mutation.entries) {
        const existing = models.find((row) =>
          row.provider === entry.provider && row.model === entry.model
        );
        models = models.filter((row) =>
          !(row.provider === entry.provider && row.model === entry.model)
        );
        models.push({
          provider: entry.provider,
          model: entry.model,
          state: "enabled",
          effort: existing?.effort ?? entry.effort,
        });
      }
      return {
        ...policy,
        chains,
        models,
        selection: {
          ...policy.selection,
          categories: {
            ...policy.selection.categories,
            [mutation.category]: "choice",
          },
        },
      };
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
  assign("standard_coding", codexLed);
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
    effort: row.effort,
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
 * explicitly disabled; null = unreadable/missing; a structured refusal names
 * a known policy reason. The gate refuses anything that is not exactly true,
 * so absence stays fail-closed on both sides. A corrupt store THROWS out of
 * here deliberately: the gate turns that into its "policy unreadable" refusal
 * instead of this adapter guessing.
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
): (
  provider: CapabilityProvider,
  model: string,
) => Promise<ModelEnablementDecision> {
  return async (provider, model) => {
    const { state } = modelPolicyState(store.read(), provider, model);
    if (state === "enabled") return true;
    if (state === "disabled") return false;
    return {
      refusal: `${model} cannot launch because exact model consent is not enabled ` +
        `under provider ${provider}; enable both in the Model Control Center`,
    };
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
