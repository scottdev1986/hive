import { afterEach, describe, expect, test } from "bun:test";

import {
  instanceMutationBlockers,
  namedInstanceHome,
  selectInstanceFromArgv,
} from "./instances";

const originalHome = process.env.HIVE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHome;
});

describe("instance selection", () => {
  test("a named instance selects its own HIVE_HOME", () => {
    const selected = selectInstanceFromArgv(["bun", "hive", "--instance", "blue", "init"]);
    expect(selected).toBe(namedInstanceHome("blue"));
    expect(process.env.HIVE_HOME).toBe(namedInstanceHome("blue"));
  });

  test("the default path is unchanged when no instance is selected", () => {
    process.env.HIVE_HOME = "/tmp/existing-hive-home";
    expect(selectInstanceFromArgv(["bun", "hive", "init"])).toBeNull();
    expect(process.env.HIVE_HOME).toBe("/tmp/existing-hive-home");
  });

  test("instance names cannot escape the registry directory", () => {
    expect(() => namedInstanceHome("../other")).toThrow("Invalid Hive instance name");
  });

  test("global mutation sees each live instance's own team and blocks unknown startup", async () => {
    const instances = [
      {
        name: "blue",
        home: "/tmp/blue",
        instanceId: "blue-id",
        port: 4301,
        pid: 101,
        running: true,
      },
      {
        name: "green",
        home: "/tmp/green",
        instanceId: "green-id",
        port: 4302,
        pid: 102,
        running: true,
      },
      {
        name: "starting",
        home: "/tmp/starting",
        instanceId: "starting-id",
        port: null,
        pid: 103,
        running: false,
      },
    ];
    const seen: number[] = [];
    const blockers = await instanceMutationBlockers(async (port) => {
      seen.push(port);
      return port === 4301 ? ["maya"] : [];
    }, {
      instances: async () => instances,
      liveness: async (_home, id) => id === "starting-id" ? "unknown" : "dead",
    });
    expect(seen).toEqual([4301, 4302]);
    expect(blockers.map(({ instance, liveAgents }) => [instance.name, liveAgents]))
      .toEqual([
        ["blue", ["maya"]],
        ["starting", ["<starting-or-unreachable>"]],
      ]);
  });
});
