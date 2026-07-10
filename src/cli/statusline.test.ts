import { describe, expect, test } from "bun:test";
import {
  parseStatuslineReport,
  renderStatusLine,
  runStatusline,
} from "./statusline";

const observedAt = "2026-07-09T12:00:00.000Z";

// The exact shape Claude Code pipes to a statusLine command, per its own
// documented JSON schema: rate_limits.{five_hour,seven_day}.{used_percentage,
// resets_at}, with resets_at in Unix epoch seconds.
const payload = {
  model: { display_name: "Fable 5" },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1_738_425_600 },
    seven_day: { used_percentage: 41.2, resets_at: 1_738_857_600 },
  },
};

describe("parseStatuslineReport", () => {
  test("extracts both subscriber windows and converts epoch seconds", () => {
    expect(parseStatuslineReport("maya", payload, observedAt)).toEqual({
      agent: "maya",
      fiveHour: {
        usedPct: 23.5,
        resetsAt: new Date(1_738_425_600_000).toISOString(),
      },
      sevenDay: {
        usedPct: 41.2,
        resetsAt: new Date(1_738_857_600_000).toISOString(),
      },
      observedAt,
    });
  });

  test("accepts one window when the other is absent", () => {
    const report = parseStatuslineReport(
      "maya",
      { rate_limits: { five_hour: { used_percentage: 10 } } },
      observedAt,
    );
    expect(report?.fiveHour).toEqual({ usedPct: 10, resetsAt: null });
    expect(report?.sevenDay).toBeUndefined();
  });

  test("returns null for a session with no subscriber rate limits", () => {
    // API-key accounts, third-party providers, and any session before its
    // first API response simply omit the block.
    expect(parseStatuslineReport("maya", { model: {} }, observedAt)).toBeNull();
    expect(parseStatuslineReport("maya", {}, observedAt)).toBeNull();
    expect(parseStatuslineReport("maya", null, observedAt)).toBeNull();
    expect(
      parseStatuslineReport("maya", { rate_limits: {} }, observedAt),
    ).toBeNull();
  });

  test("ignores a malformed window instead of inventing a number", () => {
    expect(
      parseStatuslineReport(
        "maya",
        { rate_limits: { five_hour: { used_percentage: "lots" } } },
        observedAt,
      ),
    ).toBeNull();
  });

  test("clamps an out-of-range percentage", () => {
    const report = parseStatuslineReport(
      "maya",
      { rate_limits: { five_hour: { used_percentage: 140 } } },
      observedAt,
    );
    expect(report?.fiveHour?.usedPct).toBe(100);
  });
});

describe("renderStatusLine", () => {
  test("shows both windows when known", () => {
    const report = parseStatuslineReport("maya", payload, observedAt);
    expect(renderStatusLine("maya", report)).toBe("🐝 maya · 5h 24% · 7d 41%");
  });

  test("shows just the agent when no quota is reported", () => {
    expect(renderStatusLine("maya", null)).toBe("🐝 maya");
  });
});

describe("runStatusline", () => {
  test("posts the report to the daemon and renders the line", async () => {
    const posted: unknown[] = [];
    const line = await runStatusline(
      "maya",
      41_000,
      JSON.stringify(payload),
      async (_input, init) => {
        posted.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      },
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ agent: "maya" });
    expect(line).toContain("5h 24%");
  });

  test("never posts and never throws when the session has no rate limits", async () => {
    let calls = 0;
    const line = await runStatusline(
      "maya",
      41_000,
      JSON.stringify({ model: {} }),
      async () => {
        calls += 1;
        return new Response("{}");
      },
    );
    expect(calls).toBe(0);
    expect(line).toBe("🐝 maya");
  });

  test("survives malformed stdin and an unreachable daemon", async () => {
    expect(await runStatusline("maya", 41_000, "not json")).toBe("🐝 maya");
    const line = await runStatusline(
      "maya",
      41_000,
      JSON.stringify(payload),
      async () => {
        throw new Error("connection refused");
      },
    );
    // A failed post still renders; a missed observation is only a stale one.
    expect(line).toContain("5h 24%");
  });
});
