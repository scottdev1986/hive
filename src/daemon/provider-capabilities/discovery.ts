import { z } from "zod";
import {
  type CapabilityRecord,
  capabilityKey,
  type Discovered,
  type EffectiveDefault,
  fingerprintAccount,
  known,
  splitVariant,
  unknown,
} from "../../schemas/capability";

/** The `models[]` menu, as claude 2.1.207 sends it. Every capability field is optional because the CLI genuinely omits them: the Haiku entry carries neither `supportsEffort` nor `supportedEffortLevels`. Loose object parsing keeps fields a future CLI adds rather than dropping them at the boundary. */
const ClaudeModelEntrySchema = z
  .object({
    value: z.string().nullable().optional(),
    resolvedModel: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    supportsEffort: z.boolean().nullable().optional(),
    supportedEffortLevels: z.array(z.string()).nullable().optional(),
  })
  .loose();

/** The account block. Email and organization are read to fingerprint the account and are never stored, logged, or returned. */
const ClaudeAccountSchema = z
  .object({
    email: z.string().nullable().optional(),
    organization: z.string().nullable().optional(),
  })
  .loose();

const ClaudeInitializeSchema = z
  .object({
    models: z.array(ClaudeModelEntrySchema).nullable().optional(),
    account: ClaudeAccountSchema.nullable().optional(),
  })
  .loose();

const CLAUDE = "claude.initialize" as const;

/** One `initialize` response → capability records. Several menu entries can name one model: 2.1.207 offers both `default` and `opus[1m]`, and both resolve to `claude-opus-4-8[1m]`. They are one model with one meter, so they collapse into one record whose `aliases` list every name it answers to. The record is keyed by the canonical id and variant, so the two entries land in the same group by construction. The launch token is the canonical id rather than any menu alias. An alias like `default` is not a model identity — it is a pointer to whatever the CLI currently prefers, and pinning a spawn to it would let the model change under a recorded launch. The canonical id is what the vendor itself said the alias resolves to, and it is the most specific name available. */
export function recordsFromClaudeInitialize(
  response: unknown,
  cliVersion: string,
  observedAt: string,
): CapabilityRecord[] {
  const parsed = ClaudeInitializeSchema.safeParse(response);
  if (!parsed.success) return [];
  const models = parsed.data.models ?? [];
  const accountFingerprint = fingerprintAccount("claude", [
    parsed.data.account?.email,
    parsed.data.account?.organization,
  ]);

  const grouped = new Map<string, CapabilityRecord>();
  for (const entry of models) {
    const resolved = entry.resolvedModel;
    if (resolved === null || resolved === undefined || resolved.length === 0) {
      continue;
    }
    const fromResolved = splitVariant(resolved);
    const fromValue = splitVariant(entry.value ?? "");
    const canonicalId = fromResolved.base;
    if (canonicalId.length === 0) continue;
    const variant = fromResolved.variant ?? fromValue.variant;

    const record: CapabilityRecord = {
      provider: "claude",
      accountFingerprint,
      cliVersion,
      canonicalId,
      variant,
      // Never the variant: `--model` rejects the bracketed form.
      launchToken: canonicalId,
      displayName: entry.displayName ?? null,
      aliases:
        entry.value === null || entry.value === undefined ? [] : [entry.value],
      entitled: known(true, CLAUDE, observedAt),
      hidden: unknown("surface-silent", CLAUDE, observedAt),
      supportsEffort:
        entry.supportsEffort === null || entry.supportsEffort === undefined
          ? unknown("field-absent", CLAUDE, observedAt)
          : known(entry.supportsEffort, CLAUDE, observedAt),
      supportedEffortLevels:
        entry.supportedEffortLevels === null ||
        entry.supportedEffortLevels === undefined
          ? unknown("field-absent", CLAUDE, observedAt)
          : known([...entry.supportedEffortLevels], CLAUDE, observedAt),
      defaultEffort: unknown("surface-silent", CLAUDE, observedAt),
      observedAt,
    };

    const key = capabilityKey(record);
    const existing = grouped.get(key);
    grouped.set(key, existing === undefined ? record : merge(existing, record));
  }
  return [...grouped.values()];
}

function merge(
  base: CapabilityRecord,
  next: CapabilityRecord,
): CapabilityRecord {
  const prefer = <T>(a: Discovered<T>, b: Discovered<T>): Discovered<T> =>
    a.state === "known" ? a : b;
  return {
    ...base,
    displayName: base.displayName ?? next.displayName,
    aliases: [...new Set([...base.aliases, ...next.aliases])],
    entitled: prefer(base.entitled, next.entitled),
    hidden: prefer(base.hidden, next.hidden),
    supportsEffort: prefer(base.supportsEffort, next.supportsEffort),
    supportedEffortLevels: prefer(
      base.supportedEffortLevels,
      next.supportedEffortLevels,
    ),
    defaultEffort: prefer(base.defaultEffort, next.defaultEffort),
  };
}

/** What a no-flag Claude launch runs, read off the same menu. Claude's `default` menu entry names its own resolved model, so this is a discovered fact and not a Hive belief. Its effort is not: Claude publishes no per-model effort recommendation anywhere, so discovery cannot name the effective effort before launch. The running session later reports it through `statusLine`; it stays `unknown` here rather than acquiring a plausible `medium` before that observation exists. */
export function claudeEffectiveDefault(
  records: readonly CapabilityRecord[],
  observedAt: string,
): EffectiveDefault {
  const entry = records.find((record) => record.aliases.includes("default"));
  return {
    provider: "claude",
    model:
      entry === undefined
        ? // The menu answered and carried no `default` entry. That is this menu
          unknown("field-absent", CLAUDE, observedAt)
        : known(entry.canonicalId, CLAUDE, observedAt),
    effort: unknown("surface-silent", CLAUDE, observedAt),
  };
}

const CODEX_CONFIG = "codex.config/read" as const;

const CodexConfigSchema = z
  .object({
    config: z
      .object({
        model: z.string().nullable().optional(),
        model_reasoning_effort: z.string().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

export function codexEffectiveDefault(
  config: unknown,
  observedAt: string,
): EffectiveDefault {
  const parsed = CodexConfigSchema.safeParse(config);
  if (!parsed.success) {
    return {
      provider: "codex",
      model: unknown("malformed", CODEX_CONFIG, observedAt),
      effort: unknown("malformed", CODEX_CONFIG, observedAt),
    };
  }
  const effective = parsed.data.config;
  const field = <T extends string>(
    value: T | null | undefined,
  ): Discovered<T> =>
    value === null || value === undefined || value.length === 0
      ? unknown("field-absent", CODEX_CONFIG, observedAt)
      : known(value, CODEX_CONFIG, observedAt);
  return {
    provider: "codex",
    model: field(effective?.model),
    effort: field(effective?.model_reasoning_effort),
  };
}

/** `model/list`, as codex-cli 0.144.1 answers it. Note `supportedReasoningEfforts` is a list of *objects*, not of strings: each carries the level and the vendor's own description of it. Only the level is a routing fact. */
const CodexModelEntrySchema = z
  .object({
    id: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    hidden: z.boolean().nullable().optional(),
    defaultReasoningEffort: z.string().nullable().optional(),
    supportedReasoningEfforts: z
      .array(
        z.object({ reasoningEffort: z.string().nullable().optional() }).loose(),
      )
      .nullable()
      .optional(),
  })
  .loose();

const CodexModelListSchema = z
  .object({
    data: z.array(CodexModelEntrySchema),
  })
  .loose();

const CodexAccountSchema = z
  .object({
    account: z
      .object({
        email: z.string().nullable().optional(),
        planType: z.string().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

const CODEX = "codex.model/list" as const;

/** One `model/list` reply → capability records. Codex has no aliases and no context-window variants: an id is the whole name. The hidden flag is preserved rather than filtered here — a record describes what the vendor said, and excluding hidden models from *automatic selection* is a routing decision that belongs to the layer that routes. Dropping them at ingestion would also make an explicit pin of a hidden model unresolvable. */
export function recordsFromCodexModelList(
  result: unknown,
  account: unknown,
  cliVersion: string,
  observedAt: string,
): CapabilityRecord[] {
  const parsed = CodexModelListSchema.safeParse(result);
  if (!parsed.success) return [];
  const parsedAccount = CodexAccountSchema.safeParse(account);
  const accountFingerprint = fingerprintAccount("codex", [
    parsedAccount.success ? parsedAccount.data.account?.email : null,
  ]);

  const records: CapabilityRecord[] = [];
  for (const entry of parsed.data.data) {
    const canonicalId = entry.id ?? entry.model;
    if (
      canonicalId === null ||
      canonicalId === undefined ||
      canonicalId.length === 0
    ) {
      continue;
    }
    records.push({
      provider: "codex",
      accountFingerprint,
      cliVersion,
      canonicalId,
      variant: null,
      launchToken: canonicalId,
      displayName: entry.displayName ?? null,
      aliases: [],
      entitled: known(true, CODEX, observedAt),
      hidden:
        entry.hidden === null || entry.hidden === undefined
          ? unknown("field-absent", CODEX, observedAt)
          : known(entry.hidden, CODEX, observedAt),
      // Codex sends no `supportsEffort` boolean for any model. Inferring one from a non-empty effort list is exactly the merge the design forbids: it would fabricate a vendor claim that was never made.
      supportsEffort: unknown("surface-silent", CODEX, observedAt),
      supportedEffortLevels: effortLevels(
        entry.supportedReasoningEfforts,
        observedAt,
      ),
      defaultEffort:
        entry.defaultReasoningEffort === null ||
        entry.defaultReasoningEffort === undefined
          ? unknown("field-absent", CODEX, observedAt)
          : known(entry.defaultReasoningEffort, CODEX, observedAt),
      observedAt,
    });
  }
  return records;
}

function effortLevels(
  efforts: readonly { reasoningEffort?: string | null }[] | null | undefined,
  observedAt: string,
): Discovered<string[]> {
  if (efforts === null || efforts === undefined) {
    return unknown("field-absent", CODEX, observedAt);
  }
  const levels = efforts
    .map((effort) => effort.reasoningEffort)
    .filter(
      (level): level is string => typeof level === "string" && level.length > 0,
    );
  if (levels.length === 0 && efforts.length > 0) {
    return unknown("malformed", CODEX, observedAt);
  }
  return known(levels, CODEX, observedAt);
}
