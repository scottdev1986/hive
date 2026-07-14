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
});
