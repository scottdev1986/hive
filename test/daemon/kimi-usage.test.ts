import { afterEach, describe, expect, test } from "bun:test";
import { readingsFromKimiUsages } from "../../src/daemon/quota-sources";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  KimiHttpUsageTransport,
  kimiCredentialsPath,
} from "../../src/daemon/kimi-usage";
import {
  accountBillingFromKimiUsage,
  readAccountBilling,
} from "../../src/daemon/usage-credits";

/**
 * Kimi's usage surface: GET /usages with the CLI's OAuth credential,
 * refreshing an expired token with the CLI's exact grant. Every test uses a
 * fake credential file under a temp KIMI_CODE_HOME and a fake fetch — the
 * real ~/.kimi-code is never touched.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const NOW = Date.parse("2026-07-24T12:00:00.000Z");

/** The verified 2026-07-24 live response shape. */
const USAGES_BODY = {
  user: { userId: "u", membership: { level: "LEVEL_ADVANCED" } },
  usage: {
    limit: "100",
    used: "40",
    remaining: "60",
    resetTime: "2026-07-29T21:38:00.343103Z",
  },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: "100",
        used: "1",
        remaining: "99",
        resetTime: "2026-07-24T18:38:00Z",
      },
    },
  ],
  parallel: { limit: "30" },
  authentication: { method: "METHOD_ACCESS_TOKEN", scope: "FEATURE_CODING" },
};

async function credentialFile(
  credentials: Record<string, unknown>,
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-kimi-usage-"));
  roots.push(home);
  const path = kimiCredentialsPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  return path;
}

const freshCredentials = {
  access_token: "live-token",
  refresh_token: "refresh-token",
  expires_at: Math.floor(NOW / 1_000) + 3_600,
  expires_in: 3_600,
  scope: "FEATURE_CODING",
  token_type: "Bearer",
};

const usagesResponse = (body: unknown = USAGES_BODY, status = 200) =>
  new Response(JSON.stringify(body), { status });

function jsonRequestLog(): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchFn: typeof fetch;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return usagesResponse();
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("kimi usage probe", () => {
  test("happy path: fresh credential reads /usages with the bearer", async () => {
    const path = await credentialFile(freshCredentials);
    const { calls, fetchFn } = jsonRequestLog();
    const transport = new KimiHttpUsageTransport({
      credentialsPath: path,
      fetchFn,
      now: () => NOW,
    });
    const result = await transport.readUsage(5_000);
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.kimi.com/coding/v1/usages");
    const headers = calls[0]?.init.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.authorization).toBe("Bearer live-token");

    const billing = accountBillingFromKimiUsage(
      (result as { response: unknown }).response,
      new Date(NOW).toISOString(),
    );
    // The shortest rate window (300 minutes) is the surfaced one: 1%.
    expect(billing.generalUtilization).toMatchObject({
      state: "known",
      value: 1,
    });
    expect(billing.creditsEnabled).toMatchObject({
      state: "unknown",
      reason: "surface-silent",
    });
    expect(billing.modelUtilization).toEqual({});
  });

  test("expired token refreshes with the CLI's exact grant, writes back, retries with the new bearer", async () => {
    const path = await credentialFile({
      ...freshCredentials,
      access_token: "stale-token",
      expires_at: Math.floor(NOW / 1_000) - 60,
      custom_field: "preserved",
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/api/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
            scope: "FEATURE_CODING",
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      }
      return usagesResponse();
    }) as typeof fetch;
    const transport = new KimiHttpUsageTransport({
      credentialsPath: path,
      fetchFn,
      now: () => NOW,
    });
    const result = await transport.readUsage(5_000);
    expect(result.status).toBe("ok");

    const [refreshCall, usageCall] = calls;
    expect(refreshCall?.url).toBe("https://auth.kimi.com/api/oauth/token");
    expect(refreshCall?.init.method).toBe("POST");
    const form = new URLSearchParams(String(refreshCall?.init.body));
    expect(form.get("client_id")).toBe("17e5f671-d194-4dfb-9706-5516cb48c098");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-token");

    // The write-back: rotated credential, recomputed expiry, 0600, and the
    // unrelated field preserved.
    const written = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(written.access_token).toBe("fresh-token");
    expect(written.refresh_token).toBe("rotated-refresh");
    expect(written.expires_at).toBe(Math.floor(NOW / 1_000) + 3600);
    expect(written.custom_field).toBe("preserved");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const headers = usageCall?.init.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.authorization).toBe("Bearer fresh-token");
  });

  test("refresh failure is an honest unknown, and the file is left alone", async () => {
    const path = await credentialFile({
      ...freshCredentials,
      expires_at: Math.floor(NOW / 1_000) - 60,
    });
    const before = await readFile(path, "utf8");
    const fetchFn = (async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as typeof fetch;
    const transport = new KimiHttpUsageTransport({
      credentialsPath: path,
      fetchFn,
      now: () => NOW,
    });
    const result = await transport.readUsage(5_000);
    expect(result.status).toBe("unavailable");
    expect((result as { reason: string }).reason).toContain("refresh");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("a missing credential file is unknown, never a crash", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-kimi-usage-missing-"));
    roots.push(home);
    const transport = new KimiHttpUsageTransport({
      credentialsPath: kimiCredentialsPath(home),
      fetchFn: jsonRequestLog().fetchFn,
      now: () => NOW,
    });
    const result = await transport.readUsage(5_000);
    expect(result.status).toBe("unavailable");
    expect((result as { reason: string }).reason).toContain(
      "no readable kimi credential file",
    );
  });

  test("a shape-changed payload is malformed, not a confident zero", async () => {
    const billing = accountBillingFromKimiUsage(
      { error: "surface changed" },
      new Date(NOW).toISOString(),
    );
    expect(billing.generalUtilization).toMatchObject({
      state: "unknown",
      reason: "malformed",
    });
    // A payload with windows whose numbers no longer parse is malformed too.
    const badNumbers = accountBillingFromKimiUsage(
      {
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "zero", used: "1" },
          },
        ],
      },
      new Date(NOW).toISOString(),
    );
    expect(badNumbers.generalUtilization).toMatchObject({
      state: "unknown",
      reason: "malformed",
    });
    // And a payload with no rate windows at all is field-absent, not 0%.
    const noWindows = accountBillingFromKimiUsage(
      { usage: USAGES_BODY.usage },
      new Date(NOW).toISOString(),
    );
    expect(noWindows.generalUtilization).toMatchObject({
      state: "unknown",
      reason: "field-absent",
    });
  });

  test("readAccountBilling rides the transport seam and never throws on a quiet surface", async () => {
    const ok = await readAccountBilling(
      "kimi",
      new Date(NOW).toISOString(),
      5_000,
      {
        kimi: {
          readUsage: async () => ({ status: "ok", response: USAGES_BODY }),
        },
      },
    );
    expect(ok?.generalUtilization).toMatchObject({ state: "known", value: 1 });

    const quiet = await readAccountBilling(
      "kimi",
      new Date(NOW).toISOString(),
      5_000,
      {
        kimi: {
          readUsage: async () => ({
            status: "unavailable",
            reason: "no readable kimi credential file",
          }),
        },
      },
    );
    expect(quiet?.generalUtilization).toMatchObject({
      state: "unknown",
      reason: "surface-silent",
    });
    expect(quiet?.creditsEnabled).toMatchObject({
      state: "unknown",
      reason: "surface-silent",
    });
  });
});

/**
 * The five-hour window arrives with `remaining` and no `used`.
 *
 * `KimiUsageWindowSchema` must therefore not require `used`. Requiring it fails
 * every payload that carries a rate window, and because the failure is at the
 * top-level object it takes the account's WEEKLY window down with it — a window
 * that parsed perfectly. `KimiQuotaProbe` then reports "no usable usage reading"
 * while the endpoint is answering, and Hive goes blind on a live provider with
 * no second source to fall back to (kimi has no push feed).
 *
 * The body below is the literal shape `GET /usages` returned from kimi 0.29.1
 * on 2026-07-26.
 */
describe("kimi /usages window counters", () => {
  const OBSERVED = "2026-07-26T16:00:00.000Z";
  const CAPTURED = {
    user: { membership: { level: "LEVEL_ADVANCED" } },
    // The account window reports `used`.
    usage: {
      limit: "100",
      used: "51",
      remaining: "49",
      resetTime: "2026-07-29T21:38:00.343103Z",
    },
    // The rate window reports only `remaining`.
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: {
          limit: "100",
          remaining: "100",
          resetTime: "2026-07-26T20:38:00.343103Z",
        },
      },
    ],
  };

  test("reads both windows when the rate window reports remaining instead of used", () => {
    const pools = readingsFromKimiUsages(CAPTURED, "default", OBSERVED);
    expect(pools).toHaveLength(1);
    expect(pools[0]?.weekly).toMatchObject({
      usedPct: 51,
      windowMinutes: 10_080,
    });
    // limit 100 − remaining 100 = 0 consumed. Arithmetic on two supplied
    // numbers, not an estimate.
    expect(pools[0]?.fiveHour).toMatchObject({
      usedPct: 0,
      windowMinutes: 300,
    });
    expect(pools[0]?.fiveHourMeterState).toBe("metered");
    expect(pools[0]?.weeklyMeterState).toBe("metered");
  });

  test("an unreadable rate window costs that window, never the readable weekly one", () => {
    const pools = readingsFromKimiUsages(
      {
        ...CAPTURED,
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_FURLONG" },
            detail: { junk: 1 },
          },
        ],
      },
      "default",
      OBSERVED,
    );
    expect(pools).toHaveLength(1);
    expect(pools[0]?.weekly).toMatchObject({ usedPct: 51 });
    // Unknown, not a confident zero.
    expect(pools[0]?.fiveHour).toBeNull();
    expect(pools[0]?.fiveHourMeterState).toBe("unknown");
  });

  test("a genuinely silent surface still yields no reading at all", () => {
    expect(
      readingsFromKimiUsages(
        { user: { membership: { level: "x" } } },
        "default",
        OBSERVED,
      ),
    ).toEqual([]);
    expect(
      readingsFromKimiUsages({ totally: "different" }, "default", OBSERVED),
    ).toEqual([]);
  });
});
