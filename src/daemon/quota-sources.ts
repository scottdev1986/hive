import { tmpdir } from "node:os";
import { z } from "zod";
import type { QuotaMeterState } from "../schemas";
import { HIVE_VERSION } from "../version";
import {
  KimiHttpUsageTransport,
  KimiUsagesResponseSchema,
  type KimiUsageProbeResult,
  type KimiUsageTransport,
  kimiUsageWindowMinutes,
  kimiUsageWindowPercent,
} from "./kimi-usage";
import type { CodexRateLimitSnapshot, CodexRateLimitsResponse } from "./quota";

/**
 * Live quota discovery.
 *
 * Hive reads real limits from the providers themselves. No operator ever types a
 * capacity number to make routing work, and no capacity number is ever invented
 * when a provider declines to answer: a probe either returns a measurement or
 * says why it could not, and the gap is rendered as `unknown`.
 *
 * The asymmetry between the vendors is real and is not papered over.
 *
 * **Codex** ships a first-party control plane. `codex app-server --stdio` speaks
 * JSON-RPC; after the mandatory `initialize` + `initialized` handshake, the
 * stable method `account/rateLimits/read` returns the logged-in account's rolling
 * windows. Verified against codex-cli 0.144.0 by driving the binary: the call
 * needs no thread, no turn, and no prompt, so a startup probe costs nothing.
 * That makes Codex limits `authoritative` and available before any agent spawns.
 * How MANY windows it returns is the account's business, not Hive's: re-measured
 * on codex-cli 0.145.0 (Pro), the payload carried `primary` at 10080 minutes and
 * `secondary: null` — one weekly window and no five-hour one. `orderRateLimitWindows`
 * places by duration, so the five-hour window is simply unknown there rather than
 * being filled from the weekly figure.
 *
 * **Claude Code** answers on the same stdio transport, and the account's five-hour
 * and weekly windows arrive with it before any session has run. (An earlier note
 * here said Claude had no program-readable usage at all and that `statusLine` was
 * the only signal — measured against claude 2.1.220 on 2026-07-26 that is wrong:
 * the probe returns a `subscription` pool carrying both windows plus any
 * model-scoped weekly cap. `statusLine` remains a live push feed, but it is a
 * second source, not the only one.) Readings stay `reported` rather than
 * `authoritative` because they are a vendor-rendered figure. Hive still refuses to
 * build on `api.anthropic.com/api/oauth/usage`: it is an undocumented endpoint the
 * CLI calls for itself, and routing on it would break silently the day Anthropic
 * changes it.
 *
 * **Kimi** answers `GET /usages`, the CLI's own usage panel endpoint: an account
 * `usage` object (weekly) plus a `limits[]` array whose 300-minute entry is the
 * rolling five-hour window. The two carry their counters differently — `usage`
 * reports `used`, a `limits[].detail` reports only `remaining` — which is why
 * `kimiUsageWindowPercent` accepts either. See `kimi-usage.ts`.
 *
 * **Grok** answers on ACP `_x.ai/billing` after the same free `initialize` +
 * `initialized` handshake that the CLI's `/usage` slash command uses. The money
 * rails (`onDemandCap`, `onDemandUsed`, `prepaidBalance`) are a guard, never a
 * gauge, and there is no five-hour window on the wire.
 *
 * **As of grok 0.2.112 there is no usage gauge on the wire at all.**
 * `config.creditUsagePercent` — the 0–100 figure this parser reads, captured
 * from 0.2.99 on 2026-07-13 — is absent from the 0.2.112 payload, which now
 * carries only `currentPeriod{type,start,end}`, the money rails,
 * `isUnifiedBillingUser`, `billingPeriodStart/End` and `subscription_tier`.
 * Re-measured live on 2026-07-26; `grok` exposes no other usage surface (no
 * `usage` subcommand, and the TUI's `/usage` calls this same method).
 *
 * That absence is not the vendor going quiet: it is how xAI encodes ZERO. The
 * field is omitted while usage rounds to 0 and reappears as an integer the
 * moment it does not — watched crossing that boundary on 2026-07-27, absent
 * throughout a freshly reset window and `creditUsagePercent: 1` after
 * deliberate spend. grok's own TUI decodes the same absence the same way; its
 * debug log shows the `/usage` panel calling this exact method, receiving this
 * exact payload, and printing "Weekly limit: 0%". So grok stays METERED, and
 * reading absence as unknown is what left it unmetered for the opening slice
 * of every window. A key that is present but unparseable is the other case
 * entirely and still reads unknown — see `readingsFromGrokBilling`.
 *
 * The reset (`config.currentPeriod.end`) IS still supplied, and is kept: the
 * weekly window survives with `usedPct: null`, which `recordDiscoveredReading`
 * stores as a boundary with no window provenance. So `hive quota` reports the
 * reset the vendor stated while still reporting usage as unknown, and no hold
 * can be taken from it — a hold needs a DRAINED window, and a null gauge never
 * drains. Proved by `prototypes/vendors/grok-billing-shape.ts`.
 *
 * Providers report the *fraction* of a window consumed, never its absolute size.
 * A discovered pool is therefore denominated in percent: allowance is 100 by
 * construction, and every usage figure is a percent of that window. The one thing
 * a provider cannot tell us is how much of a window a future run will consume, so
 * reservations use Hive's own percent estimates and are always labelled estimates.
 */

const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface DiscoveredWindow {
  /**
   * The fraction of the window consumed, or null when the vendor states the
   * window's boundary but not its gauge (grok 0.2.112). Null is unknown and
   * never zero: the window exists and turns over at a stated time, and nobody
   * read how much of it is spent. Every consumer must treat null as unmeasured
   * rather than empty — `recordDiscoveredReading` writes no window provenance
   * for it, so it can never be mistaken for a measurement.
   */
  usedPct: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface DiscoveredPoolReading {
  provider: "claude" | "codex" | "grok" | "kimi";
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
  /** Absent means unknown; only a provider parser may assert not-metered. */
  fiveHourMeterState?: QuotaMeterState;
  /** Absent means unknown; only a provider parser may assert not-metered. */
  weeklyMeterState?: QuotaMeterState;
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
  provider: "claude" | "codex" | "grok" | "kimi";
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
  readonly provider: "claude" | "codex" | "grok" | "kimi";
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
export function orderRateLimitWindows(snapshot: CodexRateLimitSnapshot): {
  fiveHour: DiscoveredWindow | null;
  weekly: DiscoveredWindow | null;
} {
  // An undated window cannot be placed at all: its duration is the only thing
  // that says which bucket it describes. Dropping it is the whole point — a
  // window sorted by a guessed duration lands in the wrong bucket silently.
  const windows = [snapshot.primary, snapshot.secondary]
    .filter(
      (
        window,
      ): window is NonNullable<typeof window> & {
        windowDurationMins: number;
      } =>
        window != null &&
        Number.isFinite(window.usedPercent) &&
        window.usedPercent >= 0 &&
        window.usedPercent <= 100 &&
        typeof window.windowDurationMins === "number" &&
        Number.isFinite(window.windowDurationMins) &&
        window.windowDurationMins > 0,
    )
    .map((window) => ({
      usedPct: window.usedPercent,
      windowMinutes: window.windowDurationMins,
      resetsAt: unixSecondsToIso(window.resetsAt),
    }))
    .sort((left, right) => left.windowMinutes - right.windowMinutes);
  if (windows.length === 0) return { fiveHour: null, weekly: null };
  const first = windows[0];
  if (first === undefined) return { fiveHour: null, weekly: null };
  if (windows.length === 1) {
    const only = first;
    return only.windowMinutes <= 24 * 60
      ? { fiveHour: only, weekly: null }
      : { fiveHour: null, weekly: only };
  }
  return { fiveHour: first, weekly: windows.at(-1) ?? first };
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
  ): DiscoveredPoolReading => {
    const windows = orderRateLimitWindows(snapshot);
    const reported = [snapshot.primary, snapshot.secondary].filter(
      (window) => window !== null && window !== undefined,
    ).length;
    const parsed =
      Number(windows.fiveHour !== null) + Number(windows.weekly !== null);
    // A null slot in this authoritative response is a positive statement that
    // the plan has no second meter. A non-null slot we could not parse is not:
    // malformed data is unknown, never confident absence.
    const absent: QuotaMeterState =
      reported > parsed ? "unknown" : "not-metered";
    return {
      provider: "codex",
      account,
      pool,
      label: snapshot.limitName ?? snapshot.planType ?? null,
      models,
      ...windows,
      fiveHourMeterState: windows.fiveHour === null ? absent : "metered",
      weeklyMeterState: windows.weekly === null ? absent : "metered",
      observedAt,
      source: "provider",
      confidence: "authoritative",
    };
  };

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
export function catalogFromCodexModelList(
  result: unknown,
): ModelCatalogEntry[] {
  const parsed = CodexModelListSchema.safeParse(result);
  if (!parsed.success) return [];
  const entries: ModelCatalogEntry[] = [];
  for (const model of parsed.data.data) {
    const id = model.id ?? model.model;
    const displayName = model.displayName;
    if (
      id === null ||
      id === undefined ||
      displayName === null ||
      displayName === undefined
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
      if (
        pools.every((pool) => pool.fiveHour === null && pool.weekly === null)
      ) {
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
        typeof result !== "object" ||
        result === null ||
        !("rateLimits" in result)
      ) {
        throw new Error("codex app-server returned no rateLimits field");
      }
      // A catalog we cannot read costs us the sub-pool bindings, not the limits:
      // the pools still report, they just stay unbound and say so.
      const catalog = await responses
        .await("3")
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
export const pendingResponses = (stream: ReadableStream<Uint8Array>) =>
  responseCollector(
    stream,
    (message) => {
      if (typeof message.id !== "number") return null;
      const id = String(message.id);
      return message.error === undefined
        ? { id, result: message.result }
        : {
            id,
            error: `codex app-server error: ${JSON.stringify(message.error)}`,
          };
    },
    "codex app-server closed before answering",
  );

/** `control_response` envelopes, as Claude Code's stream-json protocol speaks them. */
export const pendingControlResponses = (stream: ReadableStream<Uint8Array>) =>
  responseCollector(
    stream,
    (message) => {
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
    },
    "claude closed before answering",
  );

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

const CodexRateLimitWindowSchema = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().positive().nullable(),
    resetsAt: z.number().nonnegative().nullable(),
  })
  .passthrough();

const CodexRateLimitSnapshotSchema = z
  .object({
    limitId: z.string().nullable().optional(),
    limitName: z.string().nullable().optional(),
    planType: z.string().nullable().optional(),
    primary: CodexRateLimitWindowSchema.nullable(),
    secondary: CodexRateLimitWindowSchema.nullable(),
  })
  .passthrough();

const CodexRateLimitsResponseSchema = z
  .object({
    rateLimits: CodexRateLimitSnapshotSchema,
    rateLimitsByLimitId: z
      .record(z.string(), CodexRateLimitSnapshotSchema)
      .nullable()
      .optional(),
  })
  .passthrough();

/** `model/list` on the Codex app-server. Only the join keys are required. */
const CodexModelListSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string().nullable().optional(),
          model: z.string().nullable().optional(),
          displayName: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** The `models[]` block of a Claude `initialize` control response. */
const ClaudeModelListSchema = z.array(
  z
    .object({
      value: z.string().nullable().optional(),
      resolvedModel: z.string().nullable().optional(),
      displayName: z.string().nullable().optional(),
    })
    .passthrough(),
);

const ClaudeUsageWindowSchema = z
  .object({
    utilization: z.number().nullable(),
    resets_at: z.string().nullable(),
  })
  .passthrough();

const ClaudeUsageResponseSchema = z
  .object({
    subscription_type: z.string().nullable(),
    rate_limits_available: z.boolean(),
    rate_limits: z
      .object({
        five_hour: ClaudeUsageWindowSchema.nullable().optional(),
        seven_day: ClaudeUsageWindowSchema.nullable().optional(),
        model_scoped: z
          .array(
            z
              .object({
                display_name: z.string().nullable(),
                utilization: z.number().nullable(),
                resets_at: z.string().nullable(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const isoOrNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const claudeWindow = (
  window: ClaudeUsageWindow | null | undefined,
  windowMinutes: number,
): DiscoveredWindow | null =>
  window === null ||
  window === undefined ||
  typeof window.utilization !== "number" ||
  !Number.isFinite(window.utilization) ||
  window.utilization < 0 ||
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
  if (!response.rate_limits_available || response.rate_limits === null) {
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
      fiveHourMeterState: fiveHour === null ? "unknown" : "metered",
      weeklyMeterState: weekly === null ? "unknown" : "metered",
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
      fiveHourMeterState: "not-metered",
      weeklyMeterState: "metered",
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
  model.replace(/\[\d+m]$/i, "");

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
      resolved === null ||
      resolved === undefined ||
      displayName === null ||
      displayName === undefined
    ) {
      continue;
    }
    const base = withoutContextSuffix(resolved);
    if (base.length === 0) continue;
    const forms = ids.get(base) ?? new Set<string>();
    for (const form of [
      model.value,
      resolved,
      withoutContextSuffix(model.value ?? ""),
      base,
    ]) {
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
      if (!payload.usage.rate_limits_available) {
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

/**
 * The `_x.ai/billing` ACP result. The gauge is `config.creditUsagePercent`.
 * The money rails stay in the schema so parsers
 * cannot confuse them with the gauge, but they are never mapped to usedPct.
 */
export interface GrokBillingResponse {
  subscription_tier?: string | null;
  config?: {
    creditUsagePercent?: number | null;
    currentPeriod?: {
      type?: string | null;
      start?: string | null;
      end?: string | null;
    } | null;
    onDemandCap?: { val?: number | null } | null;
    onDemandUsed?: { val?: number | null } | null;
    prepaidBalance?: { val?: number | null } | null;
    isUnifiedBillingUser?: boolean | null;
    billingPeriodStart?: string | null;
    billingPeriodEnd?: string | null;
  } | null;
}

const GrokMoneyValSchema = z
  .object({
    val: z.number().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const GrokBillingResponseSchema = z
  .object({
    subscription_tier: z.string().nullable().optional(),
    config: z
      .object({
        creditUsagePercent: z.number().nullable().optional(),
        currentPeriod: z
          .object({
            type: z.string().nullable().optional(),
            start: z.string().nullable().optional(),
            end: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        onDemandCap: GrokMoneyValSchema,
        onDemandUsed: GrokMoneyValSchema,
        prepaidBalance: GrokMoneyValSchema,
        isUnifiedBillingUser: z.boolean().nullable().optional(),
        billingPeriodStart: z.string().nullable().optional(),
        billingPeriodEnd: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/** Models advertised on ACP `initialize` `_meta.modelState.availableModels`. */
const GrokInitModelsSchema = z
  .object({
    availableModels: z
      .array(
        z
          .object({
            modelId: z.string().nullable().optional(),
            name: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

function periodWindowMinutes(
  period: { start?: string | null; end?: string | null } | null | undefined,
): number | null {
  if (period === null || period === undefined) return null;
  const start =
    typeof period.start === "string" ? Date.parse(period.start) : NaN;
  const end = typeof period.end === "string" ? Date.parse(period.end) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return null;
  return Math.round((end - start) / 60_000);
}

/**
 * Turn one `_x.ai/billing` response into discovered pools.
 *
 * The SuperGrok weekly pool is account-wide (`["*"]`). `creditUsagePercent` is
 * the gauge (0–100 used). `currentPeriod.end` is the reset boundary. There is
 * no five-hour window on this surface — that is a positive `not-metered`, not
 * a failed read. A payload that parses but lacks a usable percent leaves the
 * weekly window `unknown` (vendor meters it; we could not read the number),
 * never `not-metered` and never a fabricated 0/100.
 */
export function readingsFromGrokBilling(
  response: GrokBillingResponse,
  account: string,
  observedAt: string,
): DiscoveredPoolReading[] {
  const parsed = GrokBillingResponseSchema.safeParse(response);
  if (!parsed.success) return [];
  const config = parsed.data.config;
  if (config === null || config === undefined) return [];

  // ABSENT and MALFORMED are different answers and must not collapse.
  //
  // xAI omits `creditUsagePercent` entirely while it rounds to zero, and its
  // own client decodes that absence as 0% — captured from grok's debug log,
  // which shows the TUI calling this same `x.ai/billing` method, receiving a
  // payload byte-identical to this one, and rendering "Weekly limit: 0%".
  // Watched cross the boundary on 2026-07-27: absent throughout a freshly
  // reset window, then `creditUsagePercent: 1` the moment deliberate spend
  // pushed usage to 1%. Reading absence as unknown left grok unmetered for the
  // whole first slice of every window, which is exactly when it has capacity.
  //
  // A key that is PRESENT but unreadable is the opposite case: the vendor tried
  // to tell us something and we could not parse it. That stays unknown, because
  // a renamed or reshaped gauge must never read as an empty meter — the
  // dangerous direction is reporting 0% used for an account that is full.
  const percent = config.creditUsagePercent;
  const usablePercent =
    percent === undefined || percent === null
      ? 0
      : typeof percent === "number" &&
          Number.isFinite(percent) &&
          percent >= 0 &&
          percent <= 100
        ? percent
        : null;
  const period = config.currentPeriod;
  const resetsAt = isoOrNull(period?.end ?? config.billingPeriodEnd);
  const windowMinutes =
    periodWindowMinutes(period) ??
    periodWindowMinutes({
      start: config.billingPeriodStart,
      end: config.billingPeriodEnd,
    });

  // A recognized weekly period (or a gauge the vendor actually sent) means this
  // surface is the subscription pool. An empty config is not a reading at all —
  // and this test asks whether the KEY was sent, not what it decoded to, because
  // absence now decodes to 0 and an empty config would otherwise announce
  // itself as a pool at 0% used.
  // `== null` on purpose: an omitted `currentPeriod` arrives as undefined, not
  // null, and the strict check missed it — an empty config then announced
  // itself as a subscription pool at 0% used.
  const gaugeSent = percent !== undefined && percent !== null;
  if (!gaugeSent && period == null && resetsAt === null) {
    return [];
  }

  // A gauge OR a boundary is enough to be a window. 0.2.112 supplies only the
  // boundary while usage rounds to zero, and dropping the window for want of a
  // percent threw the reset away with it — `hive quota` then reported "reset
  // unknown" about a reset the vendor had plainly stated.
  const weekly: DiscoveredWindow | null =
    usablePercent === null && resetsAt === null
      ? null
      : {
          usedPct: usablePercent,
          windowMinutes,
          resetsAt,
        };

  return [
    {
      provider: "grok",
      account,
      pool: "subscription",
      label: parsed.data.subscription_tier ?? null,
      models: ["*"],
      fiveHour: null,
      weekly,
      // No five-hour field has ever been observed on `_x.ai/billing`. That is
      // absence-by-design, not a parse miss.
      fiveHourMeterState: "not-metered",
      // Missing percent with a recognized surface is unknown, never not-metered:
      // the vendor does meter the weekly pool; we just did not get the number.
      // Keyed on the gauge, not on the window: a boundary-only window is still
      // an unread meter.
      weeklyMeterState: weekly?.usedPct == null ? "unknown" : "metered",
      observedAt,
      source: "provider",
      confidence: "reported",
    },
  ];
}

/** What one Grok probe session reads: billing + the free init model catalog. */
export interface GrokProbePayload {
  billing: GrokBillingResponse;
  catalog: ModelCatalogEntry[];
}

export interface GrokProbeTransport {
  /** ACP initialize → initialized → `_x.ai/billing`. No prompt, no turn. */
  readBilling(timeoutMs: number): Promise<GrokProbePayload>;
}

/**
 * Models from the ACP `initialize` result's `_meta.modelState`. Free — this
 * frame is already required for the billing handshake.
 */
export function catalogFromGrokInitialize(
  result: unknown,
): ModelCatalogEntry[] {
  if (typeof result !== "object" || result === null) return [];
  const meta = (result as Record<string, unknown>)._meta;
  if (typeof meta !== "object" || meta === null) return [];
  const modelState = (meta as Record<string, unknown>).modelState;
  const parsed = GrokInitModelsSchema.safeParse(modelState);
  if (!parsed.success) return [];
  const entries: ModelCatalogEntry[] = [];
  for (const model of parsed.data.availableModels ?? []) {
    const modelId = model.modelId;
    if (typeof modelId !== "string" || modelId.length === 0) continue;
    const displayName =
      typeof model.name === "string" && model.name.length > 0
        ? model.name
        : modelId;
    entries.push({ provider: "grok", modelId, displayName });
  }
  return entries;
}

export class GrokQuotaProbe implements QuotaProbe {
  readonly provider = "grok";

  constructor(
    private readonly transport: GrokProbeTransport,
    private readonly clock: () => Date = () => new Date(),
    private readonly account = "default",
  ) {}

  async read(): Promise<QuotaProbeResult> {
    try {
      const payload = await this.transport.readBilling(HANDSHAKE_TIMEOUT_MS);
      const pools = readingsFromGrokBilling(
        payload.billing,
        this.account,
        this.clock().toISOString(),
      );
      if (pools.length === 0) {
        return {
          status: "unavailable",
          reason:
            "grok `_x.ai/billing` returned no usable weekly usage reading; " +
            "the account may not be signed in",
        };
      }
      // A pool whose weekly number is missing is still a successful probe of
      // the surface (five-hour not-metered, weekly unknown). Callers must not
      // treat that as "provider down".
      return { status: "ok", pools, catalog: payload.catalog };
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "grok probe failed",
      };
    }
  }
}

/**
 * Drive a throwaway `grok agent stdio` over ACP. Handshake then
 * `_x.ai/billing` with `{}`. No session, no prompt, no model turn — same cost
 * class as Codex's rate-limit read. Verified against grok 0.2.99.
 *
 * Bare `x.ai/billing` (no underscore) returns -32601 Method not found.
 */
export class GrokStdioProbeTransport implements GrokProbeTransport {
  constructor(private readonly argv: string[] = ["grok", "agent", "stdio"]) {}

  async readBilling(timeoutMs: number): Promise<GrokProbePayload> {
    const child = Bun.spawn(this.argv, {
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
          protocolVersion: 1,
          clientInfo: { name: "hive", version: HIVE_VERSION },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
          },
        },
      });
      const initResult = await responses.await("1");
      const catalog = catalogFromGrokInitialize(initResult);
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "_x.ai/billing",
        params: {},
      });
      const result = await responses.await("2");
      if (typeof result !== "object" || result === null) {
        throw new Error("grok `_x.ai/billing` returned no result payload");
      }
      return {
        billing: result as GrokBillingResponse,
        catalog,
      };
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited.catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Kimi: GET /usages — the CLI's own /usage panel endpoint (kimi-usage.ts).
// ---------------------------------------------------------------------------

const KIMI_WEEKLY_MINUTES = 7 * 24 * 60;

const kimiIsoOrNull = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/**
 * Turn one /usages response into a discovered pool. The payload is
 * account-wide — one weekly quota and a set of rate windows with no model
 * names anywhere — so there is exactly one pool and it carries `["*"]`. The
 * 300-minute rate window is the five-hour one; the weekly's 7-day length is the
 * documented refresh, not a payload field. Both windows are things this
 * surface meters, so a missing or unparseable number is `unknown`, never
 * `not-metered`. The membership level is the vendor's own plan name, used as
 * the label the way Claude's `subscription_type` and Grok's tier are.
 */
export function readingsFromKimiUsages(
  response: unknown,
  account: string,
  observedAt: string,
): DiscoveredPoolReading[] {
  const parsed = KimiUsagesResponseSchema.safeParse(response);
  if (!parsed.success) return [];
  // Both fields optional means a shape-changed payload parses clean with
  // neither — the surface going quiet, which reads as no reading at all.
  if (parsed.data.usage == null && parsed.data.limits == null) return [];

  const weeklyDetail = parsed.data.usage;
  const weeklyPercent =
    weeklyDetail == null ? null : kimiUsageWindowPercent(weeklyDetail);
  const weekly: DiscoveredWindow | null =
    weeklyPercent === null || weeklyDetail == null
      ? null
      : {
          usedPct: weeklyPercent,
          windowMinutes: KIMI_WEEKLY_MINUTES,
          resetsAt: kimiIsoOrNull(weeklyDetail.resetTime),
        };

  const fiveHourEntry = (parsed.data.limits ?? [])
    // A window Hive could not interpret is null here; dropping it costs that
    // window, not the whole reading.
    .filter((entry) => entry !== null)
    .map((entry) => ({
      minutes: kimiUsageWindowMinutes(
        entry.window.duration,
        entry.window.timeUnit,
      ),
      detail: entry.detail,
    }))
    .find(
      (entry): entry is typeof entry & { minutes: number } =>
        entry.minutes === 300,
    );
  const fiveHourPercent =
    fiveHourEntry === undefined
      ? null
      : kimiUsageWindowPercent(fiveHourEntry.detail);
  const fiveHour: DiscoveredWindow | null =
    fiveHourEntry === undefined || fiveHourPercent === null
      ? null
      : {
          usedPct: fiveHourPercent,
          windowMinutes: fiveHourEntry.minutes,
          resetsAt: kimiIsoOrNull(fiveHourEntry.detail.resetTime),
        };

  if (fiveHour === null && weekly === null) return [];
  return [
    {
      provider: "kimi",
      account,
      pool: "subscription",
      label: parsed.data.user?.membership?.level ?? null,
      models: ["*"],
      fiveHour,
      weekly,
      fiveHourMeterState: fiveHour === null ? "unknown" : "metered",
      weeklyMeterState: weekly === null ? "unknown" : "metered",
      observedAt,
      source: "provider",
      // An undocumented endpoint whose shape may change under us — the same
      // standing as Claude's self-described-experimental `get_usage`.
      confidence: "reported",
    },
  ];
}

export class KimiQuotaProbe implements QuotaProbe {
  readonly provider = "kimi";

  constructor(
    private readonly transport: KimiUsageTransport = new KimiHttpUsageTransport(),
    private readonly clock: () => Date = () => new Date(),
    private readonly account = "default",
  ) {}

  async read(): Promise<QuotaProbeResult> {
    let payload: KimiUsageProbeResult;
    try {
      payload = await this.transport.readUsage(HANDSHAKE_TIMEOUT_MS);
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof Error ? error.message : "kimi usage probe failed",
      };
    }
    if (payload.status !== "ok") {
      return { status: "unavailable", reason: payload.reason };
    }
    const pools = readingsFromKimiUsages(
      payload.response,
      this.account,
      this.clock().toISOString(),
    );
    if (pools.length === 0) {
      return {
        status: "unavailable",
        reason: "kimi /usages returned no usable usage reading",
      };
    }
    // The model catalog is a separate surface (`kimi provider list`); this
    // payload names no models, so there is nothing free to join here.
    return { status: "ok", pools, catalog: [] };
  }
}
