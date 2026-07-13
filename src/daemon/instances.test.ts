import { afterEach, describe, expect, test } from "bun:test";

import {
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
});
