import { describe, expect, test } from "bun:test";
import { createProgram } from "../../src/cli";

describe("CLI command descriptions", () => {
  test("all five vendors have first-class Workspace launch commands", () => {
    const launches = new Map(
      createProgram()
        .commands.filter((command) =>
          ["claude", "codex", "grok", "kimi", "opencode"].includes(
            command.name(),
          ),
        )
        .map((command) => [command.name(), command]),
    );

    expect([...launches.keys()]).toEqual([
      "claude",
      "codex",
      "grok",
      "kimi",
      "opencode",
    ]);
    for (const command of launches.values()) {
      expect(command.description()).toStartWith("Open Workspace with");
      expect(command.options).toEqual([]);
    }
  });

  test("routing describes the policy and live facts it actually prints", () => {
    const routing = createProgram().commands.find(
      (command) => command.name() === "routing",
    );

    expect(routing?.description()).toBe(
      "Show routing policy beside live model, billing, and discovery facts",
    );
  });

  test("set-model does not claim an unset model inherits provider consent", () => {
    const routing = createProgram().commands.find(
      (command) => command.name() === "routing",
    );
    const setModel = routing?.commands.find(
      (command) => command.name() === "set-model",
    );

    expect(setModel?.description()).toContain(
      "unset leaves the model unconfigured even when its provider is enabled",
    );
  });

  test("routing exposes the explicit machine-default promotion command", () => {
    const routing = createProgram().commands.find(
      (command) => command.name() === "routing",
    );
    const promote = routing?.commands.find(
      (command) => command.name() === "promote-default",
    );

    expect(promote?.description()).toContain("machine default");
    expect(promote?.description()).toContain("Replace");
    expect(promote?.description()).toContain("discarding");
  });

  test("recover does not claim to resume a crashed agent's conversation", () => {
    // The daemon's CrashRecovery only ever inspects and reports (see
    // recovery-service.ts); it never relaunches or resumes a provider
    // session. `hive recover`'s own help text must not promise otherwise.
    const recover = createProgram().commands.find(
      (command) => command.name() === "recover",
    );

    expect(recover?.description()).toContain("Report-only");
    expect(recover?.description()).not.toContain("Resume");
  });
});

describe("removed flags", () => {
  test("hive init rejects the removed --refresh flag", async () => {
    // Profiling is gone, so --refresh has nothing to refresh. `exitOverride()`
    // turns the unknown option into a thrown CommanderError rather than a
    // process exit, so reintroducing or aliasing the flag turns this red — a
    // string-omission test on normal output could not catch that.
    await expect(
      createProgram().parseAsync(["node", "hive", "init", "--refresh"]),
    ).rejects.toThrow(/unknown option.*--refresh/);
  });
});

describe("repository setup command surfaces", () => {
  test("hive init exposes its repository preparation controls", () => {
    const init = createProgram().commands.find(
      (command) => command.name() === "init",
    );

    expect(init?.options.map((option) => option.long)).toEqual([
      "--scaffold-agents",
      "--seed-facts",
      "--force",
    ]);
  });

  test("hive graphify is status-only because Graphify is always enabled", () => {
    const graphify = createProgram().commands.find(
      (command) => command.name() === "graphify",
    );

    expect(graphify?.commands.map((command) => command.name())).toEqual([
      "status",
    ]);
  });
});
