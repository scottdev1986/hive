import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { kimiHome } from "../adapters/providers/kimi-cli";
import { definedFields } from "../shared/defined-fields";
import { errorMessage } from "../shared/error-message";
import { systemNow } from "../shared/clock";

/** Kimi's usage surface: `GET {baseUrl}/usages`, the same endpoint the CLI's own /usage panel calls (verified against kimi 0.28.1). It answers with the account's plan windows — the weekly quota and a rolling 300-minute rate window — and it is UNAUTHENTICATED-shaped like every other vendor surface: a bearer minted by the CLI's OAuth flow, read from the CLI's own credential file, never from anything Hive stores. The credential file is `$KIMI_CODE_HOME/credentials/kimi-code.json`. An expired access token is refreshed with the exact grant the CLI performs (contract read from the 0.28.1 binary): a form POST to `{oauthHost}/api/oauth/token` with the CLI's public client_id, and the rotated credential written back to the same 0600 file — which is what the CLI itself does, so the CLI stays in sync. Every failure — missing file, dead refresh, HTTP error, shape change — is an honest unknown, never a guess and never a stale-as-truth reading. */

const KIMI_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_API_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

const KimiCredentialsSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    /** Epoch seconds. */
    expires_at: z.number(),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
  })
  // Refresh rewrites this file, so preserve CLI-owned fields Hive does not know.
  .loose();

export type KimiUsageProbeResult =
  | { status: "ok"; response: unknown }
  | { status: "unavailable"; reason: string };

export interface KimiUsageTransport {
  readUsage(timeoutMs: number): Promise<KimiUsageProbeResult>;
}

export function kimiCredentialsPath(home: string = kimiHome()): string {
  return join(home, "credentials", "kimi-code.json");
}

const KimiUsageWindowSchema = z.object({
  limit: z.string(),
  used: z.string().optional(),
  remaining: z.string().optional(),
  resetTime: z.string().optional(),
});

export const KimiUsagesResponseSchema = z.object({
  user: z
    .object({
      membership: z.object({ level: z.string() }).nullish(),
    })

    .nullish(),
  usage: KimiUsageWindowSchema.nullish(),
  /** Rate-limit windows; the 300-minute one is the rolling five-hour window. An entry Hive cannot interpret becomes `null` and is dropped by the readers, rather than failing the whole payload. A strict element schema put the account's weekly window — which parsed perfectly — behind the validity of a rate window sitting next to it, so one shape change made Hive blind to a provider that was still answering. Losing the window we cannot read is a gap; losing the one we can is a defect. */
  limits: z
    .array(
      z
        .object({
          window: z.object({
            duration: z.number(),
            timeUnit: z.string(),
          }),
          detail: KimiUsageWindowSchema,
        })

        .nullable()
        .catch(null),
    )
    .nullish(),
});

/** A window's duration in minutes, or null when the unit is not one we can place — an unplaceable window is dropped, never sorted into a guessed bucket (the same rule quota-sources applies to codex windows). */
export function kimiUsageWindowMinutes(
  duration: number,
  timeUnit: string,
): number | null {
  switch (timeUnit) {
    case "TIME_UNIT_MINUTE":
      return duration;
    case "TIME_UNIT_HOUR":
      return duration * 60;
    case "TIME_UNIT_DAY":
      return duration * 24 * 60;
    default:
      return null;
  }
}

/** Percent consumed of one window, or null when the string numbers do not describe one — a malformed window is unknown, never a confident zero. `used` is preferred where the vendor sends it; where it sends only `remaining` (every `limits[].detail`), the consumed figure is `limit − remaining`. That is arithmetic on two numbers the vendor supplied, not an estimate: nothing is inferred about a window that reports neither. */
export function kimiUsageWindowPercent(detail: {
  limit: string;
  used?: string | undefined;
  remaining?: string | undefined;
}): number | null {
  const limit = Number(detail.limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const used =
    detail.used === undefined
      ? detail.remaining === undefined
        ? Number.NaN
        : limit - Number(detail.remaining)
      : Number(detail.used);
  if (!Number.isFinite(used) || used < 0 || used > limit) return null;
  return (used / limit) * 100;
}

const KimiRefreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export class KimiHttpUsageTransport implements KimiUsageTransport {
  constructor(
    private readonly options: {
      credentialsPath?: string;
      oauthHost?: string;
      baseUrl?: string;
      fetchFn?: typeof fetch;
      now?: () => number;
    } = {},
  ) {}

  async readUsage(timeoutMs: number): Promise<KimiUsageProbeResult> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const now = this.options.now ?? systemNow;
    const path = this.options.credentialsPath ?? kimiCredentialsPath();

    let credentials: z.infer<typeof KimiCredentialsSchema>;
    try {
      const parsed = KimiCredentialsSchema.safeParse(
        JSON.parse(await readFile(path, "utf8")),
      );
      if (!parsed.success) {
        return {
          status: "unavailable",
          reason: `kimi credential file is not the expected shape: ${path}`,
        };
      }
      credentials = parsed.data;
    } catch {
      return {
        status: "unavailable",
        reason: `no readable kimi credential file at ${path}`,
      };
    }

    if (credentials.expires_at * 1_000 <= now()) {
      const refreshed = await this.refresh(credentials.refresh_token, fetchFn);
      if (refreshed.status !== "ok") return refreshed;
      credentials = {
        ...credentials,
        access_token: refreshed.tokens.access_token,
        refresh_token: refreshed.tokens.refresh_token,
        expires_at: refreshed.tokens.expires_at,
        expires_in: refreshed.tokens.expires_in,
        ...definedFields({
          scope: refreshed.tokens.scope,
          token_type: refreshed.tokens.token_type,
        }),
      };
      await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, {
        mode: 0o600,
      })
        .then(() => chmod(path, 0o600))
        .catch(() => undefined);
    }

    const baseUrl = this.options.baseUrl ?? KIMI_API_BASE_URL;
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}/usages`, {
        headers: { authorization: `Bearer ${credentials.access_token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        status: "unavailable",
        reason: `kimi /usages request failed: ${errorMessage(error)}`,
      };
    }
    if (response.status !== 200) {
      return {
        status: "unavailable",
        reason: `kimi /usages answered HTTP ${response.status}`,
      };
    }
    try {
      return { status: "ok", response: await response.json() };
    } catch {
      return {
        status: "unavailable",
        reason: "kimi /usages answered a body that is not JSON",
      };
    }
  }

  private async refresh(
    refreshToken: string,
    fetchFn: typeof fetch,
  ): Promise<
    | {
        status: "ok";
        tokens: {
          access_token: string;
          refresh_token: string;
          expires_at: number;
          expires_in: number;
          scope?: string;
          token_type?: string;
        };
      }
    | { status: "unavailable"; reason: string }
  > {
    const oauthHost = this.options.oauthHost ?? KIMI_OAUTH_HOST;
    const now = this.options.now ?? systemNow;
    let response: Response;
    try {
      response = await fetchFn(
        `${oauthHost.replace(/\/$/, "")}/api/oauth/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: KIMI_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }).toString(),
        },
      );
    } catch (error) {
      return {
        status: "unavailable",
        reason: `kimi credential refresh failed: ${errorMessage(error)}`,
      };
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.status !== 200) {
      return {
        status: "unavailable",
        reason: `kimi credential refresh answered HTTP ${response.status}`,
      };
    }
    const parsed = KimiRefreshResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        status: "unavailable",
        reason: "kimi credential refresh answered an unexpected shape",
      };
    }
    return {
      status: "ok",
      tokens: {
        access_token: parsed.data.access_token,
        refresh_token: parsed.data.refresh_token,
        expires_at: Math.floor(now() / 1_000) + parsed.data.expires_in,
        expires_in: parsed.data.expires_in,
        ...definedFields({
          scope: parsed.data.scope,
          token_type: parsed.data.token_type,
        }),
      },
    };
  }
}
