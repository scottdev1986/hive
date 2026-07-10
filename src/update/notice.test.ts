import { describe, expect, test } from "bun:test";
import type { UpdateCheck } from "./check";
import { plain, renderStartNotice, renderUpdateNotice } from "./notice";

const available = (over: Partial<Extract<UpdateCheck, { state: "update-available" }>> = {}) => ({
  state: "update-available" as const,
  current: "0.0.4",
  latest: "0.0.7",
  securityCritical: false,
  stale: false,
  ...over,
});

const start = (check: UpdateCheck, over: Record<string, unknown> = {}): string =>
  plain(renderStartNotice({ check, installMethod: "native", ...over }));

describe("hive init session notice", () => {
  test("names the current and the latest version and the command", () => {
    expect(start(available())).toEqual(
      "hive 0.0.7 available (you have 0.0.4) — run hive update",
    );
  });

  test("says up to date only when it actually checked", () => {
    expect(start({ state: "up-to-date", current: "0.0.7", latest: "0.0.7" }))
      .toEqual("hive 0.0.7 is the latest release");
  });

  test("a failed check says it could not check, never that you are up to date", () => {
    const line = start({
      state: "unavailable",
      current: "0.0.4",
      reason: "network unreachable",
    });
    expect(line).toEqual(
      "hive 0.0.4 — could not check for updates (network unreachable)",
    );
    expect(line).not.toContain("latest");
    expect(line).not.toContain("up to date");
  });

  test("a source checkout never claims a release version", () => {
    expect(start({ state: "dev-build", current: "0.0.0-dev" }))
      .toEqual("hive 0.0.0-dev (source checkout) — update checks are disabled");
  });

  test("disabled checks name the variable that disabled them", () => {
    expect(start({ state: "disabled", current: "0.0.4", reason: "HIVE_NO_UPDATE_CHECK=1" }))
      .toEqual("hive 0.0.4 — update checks are disabled (HIVE_NO_UPDATE_CHECK=1)");
  });

  test("a Homebrew install is told the Homebrew command, never `hive update`", () => {
    const line = start(available(), { installMethod: "homebrew" });
    expect(line).toEqual("hive 0.0.7 available (you have 0.0.4) — run brew upgrade hive");
    expect(line).not.toContain("hive update");
  });

  test("a staged update says it is downloaded and waits for the team", () => {
    expect(start(available(), { staged: "0.0.7", liveAgents: 3 })).toEqual(
      "hive 0.0.7 downloaded — activates when the current team finishes, or run hive update now",
    );
  });

  test("a staged update with an idle team just asks to activate", () => {
    expect(start(available(), { staged: "0.0.7", liveAgents: 0 })).toEqual(
      "hive 0.0.7 downloaded — run hive update to activate",
    );
  });

  test("a security release says so", () => {
    expect(start(available({ securityCritical: true }))).toEqual(
      "hive 0.0.7 available — security release, run hive update",
    );
  });

  test("a security release is yellow; an ordinary one is dim", () => {
    const security = renderStartNotice({
      check: available({ securityCritical: true }),
      installMethod: "native",
    });
    const ordinary = renderStartNotice({ check: available(), installMethod: "native" });
    expect(security).toStartWith("\u001B[33m");
    expect(ordinary).toStartWith("\u001B[2m");
  });

  test("an answer from a stale cache admits it was offline", () => {
    expect(start(available({ stale: true }))).toContain("(checked offline)");
  });
});

const passive = (over: Record<string, unknown> = {}): string | null => {
  const line = renderUpdateNotice({
    check: available(),
    installMethod: "native",
    cache: null,
    now: 1_000_000,
    interactive: true,
    ...over,
  });
  return line === null ? null : plain(line);
};

describe("passive notice", () => {
  test("prints one actionable line", () => {
    expect(passive()).toEqual("hive 0.0.7 available (you have 0.0.4) — run hive update");
  });

  test("is silent when there is nothing to do", () => {
    expect(passive({ check: { state: "up-to-date", current: "0.0.7", latest: "0.0.7" } }))
      .toEqual(null);
    expect(passive({ check: { state: "unavailable", current: "0.0.4", reason: "offline" } }))
      .toEqual(null);
  });

  test("is silent when stderr is not a terminal", () => {
    expect(passive({ interactive: false })).toEqual(null);
  });

  test("is silent for a version the user skipped", () => {
    const cache = {
      latestVersion: "0.0.7",
      checkedAt: 0,
      securityCritical: false,
      dismissedVersion: "0.0.7",
    };
    expect(passive({ cache })).toEqual(null);
  });

  test("speaks again when a newer version than the skipped one lands", () => {
    const cache = {
      latestVersion: "0.0.8",
      checkedAt: 0,
      securityCritical: false,
      dismissedVersion: "0.0.7",
    };
    expect(passive({ cache, check: available({ latest: "0.0.8" }) }))
      .toEqual("hive 0.0.8 available (you have 0.0.4) — run hive update");
  });

  test("is silent inside the 24 hour rate limit", () => {
    expect(passive({ now: 1_000_000, lastNoticeAt: 1_000_000 - 60_000 })).toEqual(null);
  });

  test("speaks once the rate limit expires", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(passive({ now: day + 2, lastNoticeAt: 1 })).not.toEqual(null);
  });

  test("a security release ignores both the skip list and the rate limit", () => {
    const cache = {
      latestVersion: "0.0.7",
      checkedAt: 0,
      securityCritical: true,
      dismissedVersion: "0.0.7",
    };
    const line = passive({
      cache,
      check: available({ securityCritical: true }),
      lastNoticeAt: 1_000_000,
    });
    expect(line).toEqual("hive 0.0.7 available — security release, run hive update");
  });

  test("even a security release stays silent on a non-terminal", () => {
    // Hook output and CI logs are not places to shout.
    expect(passive({
      check: available({ securityCritical: true }),
      interactive: false,
    })).toEqual(null);
  });
});
