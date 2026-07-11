import { tmpdir } from "node:os";
import type { CodexRateLimitsResponse, CodexRateLimitSnapshot } from "./quota";
import { HIVE_VERSION } from "../version";
import { z } from "zod";

/**
 * Live quota discovery.
 *
 * Hive reads real limits from the providers themselves. No operator ever types a
 * capacity number to make routing work, and no capacity number is ever invented
 * when a provider declines to answer: a probe either returns a measurement or
 * says why it could not, and the gap is rendered as `unknown`.
 *
 * The asymmetry between the two vendors is real and is not papered over.
 *
 * **Codex** ships a first-party control plane. `codex app-server --stdio` speaks
 * JSON-RPC; after the mandatory `initialize` + `initialized` handshake, the
 * stable method `account/rateLimits/read` returns the logged-in account's rolling
 * windows. Verified against codex-cli 0.144.0 by driving the binary: the call
 * needs no thread, no turn, and no prompt, so a startup probe costs nothing.
 * That makes Codex limits `authoritative` and available before any agent spawns.
 *
 * **Claude Code** has no equivalent. Its `initialize` control response carries the
 * account and the model list but no usage. The only program-readable subscriber
 * signal is the `statusLine` hook payload, which appears only after a session has
 * produced a response. So Claude limits are `reported`, they arrive once an agent
 * is running, and before that Hive reports them as unknown rather than guessing.
 * Hive refuses to build on `api.anthropic.com/api/oauth/usage`: it is an
 * undocumented endpoint the CLI calls for itself, and routing on it would break
 * silently the day Anthropic changes it.
 *
 * Providers report the *fraction* of a window consumed, never its absolute size.
 * A discovered pool is therefore denominated in percent: allowance is 100 by
 * construction, and every usage figure is a percent of that window. The one thing
 * a provider cannot tell us is how much of a window a future run will consume, so
 * reservations use Hive's own percent estimates and are always labelled estimates.
 */

const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface DiscoveredWindow {
  usedPct: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface DiscoveredPoolReading {
  provider: "claude" | "codex";
  account: string;
  pool: string;
  label: string | null;
  /**
   * `["*"]` marks the account-wide pool every model spends from. A metered
   * sub-pool leaves this empty: the rate-limit payload names the pool but not
   * the model id it gates, so the binding is resolved later against the model
   * catalog rather than guessed here. See `ModelCatalogEntry`.
   */
  models: string[];
  fiveHour: DiscoveredWindow | null;
  weekly: DiscoveredWindow | null;
  observedAt: string;
  source: "provider" | "statusline";
  confidence: "authoritative" | "reported";
}

/**
 * One model, as the provider's own catalog names it.
 *
 * This is the join that binds a metered sub-pool to the models it actually
 * meters. Neither vendor's quota payload carries a model id — Claude's
 * `get_usage` reports `scope.model.id: null` next to `display_name: "Fable"`,
 * and Codex's `rateLimitsByLimitId` keys a pool `codex_bengalfox` with
 * `limitName: "GPT-5.3-Codex-Spark"`. Both name the model the way their own
 * model catalog names it, and both publish that catalog for free:
 *
 * - Claude: the `initialize` control response carries `models[]`, each with a
 *   `displayName` and the concrete `resolvedModel` it launches.
 * - Codex: the app-server answers `model/list` with `id` and `displayName`.
 *
 * So the mapping is discovered, never hardcoded: match the pool's provider-given
 * name against the provider's own display names and take the model ids. A pool
 * whose name matches nothing in the catalog stays unbound and says so, rather
 * than being attached to a model on a guess.
 */
export interface ModelCatalogEntry {
  provider: "claude" | "codex";
  /** The id a spawn actually launches, e.g. `claude-fable-5`. */
  modelId: string;
  /** The provider's display name, e.g. `Fable`. The join key. */
  displayName: string;
}

export type QuotaProbeResult =
  | {
    status: "ok";
    pools: DiscoveredPoolReading[];
    /** The provider's model catalog, when the probe could read it. */
    catalog: ModelCatalogEntry[];
  }
  | { status: "unavailable"; reason: string };

export interface QuotaProbe {
  readonly provider: "claude" | "codex";
  read(): Promise<QuotaProbeResult>;
}

const unixSecondsToIso = (value: number | null | undefined): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Order the two reported windows by duration rather than by the name the
 * provider happened to give them. `primary`/`secondary` is positional, and a
 * plan that reports its weekly bucket first would otherwise silently invert the
 * five-hour and weekly numbers. A snapshot with fewer than two usable windows
 * yields whatever it did report; nothing is fabricated for the missing one.
 */
export function orderRateLimitWindows(
  snapshot: CodexRateLimitSnapshot,
): { fiveHour: DiscoveredWindow | null; weekly: DiscoveredWindow | null } {
  // An undated window cannot be placed at all: its duration is the only thing
  // that says which bucket it describes. Dropping it is the whole point — a
  // window sorted by a guessed duration lands in the wrong bucket silently.
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window) => window !== null && window !== undefined)
    .filter((window) =>
      Number.isFinite(window!.usedPercent) && window!.usedPercent >= 0 &&
      window!.usedPercent <= 100 &&
      typeof window!.windowDurationMins === "number" &&
      Number.isFinite(window!.windowDurationMins) &&
      window!.windowDurationMins > 0
    )
    .map((window) => ({
      usedPct: window!.usedPercent,
      windowMinutes: window!.windowDurationMins!,
      resetsAt: unixSecondsToIso(window!.resetsAt),
    }))
    .sort((left, right) => left.windowMinutes - right.windowMinutes);
  if (windows.length === 0) return { fiveHour: null, weekly: null };
  if (windows.length === 1) {
    const only = windows[0]!;
    return only.windowMinutes <= 24 * 60
      ? { fiveHour: only, weekly: null }
      : { fiveHour: null, weekly: only };
  }
  return { fiveHour: windows[0]!, weekly: windows.at(-1)! };
}

/**
 * Translate one `account/rateLimits/read` response into discovered pools.
 *
 * The top-level `rateLimits` snapshot is the account's routable bucket: every
 * model spends from it, so it carries `["*"]`. Entries in `rateLimitsByLimitId`
 * describe metered sub-limits — a specific model's own cap, like
 * `codex_bengalfox` for GPT-5.3-Codex-Spark. The `limitId` itself is an opaque
 * codename that maps to no model, but `limitName` is the model's display name,
 * and the app-server's `model/list` publishes those display names against
 * concrete ids. The binding is therefore resolved against the catalog rather
 * than from this payload alone, so it is left empty here.
 */
export function readingsFromCodexResponse(
  response: CodexRateLimitsResponse,
  account: string,
  observedAt: string,
): DiscoveredPoolReading[] {
  const parsed = CodexRateLimitsResponseSchema.safeParse(response);
  if (!parsed.success) return [];
  response = parsed.data;
  const base = (
    snapshot: CodexRateLimitSnapshot,
    pool: string,
    models: string[],
  ): DiscoveredPoolReading => ({
    provider: "codex",
    account,
    pool,
    label: snapshot.limitName ?? snapshot.planType ?? null,
    models,
    ...orderRateLimitWindows(snapshot),
    observedAt,
    source: "provider",
    confidence: "authoritative",
  });

  const routablePool = response.rateLimits.limitId ?? "default";
  const pools = [base(response.rateLimits, routablePool, ["*"])];
  for (const [limitId, snapshot] of Object.entries(
    response.rateLimitsByLimitId ?? {},
  )) {
    if (limitId === routablePool) continue;
    pools.push(base(snapshot, limitId, []));
  }
  return pools;
}

/** What one Codex probe session reads: the limits, and the model catalog. */
export interface CodexProbePayload {
  limits: CodexRateLimitsResponse;
  catalog: ModelCatalogEntry[];
}

export interface CodexProbeTransport {
  /**
   * Run one `initialize` → `initialized` → `account/rateLimits/read` +
   * `model/list` exchange against a fresh `codex app-server --stdio` process.
   */
  readRateLimits(timeoutMs: number): Promise<CodexProbePayload>;
}

/** `model/list` → catalog entries. Verified against codex-cli 0.144.1. */
export function catalogFromCodexModelList(result: unknown): ModelCatalogEntry[] {
  const parsed = CodexModelListSchema.safeParse(result);
  if (!parsed.success) return [];
  const entries: ModelCatalogEntry[] = [];
  for (const model of parsed.data.data) {
    const id = model.id ?? model.model;
    const displayName = model.displayName;
    if (
      id === null || id === undefined ||
      displayName === null || displayName === undefined
    ) {
      continue;
    }
    entries.push({ provider: "codex", modelId: id, displayName });
  }
  return entries;
}

export class CodexQuotaProbe implements QuotaProbe {
  readonly provider = "codex";

  constructor(
    private readonly transport: CodexProbeTransport,
    private readonly clock: () => Date = () => new Date(),
    private readonly account = "default",
  ) {}

  async read(): Promise<QuotaProbeResult> {
    try {
      const payload = await this.transport.readRateLimits(HANDSHAKE_TIMEOUT_MS);
      const pools = readingsFromCodexResponse(
        payload.limits,
        this.account,
        this.clock().toISOString(),
      );
      if (pools.every((pool) => pool.fiveHour === null && pool.weekly === null)) {
        return {
          status: "unavailable",
          reason:
            "codex app-server returned no usable rate-limit windows; the account may not be signed in",
        };
      }
      return { status: "ok", pools, catalog: payload.catalog };
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "codex probe failed",
      };
    }
  }
}

/**
 * Drive a throwaway `codex app-server` over stdio. The handshake is mandatory —
 * the server answers "Not initialized" to any method that precedes it — and we
 * wait for the `initialize` *response* rather than sleeping a guessed interval,
 * so the read is issued exactly when the server is ready for it.
 *
 * Nothing here starts a thread or a turn, so the probe never bills.
 */
export class CodexStdioProbeTransport implements CodexProbeTransport {
  constructor(
    private readonly argv: string[] = ["codex", "app-server", "--stdio"],
  ) {}

  async readRateLimits(timeoutMs: number): Promise<CodexProbePayload> {
    const child = Bun.spawn(this.argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      // Probe from a neutral directory so a project's own hooks and settings —
      // hive's statusLine among them — do not fire on a process that exists only
      // to ask a question. Credentials live in the user's home, not the cwd.
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
      await responses.await("1");
      send({ jsonrpc: "2.0", method: "initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "account/rateLimits/read",
        params: null,
      });
      // `model/list` publishes the display names the rate-limit payload labels
      // its sub-pools with, and is the only way to learn which model a limit id
      // like `codex_bengalfox` actually meters. It starts no thread, so the
      // catalog read is as free as the limits read beside it. `params` must be
      // an object — the server rejects a null one as a missing field.
      send({ jsonrpc: "2.0", id: 3, method: "model/list", params: {} });
      const result = await responses.await("2");
      if (
        typeof result !== "object" || result === null ||
        !("rateLimits" in result)
      ) {
        throw new Error("codex app-server returned no rateLimits field");
      }
      // A catalog we cannot read costs us the sub-pool bindings, not the limits:
      // the pools still report, they just stay unbound and say so.
      const catalog = await responses.await("3")
        .then(catalogFromCodexModelList)
        .catch(() => [] as ModelCatalogEntry[]);
      return {
        limits: result as unknown as CodexRateLimitsResponse,
        catalog,
      };
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited.catch(() => undefined);
    }
  }
}

type Correlated =
  | { id: string; result: unknown }
  | { id: string; error: string }
  | null;

/**
 * Correlate replies off a line-delimited stdout stream. Both CLIs interleave
 * their replies with notifications and log noise, so anything the extractor does
 * not recognise as a reply to one of our requests is skipped rather than parsed.
 */
function responseCollector(
  stream: ReadableStream<Uint8Array>,
  extract: (message: Record<string, unknown>) => Correlated,
  closedMessage: string,
): { await(id: string): Promise<unknown> } {
  const settled = new Map<string, { result: unknown } | { error: string }>();
  const waiting = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let failure: Error | null = null;

  const failAll = (error: Error): void => {
    failure = error;
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  };

  void (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed !== "object" || parsed === null) continue;
        const correlated = extract(parsed as Record<string, unknown>);
        if (correlated === null) continue;
        const pending = waiting.get(correlated.id);
        waiting.delete(correlated.id);
        if ("error" in correlated) {
          const error = new Error(correlated.error);
          if (pending === undefined) settled.set(correlated.id, correlated);
          else pending.reject(error);
          continue;
        }
        if (pending === undefined) settled.set(correlated.id, correlated);
        else pending.resolve(correlated.result);
      }
    }
    failAll(new Error(closedMessage));
  })();

  return {
    await(id: string): Promise<unknown> {
      const done = settled.get(id);
      if (done !== undefined) {
        settled.delete(id);
        return "error" in done
          ? Promise.reject(new Error(done.error))
          : Promise.resolve(done.result);
      }
      if (failure !== null) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
      });
    },
  };
}

/** JSON-RPC 2.0 replies, as the Codex app-server speaks them. */
const pendingResponses = (stream: ReadableStream<Uint8Array>) =>
  responseCollector(stream, (message) => {
    if (typeof message.id !== "number") return null;
    const id = String(message.id);
    return message.error === undefined
      ? { id, result: message.result }
      : { id, error: `codex app-server error: ${JSON.stringify(message.error)}` };
  }, "codex app-server closed before answering");

/** `control_response` envelopes, as Claude Code's stream-json protocol speaks them. */
const pendingControlResponses = (stream: ReadableStream<Uint8Array>) =>
  responseCollector(stream, (message) => {
    if (message.type !== "control_response") return null;
    const response = message.response;
    if (typeof response !== "object" || response === null) return null;
    const record = response as Record<string, unknown>;
    if (typeof record.request_id !== "string") return null;
    return record.subtype === "error"
      ? {
        id: record.request_id,
        error: `claude control error: ${String(record.error ?? "unknown")}`,
      }
      : { id: record.request_id, result: record.response };
  }, "claude closed before answering");

/**
 * The `get_usage` control response, as verified by driving claude 2.1.206.
 * Percentages are `utilization` on a 0–100 scale and resets are ISO-8601 —
 * deliberately unlike the statusLine hook, which names the same facts
 * `used_percentage` and stamps resets in unix seconds.
 */
export interface ClaudeUsageResponse {
  subscription_type: string | null;
  rate_limits_available: boolean;
  rate_limits: {
    five_hour?: ClaudeUsageWindow | null;
    seven_day?: ClaudeUsageWindow | null;
    model_scoped?: ClaudeModelScopedLimit[] | null;
  } | null;
}

export interface ClaudeUsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

export interface ClaudeModelScopedLimit {
  display_name: string | null;
  utilization: number | null;
  resets_at: string | null;
}

const CodexRateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().positive().nullable(),
  resetsAt: z.number().nonnegative().nullable(),
}).passthrough();

const CodexRateLimitSnapshotSchema = z.object({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  planType: z.string().nullable().optional(),
  primary: CodexRateLimitWindowSchema.nullable(),
  secondary: CodexRateLimitWindowSchema.nullable(),
}).passthrough();

const CodexRateLimitsResponseSchema = z.object({
  rateLimits: CodexRateLimitSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), CodexRateLimitSnapshotSchema).nullable().optional(),
}).passthrough();

/** `model/list` on the Codex app-server. Only the join keys are required. */
const CodexModelListSchema = z.object({
  data: z.array(z.object({
    id: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  }).passthrough()),
}).passthrough();

/** The `models[]` block of a Claude `initialize` control response. */
const ClaudeModelListSchema = z.array(z.object({
  value: z.string().nullable().optional(),
  resolvedModel: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
}).passthrough());

const ClaudeUsageWindowSchema = z.object({
  utilization: z.number().nullable(),
  resets_at: z.string().nullable(),
}).passthrough();

const ClaudeUsageResponseSchema = z.object({
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: z.object({
    five_hour: ClaudeUsageWindowSchema.nullable().optional(),
    seven_day: ClaudeUsageWindowSchema.nullable().optional(),
    model_scoped: z.array(z.object({
      display_name: z.string().nullable(),
      utilization: z.number().nullable(),
      resets_at: z.string().nullable(),
    }).passthrough()).nullable().optional(),
  }).passthrough().nullable(),
}).passthrough();

const isoOrNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const claudeWindow = (
  window: ClaudeUsageWindow | null | undefined,
  windowMinutes: number,
): DiscoveredWindow | null =>
  window === null || window === undefined ||
    typeof window.utilization !== "number" ||
    !Number.isFinite(window.utilization) || window.utilization < 0 ||
    window.utilization > 100
    ? null
    : {
      usedPct: window.utilization,
      windowMinutes,
      resetsAt: isoOrNull(window.resets_at),
    };

/**
 * Turn one `get_usage` response into discovered pools.
 *
 * The account-wide five-hour and seven-day windows form the general pool. Every
 * Claude model spends from it — including the ones with no meter of their own,
 * which is most of them — so it carries `["*"]` and is the pool a model falls
 * back to. Opus has no dedicated weekly cap and is metered here; a Claude model
 * is never "unmetered" while this pool exists.
 *
 * A model-scoped weekly cap (a premium model with its own ceiling) arrives with
 * a display name and a null model id — `scope.model.id` is null next to
 * `display_name: "Fable"`. The id gap is closed against the CLI's own model
 * catalog rather than by guessing, so the pool is left unbound here and bound at
 * resolve time. Its five-hour window is genuinely absent, not merely unread:
 * the provider meters these caps weekly only.
 */
export function readingsFromClaudeUsage(
  response: ClaudeUsageResponse,
  account: string,
  observedAt: string,
): DiscoveredPoolReading[] {
  const parsed = ClaudeUsageResponseSchema.safeParse(response);
  if (!parsed.success) return [];
  response = parsed.data;
  if (response.rate_limits_available !== true || response.rate_limits === null) {
    return [];
  }
  const limits = response.rate_limits ?? {};
  const fiveHour = claudeWindow(limits.five_hour, 5 * 60);
  const weekly = claudeWindow(limits.seven_day, 7 * 24 * 60);
  const pools: DiscoveredPoolReading[] = [];
  if (fiveHour !== null || weekly !== null) {
    pools.push({
      provider: "claude",
      account,
      pool: "subscription",
      label: response.subscription_type,
      models: ["*"],
      fiveHour,
      weekly,
      observedAt,
      source: "provider",
      // `get_usage` is self-described as experimental and its shape may change,
      // so a reading through it is a reported signal, not gospel — unlike the
      // Codex app-server's stable rate-limit method.
      confidence: "reported",
    });
  }
  for (const scoped of limits.model_scoped ?? []) {
    const window = claudeWindow(scoped, 7 * 24 * 60);
    if (window === null || scoped.display_name === null) continue;
    pools.push({
      provider: "claude",
      account,
      pool: `weekly:${scoped.display_name}`,
      label: scoped.display_name,
      models: [],
      fiveHour: null,
      weekly: window,
      observedAt,
      source: "provider",
      confidence: "reported",
    });
  }
  return pools;
}

/** What one Claude probe session reads: the usage, and the model catalog. */
export interface ClaudeProbePayload {
  usage: ClaudeUsageResponse;
  catalog: ModelCatalogEntry[];
}

export interface ClaudeProbeTransport {
  /** Send `initialize` then `get_usage`; both frames are free. */
  readUsage(timeoutMs: number): Promise<ClaudeProbePayload>;
}

/** The CLI appends `[1m]` to name a 1M-context variant of the same model. */
const withoutContextSuffix = (model: string): string =>
  model.replace(/\[\d+m\]$/i, "");

/**
 * The `models[]` block of an `initialize` control response → catalog entries.
 *
 * One model reaches Hive under several names: the alias a human types
 * (`opus`), the alias the CLI ships (`default`), the 1M-context variant
 * (`claude-opus-4-8[1m]`), and the concrete id that bills
 * (`claude-opus-4-8`). They are all the same meter, so every id form of a model
 * is bound to every display name that model answers to, and a pool named for
 * any of them gates all of them. Otherwise a spawn could dodge an exhausted
 * pool by pinning the model under a different one of its own names.
 */
export function catalogFromClaudeModels(models: unknown): ModelCatalogEntry[] {
  const parsed = ClaudeModelListSchema.safeParse(models);
  if (!parsed.success) return [];
  const ids = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  for (const model of parsed.data) {
    const resolved = model.resolvedModel;
    const displayName = model.displayName;
    if (
      resolved === null || resolved === undefined ||
      displayName === null || displayName === undefined
    ) {
      continue;
    }
    const base = withoutContextSuffix(resolved);
    if (base.length === 0) continue;
    const forms = ids.get(base) ?? new Set<string>();
    for (
      const form of [
        model.value,
        resolved,
        withoutContextSuffix(model.value ?? ""),
        base,
      ]
    ) {
      if (typeof form === "string" && form.length > 0) forms.add(form);
    }
    ids.set(base, forms);
    const display = names.get(base) ?? new Set<string>();
    display.add(displayName);
    names.set(base, display);
  }
  const entries: ModelCatalogEntry[] = [];
  for (const [base, forms] of ids) {
    for (const modelId of forms) {
      for (const displayName of names.get(base) ?? []) {
        entries.push({ provider: "claude", modelId, displayName });
      }
    }
  }
  return entries;
}

export class ClaudeQuotaProbe implements QuotaProbe {
  readonly provider = "claude";

  constructor(
    private readonly transport: ClaudeProbeTransport,
    private readonly clock: () => Date = () => new Date(),
    private readonly account = "default",
  ) {}

  async read(): Promise<QuotaProbeResult> {
    try {
      const payload = await this.transport.readUsage(HANDSHAKE_TIMEOUT_MS);
      if (payload.usage.rate_limits_available !== true) {
        return { status: "unavailable", reason: CLAUDE_NO_SUBSCRIBER_LIMITS };
      }
      const pools = readingsFromClaudeUsage(
        payload.usage,
        this.account,
        this.clock().toISOString(),
      );
      if (pools.length === 0) {
        return {
          status: "unavailable",
          reason: "claude reported no usable rate-limit windows",
        };
      }
      return { status: "ok", pools, catalog: payload.catalog };
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "claude probe failed",
      };
    }
  }
}

/**
 * Ask a throwaway Claude Code process for the account's plan usage.
 *
 * Two control frames go down stdin and no user message ever does, so the CLI
 * starts no turn and samples no model: `total_cost_usd` stays zero. Verified by
 * driving claude 2.1.206. `get_usage` proxies the account's usage endpoint
 * through the CLI's own auth, which is why Hive calls it here rather than
 * calling `api.anthropic.com/api/oauth/usage` directly — that endpoint is
 * undocumented, rate-limits aggressively, and would break silently on change.
 * It is nonetheless marked experimental by the CLI, so its readings are
 * `reported`, and any failure degrades to `unknown` rather than to a number.
 */
export class ClaudeStdioProbeTransport implements ClaudeProbeTransport {
  constructor(
    private readonly argv: string[] = [
      "claude",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
  ) {}

  async readUsage(timeoutMs: number): Promise<ClaudeProbePayload> {
    const child = Bun.spawn(this.argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      // Probe from a neutral directory so a project's own hooks and settings —
      // hive's statusLine among them — do not fire on a process that exists only
      // to ask a question. Credentials live in the user's home, not the cwd.
      cwd: tmpdir(),
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const responses = pendingControlResponses(child.stdout);
      const send = (message: unknown): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        child.stdin.flush();
      };
      send({
        type: "control_request",
        request_id: "hive-init",
        request: { subtype: "initialize" },
      });
      // The handshake we already wait on carries the account's model catalog —
      // display name and resolved id per model. It is the only surface that says
      // which concrete model the usage payload's `"Fable"` denotes, and it costs
      // nothing extra: this frame was being awaited and thrown away.
      const handshake = await responses.await("hive-init");
      const catalog = catalogFromClaudeModels(
        typeof handshake === "object" && handshake !== null
          ? (handshake as Record<string, unknown>).models
          : undefined,
      );
      send({
        type: "control_request",
        request_id: "hive-usage",
        request: { subtype: "get_usage" },
      });
      const result = await responses.await("hive-usage");
      if (typeof result !== "object" || result === null) {
        throw new Error("claude returned no get_usage payload");
      }
      return { usage: result as unknown as ClaudeUsageResponse, catalog };
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited.catch(() => undefined);
    }
  }
}

export const CLAUDE_NO_SUBSCRIBER_LIMITS =
  "Claude Code reports no subscriber rate limits for this account; API-key, " +
  "Bedrock, and Vertex accounts have no plan windows to read.";
