import { describe, expect, test } from "bun:test";
import {
  parseProcessTable,
  runPs,
} from "../../src/daemon/resource-management/resources";
import { PROCESS_TABLE_VISIBLE_MS, waitUntil } from "./wait-until";

describe("waitUntil", () => {
  test("a timeout names the deadline and what it was waiting for", async () => {
    const started = Date.now();
    await expect(
      waitUntil(() => false, {
        deadlineMs: 80,
        label: "a child that was never forked",
      }),
    ).rejects.toThrow(
      "timed out after 80ms waiting for a child that was never forked",
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  test("returns when the condition becomes true", async () => {
    let ready = false;
    const flip = setTimeout(() => {
      ready = true;
    }, 20);
    try {
      await waitUntil(() => ready, {
        deadlineMs: 500,
        label: "the flipped flag",
      });
    } finally {
      clearTimeout(flip);
    }
  });

  test("a process that never forks a child times out with the named reason", async () => {
    const parent = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await expect(
        waitUntil(
          async () =>
            parseProcessTable(await runPs()).some(
              (entry) => entry.ppid === parent.pid,
            ),
          {
            deadlineMs: 80,
            label: `process ${parent.pid} to start a child`,
          },
        ),
      ).rejects.toThrow(
        `timed out after 80ms waiting for process ${parent.pid} to start a child`,
      );
    } finally {
      parent.kill("SIGKILL");
      await parent.exited;
    }
  });

  test("a sleep-and-wait grandchild becomes visible before the deadline", async () => {
    const shell = Bun.spawn(["sh", "-c", "sleep 30 & wait"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    let childPid: number | undefined;
    try {
      await waitUntil(
        async () => {
          childPid = parseProcessTable(await runPs()).find(
            (entry) => entry.ppid === shell.pid,
          )?.pid;
          return childPid !== undefined;
        },
        {
          deadlineMs: PROCESS_TABLE_VISIBLE_MS,
          label: `process ${shell.pid} to start its child`,
        },
      );
      expect(childPid).toBeDefined();
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      shell.kill("SIGKILL");
      await shell.exited;
    }
  });
});
