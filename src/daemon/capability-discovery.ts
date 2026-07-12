import { tmpdir } from "node:os";
import { z } from "zod";
import {
  type CapabilityProvider,
  type CapabilityRecord,
  type Discovered,
  type EffectiveDefault,
  capabilityKey,
  fingerprintAccount,
  known,
  splitVariant,
  unknown,
} from "../schemas/capability";
import { pendingControlResponses, pendingResponses } from "./quota-sources";
import { HIVE_VERSION } from "../version";

/**
 * Runtime capability discovery.
 *
 * Both vendors publish, for free, what the signed-in account may launch and
 * which effort values each model accepts. Hive reads those catalogs here and
 * turns them into capability records. Nothing in this file spends a prompt:
 *
 * - **Claude** answers a stream-json `initialize` control request with a
 *   `models[]` menu. No user message is ever written to stdin, so the CLI starts
 *   no turn and samples no model. This is the same frame quota discovery already
 *   awaits.
 * - **Codex** answers `model/list` after the mandatory `initialize` +
 *   `initialized` handshake. No `thread/start` and no `turn/start`, so nothing
 *   bills.
 *
 * Verified by driving the binaries on 2026-07-11: claude 2.1.207 and
 * codex-cli 0.144.1.
 *
 * The two surfaces are not symmetric, and this file refuses to pretend they are.
 * Claude reports `supportsEffort` and an effort list but no per-model default
 * effort and no hidden flag. Codex reports a default effort and a hidden flag
 * but no `supportsEffort` boolean. Every gap is recorded as `unknown` with the
 * reason it is unknown — never as `false`, and never as a shipped default.
 */

const DISCOVERY_TIMEOUT_MS = 10_000;

export type CapabilityDiscoveryResult =
  | {
    status: "ok";
    records: CapabilityRecord[];
    /** What an unflagged launch on this account runs: the ladder's second rung. */
    effectiveDefault: EffectiveDefault;
  }
  | { status: "unavailable"; reason: string };

// --------------------------------------------------------------------------
// Claude: the `initialize` control response.
// --------------------------------------------------------------------------

/**
 * The `models[]` menu, as claude 2.1.207 sends it. Every capability field is
 * optional because the CLI genuinely omits them: the Haiku entry carries neither
 * `supportsEffort` nor `supportedEffortLevels`. `passthrough` keeps fields a
 * future CLI adds rather than dropping them at the boundary.
 */
const ClaudeModelEntrySchema = z.object({
  value: z.string().nullable().optional(),
  resolvedModel: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  supportsEffort: z.boolean().nullable().optional(),
  supportedEffortLevels: z.array(z.string()).nullable().optional(),
}).passthrough();

/**
 * The account block. Email and organization are read to fingerprint the account
 * and are never stored, logged, or returned.
 */
const ClaudeAccountSchema = z.object({
  email: z.string().nullable().optional(),
  organization: z.string().nullable().optional(),
}).passthrough();

const ClaudeInitializeSchema = z.object({
  models: z.array(ClaudeModelEntrySchema).nullable().optional(),
  account: ClaudeAccountSchema.nullable().optional(),
}).passthrough();

const CLAUDE = "claude.initialize" as const;

/**
 * One `initialize` response → capability records.
 *
 * Several menu entries can name one model: 2.1.207 offers both `default` and
 * `opus[1m]`, and both resolve to `claude-opus-4-8[1m]`. They are one model with
 * one meter, so they collapse into one record whose `aliases` list every name it
 * answers to. The record is keyed by the canonical id and variant, so the two
 * entries land in the same group by construction.
 *
 * The launch token is the canonical id rather than any menu alias. An alias like
 * `default` is not a model identity — it is a pointer to whatever the CLI
 * currently prefers, and pinning a spawn to it would let the model change under
 * a recorded launch. The canonical id is what the vendor itself said the alias
 * resolves to, and it is the most specific name available.
 */
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
    // The variant can ride on either name: `opus[1m]` resolves to
    // `claude-opus-4-8[1m]`, but `claude-fable-5[1m]` resolves to a bare
    // `claude-fable-5`. Take it from whichever name carries it.
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
      aliases: entry.value === null || entry.value === undefined
        ? []
        : [entry.value],
      // Presence in an account-scoped menu is the only entitlement evidence
      // Claude offers. It is positive evidence, so it is recorded as such.
      entitled: known(true, CLAUDE, observedAt),
      // Claude's protocol has no hidden flag for any model, so its absence here
      // says nothing about this one.
      hidden: unknown("surface-silent", CLAUDE, observedAt),
      // Absent on Haiku. Absent is not `false`: it may mean unsupported,
      // rollout-gated, or missing from this protocol version.
      supportsEffort: entry.supportsEffort === null ||
          entry.supportsEffort === undefined
        ? unknown("field-absent", CLAUDE, observedAt)
        : known(entry.supportsEffort, CLAUDE, observedAt),
      supportedEffortLevels: entry.supportedEffortLevels === null ||
          entry.supportedEffortLevels === undefined
        ? unknown("field-absent", CLAUDE, observedAt)
        : known([...entry.supportedEffortLevels], CLAUDE, observedAt),
      // Claude's menu carries no per-model recommended effort at all.
      defaultEffort: unknown("surface-silent", CLAUDE, observedAt),
      observedAt,
    };

    const key = capabilityKey(record);
    const existing = grouped.get(key);
    grouped.set(key, existing === undefined ? record : merge(existing, record));
  }
  return [...grouped.values()];
}

/**
 * Fold a second menu entry for the same model into the record built from the
 * first. Aliases accumulate; a fact stays as it was unless the newcomer actually
 * knows it, because presence is positive evidence and absence is not evidence of
 * anything.
 */
function merge(base: CapabilityRecord, next: CapabilityRecord): CapabilityRecord {
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

/**
 * What a no-flag Claude launch runs, read off the same menu.
 *
 * Claude's `default` menu entry names its own resolved model, so this is a
 * discovered fact and not a Hive belief. Its effort is not: Claude publishes no
 * per-model effort recommendation anywhere, so discovery cannot name the
 * effective effort before launch. The running session later reports it through
 * `statusLine`; it stays `unknown` here rather than acquiring a plausible
 * `medium` before that observation exists.
 */
export function claudeEffectiveDefault(
  records: readonly CapabilityRecord[],
  observedAt: string,
): EffectiveDefault {
  const entry = records.find((record) => record.aliases.includes("default"));
  return {
    provider: "claude",
    model: entry === undefined
      // The menu answered and carried no `default` entry. That is this menu
      // lacking the field, not Claude lacking a default.
      ? unknown("field-absent", CLAUDE, observedAt)
      : known(entry.canonicalId, CLAUDE, observedAt),
    effort: unknown("surface-silent", CLAUDE, observedAt),
  };
}

// --------------------------------------------------------------------------
// Codex: the app-server's `model/list` and `config/read`.
// --------------------------------------------------------------------------

const CODEX_CONFIG = "codex.config/read" as const;

/**
 * `config/read`, as codex-cli 0.144.1 answers it. The keys are snake_case and
 * were read off the live wire, not inferred: a guessed key name does not raise,
 * it reads back as `null`, and a column of nulls is indistinguishable from a
 * vendor that genuinely said nothing.
 */
const CodexConfigSchema = z.object({
  config: z.object({
    model: z.string().nullable().optional(),
    model_reasoning_effort: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

/**
 * What a no-flag Codex launch runs on this machine.
 *
 * This is the effective, fully-layered value — the whole reason the ladder reads
 * `config/read` instead of the catalog's `isDefault`, which describes a different
 * machine. A null `model` means this install pins none and Codex's own built-in
 * default governs; `config/read` does not name that model, so Hive does not
 * either.
 */
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

/**
 * `model/list`, as codex-cli 0.144.1 answers it. Note `supportedReasoningEfforts`
 * is a list of *objects*, not of strings: each carries the level and the vendor's
 * own description of it. Only the level is a routing fact.
 */
const CodexModelEntrySchema = z.object({
  id: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  hidden: z.boolean().nullable().optional(),
  defaultReasoningEffort: z.string().nullable().optional(),
  supportedReasoningEfforts: z.array(
    z.object({ reasoningEffort: z.string().nullable().optional() }).passthrough(),
  ).nullable().optional(),
}).passthrough();

const CodexModelListSchema = z.object({
  data: z.array(CodexModelEntrySchema),
}).passthrough();

const CodexAccountSchema = z.object({
  account: z.object({
    email: z.string().nullable().optional(),
    planType: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

const CODEX = "codex.model/list" as const;

/**
 * One `model/list` reply → capability records.
 *
 * Codex has no aliases and no context-window variants: an id is the whole name.
 * The hidden flag is preserved rather than filtered here — a record describes
 * what the vendor said, and excluding hidden models from *automatic selection*
 * is a routing decision that belongs to the layer that routes. Dropping them at
 * ingestion would also make an explicit pin of a hidden model unresolvable.
 */
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
      canonicalId === null || canonicalId === undefined ||
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
      hidden: entry.hidden === null || entry.hidden === undefined
        ? unknown("field-absent", CODEX, observedAt)
        : known(entry.hidden, CODEX, observedAt),
      // Codex sends no `supportsEffort` boolean for any model. Inferring one
      // from a non-empty effort list is exactly the merge the design forbids: it
      // would fabricate a vendor claim that was never made.
      supportsEffort: unknown("surface-silent", CODEX, observedAt),
      supportedEffortLevels: effortLevels(entry.supportedReasoningEfforts, observedAt),
      defaultEffort: entry.defaultReasoningEffort === null ||
          entry.defaultReasoningEffort === undefined
        ? unknown("field-absent", CODEX, observedAt)
        : known(entry.defaultReasoningEffort, CODEX, observedAt),
      observedAt,
    });
  }
  return records;
}

/**
 * The levels out of Codex's effort objects, as raw strings. A list that parsed
 * but yielded no usable level is `malformed`, not an empty capability: "the
 * vendor sent something we could not read" and "the vendor said none" are
 * different claims.
 */
function effortLevels(
  efforts: readonly { reasoningEffort?: string | null }[] | null | undefined,
  observedAt: string,
): Discovered<string[]> {
  if (efforts === null || efforts === undefined) {
    return unknown("field-absent", CODEX, observedAt);
  }
  const levels = efforts
    .map((effort) => effort.reasoningEffort)
    .filter((level): level is string =>
      typeof level === "string" && level.length > 0
    );
  if (levels.length === 0 && efforts.length > 0) {
    return unknown("malformed", CODEX, observedAt);
  }
  return known(levels, CODEX, observedAt);
}

// --------------------------------------------------------------------------
// Driving the binaries.
// --------------------------------------------------------------------------

export interface ClaudeCapabilityPayload {
  /** The raw `initialize` control response. */
  handshake: unknown;
  cliVersion: string;
}

export interface CodexCapabilityPayload {
  /** The raw `model/list` result. */
  modelList: unknown;
  /** The raw `account/read` result, for the account fingerprint. */
  account: unknown;
  /** The raw `config/read` result, for the effective unflagged default. */
  config: unknown;
  cliVersion: string;
}

export interface ClaudeCapabilityTransport {
  readCatalog(timeoutMs: number): Promise<ClaudeCapabilityPayload>;
}

export interface CodexCapabilityTransport {
  readCatalog(timeoutMs: number): Promise<CodexCapabilityPayload>;
}

/**
 * The CLI's own version, which neither catalog payload carries: Claude's
 * `initialize` response has no version field, and parsing Codex's `userAgent`
 * string would be guessing at a format. `--version` prints and exits — it opens
 * no session and spends nothing.
 */
export async function readCliVersion(
  argv: readonly string[],
  fallback: string,
): Promise<string> {
  try {
    const child = Bun.spawn([...argv, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      cwd: tmpdir(),
    });
    const output = await new Response(child.stdout).text();
    await child.exited;
    const semver = /\d+\.\d+\.\d+[^\s)]*/.exec(output);
    if (semver !== null) return semver[0];
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  } catch {
    return fallback;
  }
}

/** A CLI whose version we could not read is still discoverable; the key just
 * records that the build is unknown rather than inventing one. */
const UNKNOWN_VERSION = "unknown";

export class ClaudeStdioCapabilityTransport implements ClaudeCapabilityTransport {
  constructor(
    private readonly argv: readonly string[] = [
      "claude",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    private readonly versionArgv: readonly string[] = ["claude"],
  ) {}

  async readCatalog(timeoutMs: number): Promise<ClaudeCapabilityPayload> {
    const cliVersion = await readCliVersion(this.versionArgv, UNKNOWN_VERSION);
    const child = Bun.spawn([...this.argv], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      // Probe from a neutral directory so a project's own hooks and settings do
      // not fire on a process that exists only to ask a question. Credentials
      // live in the user's home, not the cwd.
      cwd: tmpdir(),
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const responses = pendingControlResponses(child.stdout);
      child.stdin.write(`${JSON.stringify({
        type: "control_request",
        request_id: "hive-capabilities",
        request: { subtype: "initialize" },
      })}\n`);
      child.stdin.flush();
      // Only this one frame is ever sent. No user message reaches stdin, so no
      // turn starts and no model is sampled.
      const handshake = await responses.await("hive-capabilities");
      return { handshake, cliVersion };
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited.catch(() => undefined);
    }
  }
}

export class CodexStdioCapabilityTransport implements CodexCapabilityTransport {
  constructor(
    private readonly argv: readonly string[] = ["codex", "app-server", "--stdio"],
    private readonly versionArgv: readonly string[] = ["codex"],
  ) {}

  async readCatalog(timeoutMs: number): Promise<CodexCapabilityPayload> {
    const cliVersion = await readCliVersion(this.versionArgv, UNKNOWN_VERSION);
    const child = Bun.spawn([...this.argv], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      cwd: tmpdir(),
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const responses = pendingResponses(child.stdout);
      const send = (message: unknown): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        child.stdin.flush();
      };
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "hive", title: "Hive", version: HIVE_VERSION },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      });
      // The handshake is mandatory — the server answers "Not initialized" to any
      // method that precedes it — and we wait for the response rather than
      // sleeping a guessed interval. Nothing below starts a thread or a turn.
      await responses.await("1");
      send({ jsonrpc: "2.0", method: "initialized" });
      // `includeHidden` is what surfaces the vendor's internal entries. Hive asks
      // for them so it can *know* they are hidden and decline to route them; not
      // asking would leave a stale manifest's claim about them unchallenged.
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "model/list",
        params: { includeHidden: true },
      });
      send({ jsonrpc: "2.0", id: 3, method: "account/read", params: {} });
      // The effective unflagged default. A local metadata read of the layered
      // config; it starts nothing and bills nothing, like everything above it.
      send({ jsonrpc: "2.0", id: 4, method: "config/read", params: {} });
      const modelList = await responses.await("2");
      // An account we cannot read costs the fingerprint, not the catalog.
      const account = await responses.await("3").catch(() => null);
      // A config we cannot read costs the ladder's second rung, not the catalog.
      const config = await responses.await("4").catch(() => null);
      return { modelList, account, config, cliVersion };
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited.catch(() => undefined);
    }
  }
}

// --------------------------------------------------------------------------
// The probes.
// --------------------------------------------------------------------------

export interface CapabilityProbe {
  readonly provider: CapabilityProvider;
  read(): Promise<CapabilityDiscoveryResult>;
}

export class ClaudeCapabilityProbe implements CapabilityProbe {
  readonly provider = "claude";

  constructor(
    private readonly transport: ClaudeCapabilityTransport =
      new ClaudeStdioCapabilityTransport(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async read(): Promise<CapabilityDiscoveryResult> {
    try {
      const payload = await this.transport.readCatalog(DISCOVERY_TIMEOUT_MS);
      const observedAt = this.clock().toISOString();
      const records = recordsFromClaudeInitialize(
        payload.handshake,
        payload.cliVersion,
        observedAt,
      );
      if (records.length === 0) {
        // An empty menu is not "this account has no models" — it is a read we
        // could not interpret. Saying so leaves the last good snapshot standing.
        return {
          status: "unavailable",
          reason: "claude returned no usable model menu",
        };
      }
      return {
        status: "ok",
        records,
        effectiveDefault: claudeEffectiveDefault(records, observedAt),
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error
          ? error.message
          : "claude capability probe failed",
      };
    }
  }
}

export class CodexCapabilityProbe implements CapabilityProbe {
  readonly provider = "codex";

  constructor(
    private readonly transport: CodexCapabilityTransport =
      new CodexStdioCapabilityTransport(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async read(): Promise<CapabilityDiscoveryResult> {
    try {
      const payload = await this.transport.readCatalog(DISCOVERY_TIMEOUT_MS);
      const observedAt = this.clock().toISOString();
      const records = recordsFromCodexModelList(
        payload.modelList,
        payload.account,
        payload.cliVersion,
        observedAt,
      );
      if (records.length === 0) {
        return {
          status: "unavailable",
          reason: "codex app-server returned no usable model catalog",
        };
      }
      return {
        status: "ok",
        records,
        effectiveDefault: codexEffectiveDefault(payload.config, observedAt),
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error
          ? error.message
          : "codex capability probe failed",
      };
    }
  }
}
