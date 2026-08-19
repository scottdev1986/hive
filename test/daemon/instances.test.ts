import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  instanceMutationBlockers,
  namedInstanceHome,
  repoInstanceName,
  selectInstanceFromArgv,
  selectRepoInstance,
} from "../../src/daemon/lifecycle/instances";
import { defaultHiveHome, machineHiveHome } from "../../src/hive-home/home";
import { getQuotaDatabasePath } from "../../src/usage-service/quota-ledger";

const originalHome = process.env.HIVE_HOME;
const originalDefaultHome = process.env.HIVE_DEFAULT_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHome;
  if (originalDefaultHome === undefined) delete process.env.HIVE_DEFAULT_HOME;
  else process.env.HIVE_DEFAULT_HOME = originalDefaultHome;
});

describe("instance selection", () => {
  test("an explicit default home isolates machine-scoped state", () => {
    process.env.HIVE_DEFAULT_HOME = "/tmp/hvqa-default";
    expect(defaultHiveHome()).toBe("/tmp/hvqa-default");
    expect(namedInstanceHome("blue")).toBe("/tmp/hvqa-default/instances/blue");
    expect(getQuotaDatabasePath()).toBe("/tmp/hvqa-default/quota.db");
  });

  test("an unsafe explicit default home fails closed", () => {
    for (const explicitHome of ["", "relative/default-home"]) {
      process.env.HIVE_DEFAULT_HOME = explicitHome;
      expect(() => defaultHiveHome()).toThrow(
        "HIVE_DEFAULT_HOME must be a non-empty absolute path",
      );
    }
  });

  test("an unset default home keeps the user path", () => {
    delete process.env.HIVE_DEFAULT_HOME;
    expect(defaultHiveHome()).toBe(join(homedir(), ".hive"));
  });

  test("a named instance selects its own HIVE_HOME", () => {
    const selected = selectInstanceFromArgv([
      "bun",
      "hive",
      "--instance",
      "blue",
      "init",
    ]);
    expect(selected).toBe(namedInstanceHome("blue"));
    expect(process.env.HIVE_HOME).toBe(namedInstanceHome("blue"));
  });

  test("the default path is unchanged when no instance is selected", () => {
    process.env.HIVE_HOME = "/tmp/existing-hive-home";
    expect(selectInstanceFromArgv(["bun", "hive", "init"])).toBeNull();
    expect(process.env.HIVE_HOME).toBe("/tmp/existing-hive-home");
  });

  test("a repository keeps one instance home across launches", () => {
    const first = selectRepoInstance("project-aaaa");
    const again = selectRepoInstance("project-aaaa");
    const other = selectRepoInstance("project-bbbb");
    expect(first).toBe(namedInstanceHome(repoInstanceName("project-aaaa")));
    expect(again).toBe(first);
    expect(other).toBe(namedInstanceHome(repoInstanceName("project-bbbb")));
    expect(other).not.toBe(first);
    expect(process.env.HIVE_HOME).toBe(other);
  });

  test("an explicit named home still wins over the repo instance", () => {
    selectRepoInstance("project-aaaa");
    selectInstanceFromArgv([
      "bun",
      "hive",
      "--instance",
      "named-explicit",
      "init",
    ]);
    expect(process.env.HIVE_HOME).toBe(namedInstanceHome("named-explicit"));
  });

  test("repo instances share machine-scoped tools from the default home", () => {
    expect(
      machineHiveHome(namedInstanceHome(repoInstanceName("project-aaaa"))),
    ).toBe(defaultHiveHome());
  });

  test("instance names cannot escape the registry directory", () => {
    expect(() => namedInstanceHome("../other")).toThrow(
      "Invalid Hive instance name",
    );
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
    const blockers = await instanceMutationBlockers(
      async (port) => {
        seen.push(port);
        return port === 4301 ? ["maya"] : [];
      },
      {
        instances: async () => instances,
        liveness: async (_home, id) =>
          id === "starting-id" ? "unknown" : "dead",
      },
    );
    expect(seen).toEqual([4301, 4302]);
    expect(
      blockers.map(({ instance, liveAgents }) => [instance.name, liveAgents]),
    ).toEqual([
      ["blue", ["maya"]],
      ["starting", ["<starting-or-unreachable>"]],
    ]);
  });

  test("an unreadable instance registry is never treated as an empty machine", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-instance-registry-error-"));
    const modulePath = join(
      import.meta.dir,
      "../../src/daemon/lifecycle/instances.ts",
    );
    const homePath = join(import.meta.dir, "../../src/hive-home/home.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      const { listInstances } = await import(${JSON.stringify(modulePath)});
      const { instancesRoot } = await import(${JSON.stringify(homePath)});
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
    `,
      ],
      {
        env: { ...process.env, HOME: home },
        stderr: "pipe",
      },
    );
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
