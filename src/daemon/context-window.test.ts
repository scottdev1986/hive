import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseContextObservation,
  payloadWorktree,
  readContextObservation,
  writeContextObservation,
} from "./context-window";

const AT = "2026-07-11T00:00:00.000Z";
const hiveHome = (): string => mkdtempSync(join(tmpdir(), "hive-ctx-"));

describe("parseContextObservation", () => {
  // The shape Claude Code's statusLine command receives on stdin.
  test("takes the window and percentage Claude Code reports", () => {
    expect(
      parseContextObservation({
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 22,
          total_input_tokens: 223_652,
        },
      }, AT),
    ).toEqual({ contextWindow: 1_000_000, usedPct: 22, observedAt: AT });
  });

  test("keeps the window when the payload carries no percentage", () => {
    expect(
      parseContextObservation(
        { context_window: { context_window_size: 200_000 } },
        AT,
      ),
    ).toEqual({ contextWindow: 200_000, usedPct: null, observedAt: AT });
  });

  // The load-bearing failure mode. If Claude Code ever stops sending the block,
  // the honest result is "no observation" — which the telemetry reader turns
  // into an unknown percentage. Defaulting to 200k here is what produced the
  // 5x-inflated readings this module was written to kill, so a missing window
  // must never become a present one.
  test("returns null rather than defaulting a window it was not given", () => {
    for (
      const payload of [
        {},
        null,
        "not an object",
        { context_window: {} },
        { context_window: { context_window_size: 0 } },
        { context_window: { context_window_size: -1 } },
        { context_window: { context_window_size: "1000000" } },
        { rate_limits: { five_hour: { used_percentage: 40 } } },
      ]
    ) {
      expect(parseContextObservation(payload, AT)).toEqual(null);
    }
  });

  test("clamps a percentage outside 0-100", () => {
    expect(
      parseContextObservation(
        { context_window: { context_window_size: 1_000, used_percentage: 140 } },
        AT,
      )?.usedPct,
    ).toEqual(100);
  });
});

describe("payloadWorktree", () => {
  test("prefers the workspace the payload names, then cwd, then the fallback", () => {
    expect(
      payloadWorktree({ workspace: { current_dir: "/repo/wt/zoe" } }, "/fallback"),
    ).toEqual("/repo/wt/zoe");
    expect(payloadWorktree({ cwd: "/repo/wt/lena" }, "/fallback"))
      .toEqual("/repo/wt/lena");
    expect(payloadWorktree({}, "/fallback")).toEqual("/fallback");
    expect(payloadWorktree(null, "/fallback")).toEqual("/fallback");
  });
});

describe("observation round-trip", () => {
  test("what statusline writes is what the telemetry sweep reads", () => {
    const home = hiveHome();
    const worktree = "/repo/.hive/worktrees/zoe";
    expect(readContextObservation(worktree, home)).toEqual(null);

    writeContextObservation(
      worktree,
      { contextWindow: 1_000_000, usedPct: 22, observedAt: AT },
      home,
    );
    expect(readContextObservation(worktree, home)).toEqual({
      contextWindow: 1_000_000,
      usedPct: 22,
      observedAt: AT,
    });
  });

  test("one file per worktree: agents do not read each other's window", () => {
    const home = hiveHome();
    writeContextObservation(
      "/repo/.hive/worktrees/zoe",
      { contextWindow: 1_000_000, usedPct: 22, observedAt: AT },
      home,
    );
    expect(readContextObservation("/repo/.hive/worktrees/lena", home))
      .toEqual(null);
  });

  test("a corrupt or truncated file reads as unknown, never as zero", () => {
    const home = hiveHome();
    const worktree = "/repo/.hive/worktrees/zoe";
    writeContextObservation(
      worktree,
      { contextWindow: 1_000_000, usedPct: 22, observedAt: AT },
      home,
    );
    Bun.write(
      join(home, "context", "-repo--hive-worktrees-zoe.json"),
      "{ truncated",
    );
    expect(readContextObservation(worktree, home)).toEqual(null);
  });

  test("a write to an unwritable home loses the observation, not the render", () => {
    expect(() =>
      writeContextObservation(
        "/repo/wt/zoe",
        { contextWindow: 1_000_000, usedPct: 22, observedAt: AT },
        "/proc/nonexistent/cannot-create",
      )
    ).not.toThrow();
  });
});
