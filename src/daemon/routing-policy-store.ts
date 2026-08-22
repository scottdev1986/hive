import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DatabaseHost } from "../shared/database-host";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
} from "../schemas/provider";
import {
  type CandidateEffort,
  emptyRoutingPolicy,
  type ModelEnablementDecision,
  modelPolicyState,
  ROUTING_CATEGORIES,
  type RoutePolicy,
  type RoutingCategory,
  RoutingCategorySchema,
  type RoutingPolicy,
  type RoutingPolicyMutation,
  RoutingPolicyMutationSchema,
  RoutingPolicySchema,
} from "../schemas/routing-policy";
import { definedFields } from "../shared/defined-fields";
import { errorMessage } from "../shared/error-message";

type RoutingPolicyDatabase = Pick<DatabaseHost, "database">;

/** The policy store: one revisioned document in the MACHINE DEFAULT home's hive.db, shared by every instance on the machine rather than copied into each one — a per-run home is a cache that gets rebuilt, and the user's standing authorization must outlive it. `machineModelControlDatabase` resolves that home. SQLite provides compare-and-set policy writes need compare-and-set plus an audit trail, and Hive already runs this database; the document is stored whole — one row, canonical JSON — because every reader and writer handles the whole policy, and a whole-document schema parse on every read is what makes corruption LOUD instead of permissive. THIS IS THE CONSENT RECORD, not a preferences blob: with the approval model enablement is the user's standing authorization to spend on it. Every write path below is a safety surface. FAIL-CLOSED: a store with no policy row reads as the empty revision-0 document — nothing configured, and not-configured never means allowed. A row that exists but does not parse THROWS; it never degrades to the empty document, because "I could not read your policy" and "you have no policy" are different facts and only one of them may be answered with defaults without granting permission. */

/** A write raced another writer: the caller's revision is stale. The current revision rides along so the client can reload and re-apply. */
export class RoutingPolicyConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`revision conflict: policy is at revision ${currentRevision}`);
    this.name = "RoutingPolicyConflictError";
  }
}

/** The stored policy exists but cannot be trusted. Deliberately NOT recovered from: an unreadable policy must stop policy-dependent work, not silently become an empty (permissive-looking) one. */
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
  constructor(private readonly db: RoutingPolicyDatabase) {
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
    this.migrateStoredV2();
  }

  /** One-shot V2 → V3: ordered chains become unordered hive-equal routes over the same exact candidates (weight 1 each), and the `default` chain becomes the global route. Rank order is dropped rather than converted — Hive must not invent how much more "first" meant than "second"; the user assigns real weights through set-route whenever they want user-weighted mode. Enablement copies through untouched: no new consent is created. Anything that is not a V2 document is left alone for the corrupt-row path. */
  private migrateStoredV2(now: Date = new Date()): void {
    // SAFETY: The surrounding code already established this contract.
    const row = this.db.database
      .query("SELECT document FROM routing_policy WHERE id = 1")
      .get() as { document: string } | null;
    if (row === null) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.document);
    } catch {
      return;
    }
    const legacy = z
      .object({
        schemaVersion: z.literal(2),
        revision: z.number().int().nonnegative(),
        provisional: z.boolean(),
        providers: z.record(z.string(), z.json()),
        models: z.array(z.unknown()),
        chains: z.record(
          z.string(),
          z.array(
            z
              .object({
                provider: z.string(),
                model: z.string(),
                effort: z.object({ mode: z.string() }).loose(),
              })
              .loose(),
          ),
        ),
      })
      .loose()
      .safeParse(decoded);
    if (!legacy.success) return;

    const routeOf = (
      entries: (typeof legacy.data.chains)[string],
    ): RoutePolicy | null => {
      const candidates = entries.map((entry) => ({
        // SAFETY: The surrounding code already established this contract.
        provider: entry.provider as CapabilityProvider,
        model: entry.model,
        // never-configured effort is a model-row state, not a launchable intent; the vendor's own choice is the only non-invented answer.
        // SAFETY: The surrounding code already established this contract.
        effort: (entry.effort.mode === "never-configured"
          ? { mode: "provider-controlled" }
          : entry.effort) as CandidateEffort,
        weight: 1,
      }));
      return candidates.length === 0
        ? null
        : { mode: "hive-equal", candidates };
    };

    let global: RoutePolicy | null = null;
    const categories: Record<string, RoutePolicy> = {};
    for (const [key, entries] of Object.entries(legacy.data.chains)) {
      const route = routeOf(entries);
      if (route === null) continue;
      if (key === "default") global = route;
      else if (RoutingCategorySchema.safeParse(key).success) {
        categories[key] = route;
      }
    }

    const next = RoutingPolicySchema.safeParse({
      schemaVersion: 3,
      revision: legacy.data.revision + 1,
      updatedAt: now.toISOString(),
      provisional: legacy.data.provisional,
      providers: legacy.data.providers,
      models: legacy.data.models,
      global,
      categories,
    });
    if (!next.success) return;
    const after = canonicalRoutingPolicyJson(next.data);
    this.db.database
      .transaction(() => {
        this.db.database.run(
          "UPDATE routing_policy SET revision = ?, updatedAt = ?, document = ? WHERE id = 1",
          [next.data.revision, next.data.updatedAt, after],
        );
        this.db.database.run(
          `INSERT INTO routing_policy_events
           (at, actor, operation, revision, before, after)
         VALUES (?, 'hive', 'migrate-v2-weighted-routes', ?, ?, ?)`,
          [now.toISOString(), next.data.revision, row.document, after],
        );
      })
      .immediate();
  }

  /** The whole policy. No row → the empty revision-0 document (nothing configured). An unparseable row → RoutingPolicyCorruptError, never a quiet empty. */
  read(now: Date = new Date()): RoutingPolicy {
    return readRoutingPolicyDatabase(this.db, now);
  }

  /** Apply one validated mutation with compare-and-set. The transaction is IMMEDIATE, which matters now that instances share one machine database: it takes the write lock before the re-read, so two processes are ordered and the second sees the first's revision. Deferred, both could read the same revision and the loser would surface a raw SQLITE_BUSY_SNAPSHOT from the driver instead of a conflict anyone can act on. The re-read then makes a concurrent write lose loudly — RoutingPolicyConflictError names the revision to reload — instead of clobbering. Every accepted write appends a routing_policy_events row and clears `provisional`: the document stops being Hive's suggestion the moment a user edits it. */
  apply(
    mutation: RoutingPolicyMutation,
    actor: string,
    now: Date = new Date(),
  ): RoutingPolicy {
    const validated = RoutingPolicyMutationSchema.parse(mutation);
    return this.db.database
      .transaction(() => {
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
      })
      .immediate();
  }

  /** Copy a complete policy from another instance while preserving this database's own revision history. The caller reads the target revision before invoking this method; a change in between is a conflict, never a clobber. Instances now share the machine policy, so this remains only for an explicit user promotion out of a home that has its own document. */
  promote(
    source: RoutingPolicy,
    expectedRevision: number,
    actor: string,
    now: Date = new Date(),
  ): RoutingPolicy {
    const validated = RoutingPolicySchema.parse(source);
    if (validated.revision === 0) {
      throw new Error(
        "Refusing to promote Model Control: the source has no user-authored policy yet (revision 0).",
      );
    }
    if (validated.provisional) {
      throw new Error(
        "Refusing to promote Model Control: the source still has Hive's provisional baseline; edit Model Control before promoting.",
      );
    }
    return this.db.database
      .transaction(() => {
        const current = this.read(now);
        if (expectedRevision !== current.revision) {
          throw new RoutingPolicyConflictError(current.revision);
        }
        const next = RoutingPolicySchema.parse({
          ...validated,
          revision: current.revision + 1,
          updatedAt: now.toISOString(),
        });
        this.write(next, current, "promote-instance-model-control", actor, now);
        return next;
      })
      .immediate();
  }

  isEmpty(): boolean {
    return (
      this.db.database
        .query("SELECT id FROM routing_policy WHERE id = 1")
        .get() === null
    );
  }

  /** First-boot seeding: when NO policy row exists, write one provisional GLOBAL route — hive-equal over each vendor's current default model AS READ FROM ITS LIVE CATALOG by the caller — frozen here as a specific id, never re-resolved, never a training-memory guess. A vendor whose catalog could not be read is simply absent (skipped, not invented). Efforts seed provider-controlled — never invented either. No per-category routes are seeded: equal-weight sets are identical per category, and a category without a route resolves to global. ENABLEMENT IS CONSENT, so the seed writes no provider or model enablement at all. It may suggest a candidate set, but only the user's own click can make a provider launchable. A store that already has a policy — even revision 1 from an earlier boot — is left exactly alone. */
  seedProvisionalBaseline(
    facts: {
      vendorDefaults: Partial<Record<CapabilityProvider, string>>;
    },
    now: Date = new Date(),
  ): { seeded: boolean; policy: RoutingPolicy } {
    return this.db.database
      .transaction(() => {
        if (!this.isEmpty()) return { seeded: false, policy: this.read(now) };
        const policy = RoutingPolicySchema.parse({
          ...emptyRoutingPolicy(now.toISOString()),
          revision: 1,
          provisional: true,
          global: provisionalBaselineRoute(facts.vendorDefaults),
        });
        this.write(policy, null, "seed-provisional-baseline", "hive", now);
        return { seeded: true, policy };
      })
      .immediate();
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

export function readRoutingPolicyDatabase(
  db: RoutingPolicyDatabase,
  now: Date = new Date(),
): RoutingPolicy {
  const table = db.database
    .query(
      `
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'routing_policy'
  `,
    )
    .get();
  if (table === null) return emptyRoutingPolicy(now.toISOString());
  // SAFETY: The surrounding code already established this contract.
  const row = db.database
    .query("SELECT document FROM routing_policy WHERE id = 1")
    .get() as { document: string } | null;
  if (row === null) return emptyRoutingPolicy(now.toISOString());
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.document);
  } catch (error) {
    throw new RoutingPolicyCorruptError(errorMessage(error));
  }
  const parsed = RoutingPolicySchema.safeParse(decoded);
  if (!parsed.success) {
    throw new RoutingPolicyCorruptError(parsed.error.message);
  }
  return parsed.data;
}

/** Pure mutation semantics, shared by the store and its tests. "unset" returns to explicit never-configured intent, never to an invented AUTO. Model consent and effort remain independent fields. */
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
      if (mutation.state === "unset")
        return existing === undefined
          ? { ...policy, models: rest }
          : { ...policy, models: [...rest, { ...existing, state: undefined }] };
      return {
        ...policy,
        models: [
          ...rest,
          {
            provider: mutation.provider,
            model: mutation.model,
            state: mutation.state,
            effort: existing?.effort ?? { mode: "never-configured" },
          },
        ],
      };
    }
    case "set-effort": {
      const rest = withoutModelRow(policy, mutation.provider, mutation.model);
      const existing = modelRow(policy, mutation.provider, mutation.model);
      if (mutation.effort === "unset") {
        if (existing === undefined) return { ...policy, models: rest };
        return {
          ...policy,
          models: [
            ...rest,
            {
              ...existing,
              effort: { mode: "never-configured" },
            },
          ],
        };
      }
      return {
        ...policy,
        models: [
          ...rest,
          {
            provider: mutation.provider,
            model: mutation.model,
            ...definedFields({ state: existing?.state }),
            effort: mutation.effort,
          },
        ],
      };
    }
    case "set-route": {
      const next =
        mutation.scope === "global"
          ? { ...policy, global: mutation.route }
          : {
              ...policy,
              categories: withRoute(
                policy.categories,
                mutation.scope,
                mutation.route,
              ),
            };
      if (mutation.route === null) return next;
      let models = [...policy.models];
      for (const candidate of mutation.route.candidates) {
        const existing = models.find(
          (row) =>
            row.provider === candidate.provider &&
            row.model === candidate.model,
        );
        models = models.filter(
          (row) =>
            !(
              row.provider === candidate.provider &&
              row.model === candidate.model
            ),
        );
        models.push({
          provider: candidate.provider,
          model: candidate.model,
          state: "enabled",
          effort: existing?.effort ?? candidate.effort,
        });
      }
      return { ...next, models };
    }
  }
}

const withRoute = (
  categories: RoutingPolicy["categories"],
  scope: RoutingCategory,
  route: RoutePolicy | null,
): RoutingPolicy["categories"] => {
  const next = { ...categories };
  if (route === null) delete next[scope];
  else next[scope] = route;
  return next;
};

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
  policy.models.filter(
    (row) => !(row.provider === provider && row.model === model),
  );

function provisionalBaselineRoute(
  vendorDefaults: Partial<Record<CapabilityProvider, string>>,
): RoutePolicy | null {
  const candidates = CAPABILITY_PROVIDERS.flatMap((provider) => {
    const model = vendorDefaults[provider];
    return model === undefined
      ? []
      : [
          {
            provider,
            model,
            effort: { mode: "provider-controlled" as const },
            weight: 1,
          },
        ];
  });
  return candidates.length === 0 ? null : { mode: "hive-equal", candidates };
}

/** Deterministic serialization keeps policy exports inspectable. Key order is fixed (providers in union order, models sorted, categories in category order; candidates sorted by target), so identical policy is byte-identical output and two exports diff cleanly. */
export function canonicalRoutingPolicyJson(policy: RoutingPolicy): string {
  const providers: Record<string, string> = {};
  for (const provider of CAPABILITY_PROVIDERS) {
    const state = policy.providers[provider];
    if (state !== undefined) providers[provider] = state;
  }
  const models = [...policy.models]
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
    )
    .map((row) => ({
      provider: row.provider,
      model: row.model,
      ...definedFields({ state: row.state }),
      effort: row.effort,
    }));
  const canonicalRoute = (route: RoutePolicy): RoutePolicy => ({
    mode: route.mode,
    candidates: [...route.candidates].sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
    ),
  });
  const categories: Record<string, RoutePolicy> = {};
  for (const category of ROUTING_CATEGORIES) {
    const route = policy.categories[category];
    if (route !== undefined) categories[category] = canonicalRoute(route);
  }
  return `${JSON.stringify(
    {
      schemaVersion: policy.schemaVersion,
      revision: policy.revision,
      updatedAt: policy.updatedAt,
      provisional: policy.provisional,
      providers,
      models,
      global: policy.global === null ? null : canonicalRoute(policy.global),
      categories,
    },
    null,
    2,
  )}\n`;
}

/** The spawner's enablement dependency (`HiveSpawnerDependencies. isModelEnabled`), answered from the policy store — THE JOIN between the consent record and the AuthorizedLaunch gate. The contract, verbatim from the dependency's declaration: true = enabled (the user's consent); false = explicitly disabled; null = unreadable/missing; a structured refusal names a known policy reason. The gate refuses anything that is not exactly true, so absence stays fail-closed on both sides. A corrupt store THROWS out of here deliberately: the gate turns that into its "policy unreadable" refusal instead of this adapter guessing. Identity: policy rows are keyed by canonical id, which every vendor's discovery currently sets identical to the launch token the gate passes in (provider-capabilities/discovery.ts). An alias-shaped explicit request therefore reads unconfigured — refused with the Control Center remedy, never silently enabled; alias-aware matching belongs to the wiring PR that hands the gate canonical identities. */
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
      refusal:
        `${model} cannot launch because provider ${provider} is not enabled ` +
        "in the Model Control Center",
    };
  };
}

export function retireLegacyRoutingToml(hiveHome: string): string | null {
  const source = join(hiveHome, "routing.toml");
  if (!existsSync(source)) return null;
  let target = join(hiveHome, "routing.toml.legacy");
  if (existsSync(target)) {
    // Preserve any existing target rather than overwriting user data.
    let suffix = 2;
    while (existsSync(`${target}.${suffix}`)) suffix += 1;
    target = `${target}.${suffix}`;
  }
  renameSync(source, target);
  return target;
}
