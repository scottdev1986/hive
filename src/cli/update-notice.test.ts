import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plain } from "../update/notice";
import type { UpdateCheck } from "../update/check";
import {
  readLastNoticeAt,
  resolveUpdateNotice,
  wantsUpdateNotice,
  withTrailingUpdateNotice,
  writeLastNoticeAt,
} from "./update-notice";

const updateAvailable: UpdateCheck = {
  state: "update-available",
  current: "0.0.1",
  latest: "0.0.2",
  securityCritical: false,
  stale: false,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("wantsUpdateNotice", () => {
  const argv = (command?: string): string[] =>
    command === undefined ? ["bun", "hive"] : ["bun", "hive", command];

  test("allows user-facing commands on a TTY outside CI", () => {
    for (const command of ["status", "quota", "memory", "watch", "stop"]) {
      expect(wantsUpdateNotice(argv(command), {}, true)).toEqual(true);
    }
  });

  test("suppresses when stdout is not a TTY", () => {
    expect(wantsUpdateNotice(argv("status"), {}, false)).toEqual(false);
  });

  test("suppresses under CI, even CI=false — presence is the convention", () => {
    expect(wantsUpdateNotice(argv("status"), { CI: "true" }, true)).toEqual(false);
    expect(wantsUpdateNotice(argv("status"), { CI: "" }, true)).toEqual(false);
  });

  test("never decorates session boundaries, the updater, or machine surfaces", () => {
    for (
      const command of [
        undefined, // bare `hive` — startSession already prints the start notice
        "init",
        "claude",
        "codex",
        "update",
        "event",
        "statusline",
        "credential",
        "statusline",
        "daemon",
        "workspace-feed",
        "workspace-orchestrator",
      ]
    ) {
      expect(wantsUpdateNotice(argv(command), {}, true)).toEqual(false);
    }
  });
});

describe("withTrailingUpdateNotice", () => {
  test("prints after the command's own output, even when the check wins the race", async () => {
    const order: string[] = [];
    const home = await mkdtemp(join(tmpdir(), "hive-notice-"));
    try {
      await withTrailingUpdateNotice(
        true,
        async () => {
          // The check below resolves instantly; the command takes longer. The
          // notice must still trail the command.
          await sleep(20);
          order.push("command");
        },
        {
          check: async () => updateAvailable,
          statePath: join(home, "update-notice.json"),
        },
        (line) => order.push(`notice:${plain(line)}`),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    expect(order).toHaveLength(2);
    expect(order[0]).toEqual("command");
    expect(order[1]).toContain("notice:hive 0.0.2 available");
  });

  test("a failed command surfaces its error, not a version advertisement", async () => {
    const written: string[] = [];
    await expect(withTrailingUpdateNotice(
      true,
      async () => {
        throw new Error("command failed");
      },
      { check: async () => updateAvailable, statePath: "/nonexistent/x.json" },
      (line) => written.push(line),
    )).rejects.toThrow("command failed");
    expect(written).toEqual([]);
  });

  test("a failing check is invisible and the command result is untouched", async () => {
    const written: string[] = [];
    const result = await withTrailingUpdateNotice(
      true,
      async () => "command-result",
      {
        check: async () => {
          throw new Error("network is down");
        },
      },
      (line) => written.push(line),
    );
    expect(result).toEqual("command-result");
    expect(written).toEqual([]);
  });

  test("disabled means the check never even starts", async () => {
    let checked = false;
    const result = await withTrailingUpdateNotice(
      false,
      async () => 42,
      {
        check: async () => {
          checked = true;
          return updateAvailable;
        },
      },
      () => {
        throw new Error("must not write");
      },
    );
    expect(result).toEqual(42);
    expect(checked).toEqual(false);
  });
});

describe("24-hour display suppression", () => {
  test("shows once, stays silent for a day, then shows again", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-notice-24h-"));
    const statePath = join(home, "update-notice.json");
    const start = 1_750_000_000_000;
    const HOUR = 60 * 60 * 1000;
    const at = (now: number): Promise<string | null> =>
      resolveUpdateNotice({
        check: async () => updateAvailable,
        now: () => now,
        statePath,
      });
    try {
      const first = await at(start);
      expect(plain(first ?? "")).toContain("hive 0.0.2 available");
      expect(readLastNoticeAt(statePath)).toEqual(start);

      // One hour later: rate-limited, and the marker is not refreshed.
      expect(await at(start + HOUR)).toBeNull();
      expect(readLastNoticeAt(statePath)).toEqual(start);

      // Past 24h: shown again, marker rolls forward.
      const again = await at(start + 25 * HOUR);
      expect(plain(again ?? "")).toContain("hive 0.0.2 available");
      expect(readLastNoticeAt(statePath)).toEqual(start + 25 * HOUR);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a security release bypasses the rate limit", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-notice-security-"));
    const statePath = join(home, "update-notice.json");
    const security: UpdateCheck = { ...updateAvailable, securityCritical: true };
    try {
      writeLastNoticeAt(1_750_000_000_000, statePath);
      const line = await resolveUpdateNotice({
        check: async () => security,
        now: () => 1_750_000_000_000 + 60_000,
        statePath,
      });
      expect(plain(line ?? "")).toContain("security release");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an unreadable marker file degrades to showing, not crashing", async () => {
    expect(readLastNoticeAt("/nonexistent/notice.json")).toBeNull();
  });
});
