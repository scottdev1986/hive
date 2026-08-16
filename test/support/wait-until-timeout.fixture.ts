import { test } from "bun:test";
import { waitUntil } from "./wait-until";

// Deliberately fails. wait-until.test.ts runs this file as a child so the
// named timeout is observed in bun's reporter, not only as a caught throw.
test("fixture: a waitUntil timeout must reach the reporter", async () => {
  await waitUntil(() => false, {
    deadlineMs: 50,
    label: "a child that was never forked",
  });
});
