import { expect, test } from "bun:test";
import { stopHive } from "../../src/cli/control";

test("a timed-out stop kills only the exact daemon generation", async () => {
  let dead = false;
  const killed: number[] = [];
  let cleaned = false;
  const identity = {
    startToken: "daemon:100",
    executablePath: "/opt/hive/bin/hive",
  };

  await stopHive({
    readPid: () => 4242,
    liveness: async () => (dead ? "dead" : "live"),
    cleanup: () => {
      cleaned = true;
    },
    sleep: async () => {},
    timeoutMs: 50,
    log: () => {},
    invoker: {
      pid: 5000,
      ppid: 1,
      argv: ["stop", "--force"],
      cwd: "/repo",
      chain: [],
      agentWorktree: false,
    },
    force: true,
    requestStop: async () => ({ state: "stopping", killed: [] }),
    processIdentity: () => identity,
    killDaemon: (pid) => {
      killed.push(pid);
      dead = true;
    },
  });

  expect(killed).toEqual([4242]);
  expect(cleaned).toBe(true);
});
