import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultHiveHome,
  instanceMutationBlockers,
  machineHiveHome,
  namedInstanceHome,
  ORDINARY_WORKSPACE_RUNTIME,
  selectFreshInstance,
  selectInstanceFromArgv,
} from "./instances";

const originalHome = process.env.HIVE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHome;
  delete process.env[ORDINARY_WORKSPACE_RUNTIME];
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

  test("ordinary launches can select a fresh isolated instance every time", () => {
    const first = selectFreshInstance("first");
    const second = selectFreshInstance("second");
    expect(first).toBe(namedInstanceHome("run-first"));
    expect(second).toBe(namedInstanceHome("run-second"));
    expect(second).not.toBe(first);
    expect(process.env.HIVE_HOME).toBe(second);
    expect(process.env[ORDINARY_WORKSPACE_RUNTIME]).toBe("1");
  });

  test("an explicit named home is never mistaken for an ordinary runtime", () => {
    selectFreshInstance("first");
    selectInstanceFromArgv(["bun", "hive", "--instance", "run-explicit", "init"]);
    expect(process.env[ORDINARY_WORKSPACE_RUNTIME]).toBeUndefined();
  });

  test("automatic runtimes share machine-scoped tools from the default home", () => {
    expect(machineHiveHome(namedInstanceHome("run-first"))).toBe(defaultHiveHome());
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

  test("an unreadable instance registry is never treated as an empty machine", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-instance-registry-error-"));
    const modulePath = join(import.meta.dir, "instances.ts");
    const child = Bun.spawn([process.execPath, "-e", `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      const { instancesRoot, listInstances } = await import(${JSON.stringify(modulePath)});
      const root = instancesRoot();
      mkdirSync(dirname(root), { recursive: true });
      writeFileSync(root, "not a directory\\n");
      try {
        await listInstances();
        console.error("listInstances treated an unreadable registry as empty");
        process.exit(2);
      } catch (error) {
        if (error?.code !== "ENOTDIR") throw error;
      }
    `], {
      env: { ...process.env, HOME: home },
      stderr: "pipe",
    });
    try {
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
