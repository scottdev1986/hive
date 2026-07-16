import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStatuslineReport,
  renderStatusLine,
  runStatusline,
  statuslineErrorPath,
} from "./statusline";

const observedAt = "2026-07-09T12:00:00.000Z";

// The exact shape Claude Code pipes to a statusLine command, per its own
// documented JSON schema: rate_limits.{five_hour,seven_day}.{used_percentage,
// resets_at}, with resets_at in Unix epoch seconds.
const payload = {
  model: { display_name: "Fable 5" },
  effort: { level: "high" },
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
      effort: "high",
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

describe("the one parse", () => {
  // Everything below is measured by Claude Code and handed to us on the same
  // payload. None of it is derivable elsewhere in Hive, which is why there is
  // exactly one parse -- and why it must not throw any of it away.

  // The denominator. Claude Code resolves it against the account plan (200k, or
  // 1M where the plan upgrades it) and this is the only place Hive is ever told.
  test("takes the real window and Claude Code s own percentage", () => {
    expect(
      parseStatuslineReport("zoe", {
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 22,
          total_input_tokens: 223_652,
        },
      }, observedAt),
    ).toEqual({
      agent: "zoe",
      contextWindow: 1_000_000,
      contextUsedPct: 22,
      observedAt,
    });
  });

  // THE REGRESSION. The quota block and the context window are independent
  // facts riding the same payload. An API-key account, a third-party provider,
  // and any session before its first API response all have NO rate_limits --
  // and gating the report on them threw the window away for exactly those
  // sessions, silently, with no error anyone would ever see. A payload carrying
  // independent facts must never be discarded wholesale because one is missing.
  test("reports the window even when the payload carries no rate limits", () => {
    const report = parseStatuslineReport("lena", {
      context_window: { context_window_size: 1_000_000, used_percentage: 27 },
    }, observedAt);

    expect(report).not.toEqual(null);
    expect(report?.contextWindow).toEqual(1_000_000);
    expect(report?.contextUsedPct).toEqual(27);
    expect(report?.fiveHour).toBeUndefined();
  });

  // ...and the same in the other direction: quota with no window still reports.
  test("reports the quota block even when the payload carries no window", () => {
    const report = parseStatuslineReport("maya", payload, observedAt);
    expect(report?.fiveHour?.usedPct).toEqual(23.5);
    expect(report?.contextWindow).toBeUndefined();
  });

  test("captures effective effort without quota or context", () => {
    expect(
      parseStatuslineReport("maya", { effort: { level: "low" } }, observedAt),
    ).toEqual({ agent: "maya", effort: "low", observedAt });
  });

  test("rejects malformed effort instead of forwarding argv-shaped input", () => {
    expect(
      parseStatuslineReport("maya", { effort: { level: "HIGH!" } }, observedAt),
    ).toBeNull();
  });

  // A window we were not told is a window we do not know. Substituting a
  // plausible 200_000 is the bug: it reported live agents at ~22% of a 1M
  // window as 100% full, and every decision downstream was made against that.
  test("never defaults a window it was not given", () => {
    for (
      const bad of [
        { context_window: {} },
        { context_window: { context_window_size: 0 } },
        { context_window: { context_window_size: -1 } },
        { context_window: { context_window_size: "1000000" } },
      ]
    ) {
      const report = parseStatuslineReport("zoe", bad, observedAt);
      expect(report?.contextWindow).toBeUndefined();
      expect(report?.contextUsedPct).toBeUndefined();
    }
  });

  test("keeps the window when the payload carries no percentage", () => {
    const report = parseStatuslineReport("zoe", {
      context_window: { context_window_size: 200_000 },
    }, observedAt);
    expect(report?.contextWindow).toEqual(200_000);
    expect(report?.contextUsedPct).toBeUndefined();
  });

  // Null only when the payload said nothing usable at all.
  test("reports nothing when it measured nothing", () => {
    expect(parseStatuslineReport("zoe", { model: {} }, observedAt)).toEqual(null);
    expect(parseStatuslineReport("zoe", {}, observedAt)).toEqual(null);
    expect(parseStatuslineReport("zoe", null, observedAt)).toEqual(null);
  });
});

// The catch in runStatusline must stay silent to the agent's terminal — it
// renders on every keystroke. But it used to be silent EVERYWHERE: a hard
// ReferenceError in the parse was indistinguishable from "nothing to report
// this render", so the transport was dead and nothing anywhere said so. Silent
// to the terminal is right; silent to us is how the next one hides too.
describe("a swallowed failure still leaves a trace", () => {
  test("records the error where a human can find it, and still renders", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-sl-err-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      const line = await runStatusline("maya", 41_000, JSON.stringify(payload), () => {
        throw new Error("daemon exploded");
      });

      // The agent's terminal sees a clean status line, never the exception.
      expect(line).toBe("🐝 maya · 5h 24% · 7d 41%");

      const trace = JSON.parse(readFileSync(statuslineErrorPath(), "utf8"));
      expect(trace).toMatchObject({
        agent: "maya",
        error: "daemon exploded",
        count: 1,
      });
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
    }
  });

  test("an HTTP rejection reaches the trace while the rendered line stays clean", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-sl-err-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      // A 500 used to present as delivered — the transport never read
      // response.ok, so the observation was lost with a clean diagnostic.
      const line = await runStatusline(
        "maya",
        41_000,
        JSON.stringify(payload),
        () => Promise.resolve(new Response("boom", { status: 500 })),
      );

      expect(line).toBe("🐝 maya · 5h 24% · 7d 41%");
      const trace = JSON.parse(readFileSync(statuslineErrorPath(), "utf8"));
      expect(trace).toMatchObject({
        agent: "maya",
        error: "statusline report rejected: HTTP 500",
        count: 1,
      });
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
    }
  });

  // A status line that fails once fails on every keystroke. The trace counts;
  // it must never append, or it would fill the disk with the same error.
  test("counts repeats instead of growing without bound", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-sl-err-"));
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      const boom = () => {
        throw new Error("still broken");
      };
      for (let i = 0; i < 3; i += 1) {
        await runStatusline("maya", 41_000, JSON.stringify(payload), boom);
      }
      const trace = JSON.parse(readFileSync(statuslineErrorPath(), "utf8"));
      expect(trace.count).toBe(3);
      expect(trace.firstAt).not.toBeUndefined();
      expect(trace.lastAt).not.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
    }
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
