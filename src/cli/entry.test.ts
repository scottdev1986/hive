import { describe, expect, test } from "bun:test";
import { createProgram } from "../cli";

describe("CLI command descriptions", () => {
  test("routing describes the policy and live facts it actually prints", () => {
    const routing = createProgram().commands.find((command) => command.name() === "routing");

    expect(routing?.description()).toBe(
      "Show routing policy beside live model, billing, and discovery facts",
    );
  });

  test("set-model does not claim an unset model inherits provider consent", () => {
    const routing = createProgram().commands.find((command) => command.name() === "routing");
    const setModel = routing?.commands.find((command) => command.name() === "set-model");

    expect(setModel?.description()).toContain(
      "unset leaves the model unconfigured even when its provider is enabled",
    );
  });

  test("routing exposes the explicit machine-default promotion command", () => {
    const routing = createProgram().commands.find((command) => command.name() === "routing");
    const promote = routing?.commands.find((command) => command.name() === "promote-default");

    expect(promote?.description()).toContain("machine default");
    expect(promote?.description()).toContain("Replace");
    expect(promote?.description()).toContain("discarding");
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

  test("hive init rejects the removed --no-embeddings flag", async () => {
    // Embeddings are a required component (user ruling 2026-07-22): init
    // always provisions the runtime and there is no opt-out. Same
    // `exitOverride()` trick as --refresh above.
    await expect(
      createProgram().parseAsync(["node", "hive", "init", "--no-embeddings"]),
    ).rejects.toThrow(/unknown option.*--no-embeddings/);
  });
});
