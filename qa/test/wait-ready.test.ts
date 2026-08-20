// Unit tests for qa/wait-ready.ts. No QA daemon: each test plants a fake
// daemon.port (or withholds it) and a fake liveness probe so the wait can
// prove the three outcomes — ready, daemon died, bound expired — without a rig.
import { describe, expect, test } from "bun:test";
import { waitForDaemonPort } from "../wait-ready";

describe("waitForDaemonPort", () => {
  test("returns the home that first presents a usable port", async () => {
    const ports = new Map<string, number | null>([
      ["/tmp/qa/home", null],
      ["/tmp/qa/home/instances/repo-x", 43123],
    ]);
    const result = await waitForDaemonPort({
      homes: ["/tmp/qa/home", "/tmp/qa/home/instances/repo-x"],
      daemonPid: 1,
      timeoutMs: 1_000,
      sleep: async () => undefined,
      isAlive: () => true,
      readPort: (home) => ports.get(home) ?? null,
    });
    expect(result).toEqual({
      ok: true,
      home: "/tmp/qa/home/instances/repo-x",
      port: 43123,
    });
  });

  test("NO MEASUREMENT when the daemon exits before the port file appears", async () => {
    const result = await waitForDaemonPort({
      homes: ["/tmp/qa/home"],
      daemonPid: 99,
      timeoutMs: 1_000,
      sleep: async () => undefined,
      isAlive: () => false,
      readPort: () => null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toContain("daemon pid 99 exited before daemon.port");
  });

  test("NO MEASUREMENT when the bound expires while the daemon is still alive", async () => {
    let now = 0;
    const result = await waitForDaemonPort({
      homes: ["/tmp/qa/home"],
      daemonPid: 7,
      timeoutMs: 10,
      sleep: async (ms) => {
        now += ms;
      },
      isAlive: () => true,
      readPort: () => null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toContain("no daemon.port under /tmp/qa/home within");
    expect(now).toBeGreaterThan(0);
  });

  test("a port that appears after one empty poll is still ready", async () => {
    let polls = 0;
    const result = await waitForDaemonPort({
      homes: ["/tmp/qa/home"],
      daemonPid: 3,
      timeoutMs: 1_000,
      sleep: async () => undefined,
      isAlive: () => true,
      readPort: () => {
        polls += 1;
        return polls >= 2 ? 18080 : null;
      },
    });
    expect(result).toEqual({ ok: true, home: "/tmp/qa/home", port: 18080 });
    expect(polls).toBe(2);
  });
});
