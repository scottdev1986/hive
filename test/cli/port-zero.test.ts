import { describe, expect, test } from "bun:test";
import { createProgram } from "../../src/cli";
import { isDaemonPort } from "../../src/shared/daemon-port";

describe("the port owner separates bind from connect", () => {
  test("zero is a bind-only port", () => {
    expect(isDaemonPort(0)).toBe(false);
    expect(isDaemonPort(0, { allowZero: true })).toBe(true);
  });

  test("the usable range is otherwise unchanged", () => {
    expect(isDaemonPort(1)).toBe(true);
    expect(isDaemonPort(65_535)).toBe(true);
    expect(isDaemonPort(65_536)).toBe(false);
    expect(isDaemonPort(1.5)).toBe(false);
  });
});

describe("--port 0 is refused at the CLI parse boundary", () => {
  test("a read-only daemon command refuses it", async () => {
    await expect(
      createProgram().parseAsync([
        "node",
        "hive",
        "routing",
        "policy",
        "--port",
        "0",
      ]),
    ).rejects.toThrow(/Invalid event port: 0/);
  });

  // This is the path that writes `mcp_servers.hive.url` into the user's vendor
  // config. It must fail before it can persist a url pointing at port 0.
  test("the orchestrator launch path refuses it before writing any config", async () => {
    await expect(
      createProgram().parseAsync([
        "node",
        "hive",
        "workspace-orchestrator",
        "--tool",
        "codex",
        "--port",
        "0",
        "--instance-id",
        "some-instance",
      ]),
    ).rejects.toThrow(/Invalid event port: 0/);
  });

  test("out-of-range ports are refused too", async () => {
    await expect(
      createProgram().parseAsync([
        "node",
        "hive",
        "routing",
        "policy",
        "--port",
        "65536",
      ]),
    ).rejects.toThrow(/Invalid event port: 65536/);
  });

  // Positive control: without this, the assertions above would also pass if the
  // parser rejected every port, which would say nothing about zero.
  test("a real port gets past the parser", async () => {
    await expect(
      createProgram().parseAsync([
        "node",
        "hive",
        "routing",
        "policy",
        "--port",
        "4711",
      ]),
    ).rejects.not.toThrow(/Invalid event port/);
  });
});
