import { describe, expect, test } from "bun:test";
import { createProgram } from "../cli";

describe("CLI command descriptions", () => {
  test("routing describes the policy and live facts it actually prints", () => {
    const routing = createProgram().commands.find((command) => command.name() === "routing");

    expect(routing?.description()).toBe(
      "Show routing policy beside live model, billing, and discovery facts",
    );
  });
});
