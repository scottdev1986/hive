import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStatuslineReport,
  renderStatusLine,
  runStatusline,
} from "./statusline";
import { readContextObservation } from "../daemon/context-window";

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

describe("runStatusline context window", () => {
  const noPost = async (): Promise<Response> => new Response("{}");

  // The denominator the daemon cannot get anywhere else. Claude Code resolves
  // the window against the account's plan (200k, or 1M on Max/Team/Enterprise)
  // and hands it to this command; nothing else on the machine knows it.
  test("records the window Claude Code reports, for the telemetry sweep", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-sl-"));
    const worktree = "/repo/.hive/worktrees/zoe";
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      await runStatusline(
        "zoe",
        41_000,
        JSON.stringify({
          ...payload,
          workspace: { current_dir: worktree },
          context_window: {
            context_window_size: 1_000_000,
            used_percentage: 22,
          },
        }),
        noPost,
      );
      expect(readContextObservation(worktree, home)).toMatchObject({
        contextWindow: 1_000_000,
        usedPct: 22,
      });
    } finally {
      if (previous === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previous;
    }
  });

  // The window and the quota ride in on the same payload but are independent:
  // an API-key account, or any session before its first response, has no
  // rate_limits at all, and losing the window with them would leave the daemon
  // with no denominator and force it back to guessing.
  test("records the window even when the payload carries no rate limits", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-sl-"));
    const worktree = "/repo/.hive/worktrees/lena";
    const previous = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    try {
      await runStatusline(
        "lena",
        41_000,
        JSON.stringify({
          context_window: { context_window_size: 200_000 },
        }),
        noPost,
        // No workspace in the payload: the command runs in the session's
        // worktree, so its own cwd is the correct fallback.
        worktree,
      );
      expect(readContextObservation(worktree, home)).toMatchObject({
        contextWindow: 200_000,
        usedPct: null,
      });
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
