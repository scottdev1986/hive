import { expect, test } from "bun:test";
import { requireMutationReadback } from "./daemon-scenario-core";

test("mutation cannot pass when its read-back fails", async () => {
  let mutated = false;
  await expect(
    requireMutationReadback(
      async () => {
        mutated = true;
      },
      async () => {
        throw new Error("read-back missing");
      },
    ),
  ).rejects.toThrow("read-back missing");
  expect(mutated).toBeTrue();
});
