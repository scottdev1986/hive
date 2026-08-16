import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProcessLiveness,
  probeProcessLiveness,
} from "../../src/adapters/process-liveness";
import {
  agentRowOwnershipLiveness,
  asOwnershipLiveness,
  listProcessesWithCwd,
  probeWorktreeOwnerProcessLiveness,
} from "../../src/adapters/worktree-owner-liveness";
import { PROCESS_TABLE_VISIBLE_MS, waitUntil } from "../support/wait-until";

describe("asOwnershipLiveness", () => {
  test("never collapses other-uid or unknown into dead", () => {
    expect(asOwnershipLiveness("live")).toBe("live");
    expect(asOwnershipLiveness("other-uid")).toBe("live");
    expect(asOwnershipLiveness("dead")).toBe("dead");
    expect(asOwnershipLiveness("unknown")).toBe("unknown");
  });
});

describe("agentRowOwnershipLiveness", () => {
  const isLive = (agent: { status: string }) =>
    agent.status !== "done" && agent.status !== "dead";

  test("a missing row is unknown, never dead", () => {
    expect(agentRowOwnershipLiveness(undefined, isLive)).toBe("unknown");
  });

  test("a non-terminal status is live", () => {
    expect(agentRowOwnershipLiveness({ status: "working" }, isLive)).toBe(
      "live",
    );
    expect(agentRowOwnershipLiveness({ status: "spawning" }, isLive)).toBe(
      "live",
    );
  });

  test("a terminal status is dead", () => {
    expect(agentRowOwnershipLiveness({ status: "dead" }, isLive)).toBe("dead");
    expect(agentRowOwnershipLiveness({ status: "done" }, isLive)).toBe("dead");
  });
});

describe("probeWorktreeOwnerProcessLiveness", () => {
  test("positive-control failure returns unknown, never dead", async () => {
    const probe = (pid: number): ProcessLiveness =>
      pid === process.pid ? "unknown" : "dead";
    expect(
      await probeWorktreeOwnerProcessLiveness("/tmp", probe, async () => ({
        state: "listed",
        pids: [],
      })),
    ).toBe("unknown");
  });

  test("holder list failure returns unknown", async () => {
    expect(
      await probeWorktreeOwnerProcessLiveness(
        "/tmp",
        probeProcessLiveness,
        async () => ({ state: "unknown" }),
      ),
    ).toBe("unknown");
  });

  test("empty holder list after a live positive control is dead", async () => {
    expect(
      await probeWorktreeOwnerProcessLiveness(
        "/tmp",
        probeProcessLiveness,
        async () => ({ state: "listed", pids: [] }),
      ),
    ).toBe("dead");
  });

  test("a live holder process is live", async () => {
    expect(
      await probeWorktreeOwnerProcessLiveness(
        "/tmp",
        (pid) => (pid === 4242 ? "live" : probeProcessLiveness(pid)),
        async () => ({ state: "listed", pids: [4242] }),
      ),
    ).toBe("live");
  });

  test("other-uid holder is treated as live", async () => {
    expect(
      await probeWorktreeOwnerProcessLiveness(
        "/tmp",
        (pid) => (pid === 4242 ? "other-uid" : probeProcessLiveness(pid)),
        async () => ({ state: "listed", pids: [4242] }),
      ),
    ).toBe("live");
  });

  test("unknown holder with no live holder is unknown", async () => {
    expect(
      await probeWorktreeOwnerProcessLiveness(
        "/tmp",
        (pid) => (pid === 4242 ? "unknown" : probeProcessLiveness(pid)),
        async () => ({ state: "listed", pids: [4242] }),
      ),
    ).toBe("unknown");
  });

  test("dead holders only is dead", async () => {
    expect(
      await probeWorktreeOwnerProcessLiveness(
        "/tmp",
        (pid) => (pid === 4242 ? "dead" : probeProcessLiveness(pid)),
        async () => ({ state: "listed", pids: [4242] }),
      ),
    ).toBe("dead");
  });
});

describe("listProcessesWithCwd", () => {
  let tempDir = "";

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hive-lsof-cwd-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("an empty directory with no cwd holders lists zero pids", async () => {
    const result = await listProcessesWithCwd(tempDir);
    expect(result).toEqual({ state: "listed", pids: [] });
  });

  test("a live process holding the directory as cwd is listed", async () => {
    const sleeper = Bun.spawn(["sleep", "60"], {
      cwd: tempDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      let listed: number[] = [];
      await waitUntil(
        async () => {
          const result = await listProcessesWithCwd(tempDir);
          if (result.state === "listed" && result.pids.includes(sleeper.pid)) {
            listed = result.pids;
            return true;
          }
          return false;
        },
        {
          deadlineMs: PROCESS_TABLE_VISIBLE_MS,
          label: `process ${sleeper.pid} to appear as a cwd holder of ${tempDir}`,
        },
      );
      expect(listed).toContain(sleeper.pid);
    } finally {
      sleeper.kill();
      await sleeper.exited.catch(() => undefined);
    }
  });

  test("a missing path is unknown, not an empty holder list", async () => {
    const result = await listProcessesWithCwd(
      join(tempDir, "does-not-exist-anywhere"),
    );
    expect(result).toEqual({ state: "unknown" });
  });
});
