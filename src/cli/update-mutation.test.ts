import { describe, expect, test } from "bun:test";
import { activateStagedUpdate, rollbackWhenIdle } from "./update";

const blocker = {
  instance: {
    name: "review",
    home: "/tmp/hive/review",
    instanceId: "instance-review",
    port: 4318,
    pid: 1234,
    running: true,
  },
  liveAgents: ["new-agent"],
};

describe("machine mutation leases in update commands", () => {
  test("update holds its lease from the final checks through activation", async () => {
    const order: string[] = [];
    let held = false;

    await activateStagedUpdate("0.0.8", {
      acquireLease: async (purpose) => {
        order.push(`acquire:${purpose}`);
        held = true;
        return {
          release: () => {
            held = false;
            order.push("release");
          },
        };
      },
      blockers: async () => {
        expect(held).toBe(true);
        order.push("teams");
        return [];
      },
      inspectDaemon: async () => {
        expect(held).toBe(true);
        order.push("daemon");
        return { state: "absent" };
      },
      activate: async () => {
        expect(held).toBe(true);
        order.push("activate");
        return { activated: true, version: "0.0.8", previous: "0.0.7" };
      },
      ensureBinLink: async () => {
        expect(held).toBe(true);
        order.push("bin-link");
      },
      stopStaleDaemon: async () => {
        expect(held).toBe(true);
        order.push("stop-daemon");
      },
      log: () => {},
    });

    expect(order).toEqual([
      "acquire:update",
      "teams",
      "daemon",
      "activate",
      "bin-link",
      "stop-daemon",
      "release",
    ]);
  });

  test("a landing that wins the lease race prevents every update mutation", async () => {
    let mutated = false;
    await expect(activateStagedUpdate("0.0.8", {
      acquireLease: async () => {
        throw new Error("landing in Hive instance review is in progress");
      },
      blockers: async () => [],
      inspectDaemon: async () => ({ state: "absent" }),
      activate: async () => {
        mutated = true;
        return { activated: true, version: "0.0.8", previous: "0.0.7" };
      },
      ensureBinLink: async () => {
        mutated = true;
      },
      stopStaleDaemon: async () => {},
      log: () => {},
    })).rejects.toThrow(/landing .* in progress/);
    expect(mutated).toBe(false);
  });

  test("a team appearing after staging blocks activation and releases the lease", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    await activateStagedUpdate("0.0.8", {
      acquireLease: async () => {
        order.push("acquire");
        return { release: () => order.push("release") };
      },
      blockers: async () => [blocker],
      inspectDaemon: async () => {
        throw new Error("daemon inspection must not run");
      },
      activate: async () => {
        throw new Error("activation must not run");
      },
      ensureBinLink: async () => {
        throw new Error("bin link must not change");
      },
      stopStaleDaemon: async () => {},
      log: (line) => lines.push(line),
    });

    expect(order).toEqual(["acquire", "release"]);
    expect(lines.join("\n")).toContain("review: new-agent");
    expect(lines.join("\n")).toContain("Fix:");
  });

  test("an activation error still releases the update lease", async () => {
    const order: string[] = [];
    await expect(activateStagedUpdate("0.0.8", {
      acquireLease: async () => ({ release: () => order.push("release") }),
      blockers: async () => [],
      inspectDaemon: async () => ({ state: "absent" }),
      activate: async () => {
        throw new Error("rename failed");
      },
      ensureBinLink: async () => {},
      stopStaleDaemon: async () => {},
      log: () => {},
    })).rejects.toThrow("rename failed");
    expect(order).toEqual(["release"]);
  });

  test("rollback performs its final team check and activation under the lease", async () => {
    const order: string[] = [];
    let held = false;
    await rollbackWhenIdle({
      acquireLease: async (purpose) => {
        order.push(`acquire:${purpose}`);
        held = true;
        return {
          release: () => {
            held = false;
            order.push("release");
          },
        };
      },
      blockers: async () => {
        expect(held).toBe(true);
        order.push("teams");
        return [];
      },
      rollback: async () => {
        expect(held).toBe(true);
        order.push("rollback");
        return { activated: true, version: "0.0.7", previous: "0.0.8" };
      },
      stopStaleDaemon: async () => {
        expect(held).toBe(true);
        order.push("stop-daemon");
      },
      log: () => {},
    });

    expect(order).toEqual([
      "acquire:rollback",
      "teams",
      "rollback",
      "stop-daemon",
      "release",
    ]);
  });

  test("a team appearing before rollback activation refuses and releases", async () => {
    const order: string[] = [];
    let rolledBack = false;

    await expect(rollbackWhenIdle({
      acquireLease: async () => {
        order.push("acquire");
        return { release: () => order.push("release") };
      },
      blockers: async () => [blocker],
      rollback: async () => {
        rolledBack = true;
        return { activated: true, version: "0.0.7", previous: "0.0.8" };
      },
      stopStaleDaemon: async () => {},
      log: () => {},
    })).rejects.toThrow(/review: new-agent[\s\S]*Fix:/);

    expect(rolledBack).toBe(false);
    expect(order).toEqual(["acquire", "release"]);
  });
});
