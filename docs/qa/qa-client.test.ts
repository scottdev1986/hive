import { expect, test } from "bun:test";
import { requiredQaCoordinates } from "./qa-client";

test("uses the rig-published artifact directory when run omits an override", () => {
  const prior = { ...process.env };
  process.env.HIVE_QA_HOME = "/private/tmp/hvqa-client-test";
  process.env.HIVE_QA_PROJECT = "/private/tmp/project";
  process.env.HIVE_QA_PORT = "12345";
  process.env.HIVE_QA_SRC_ROOT = "/private/tmp/source";
  delete process.env.HIVE_QA_ARTIFACTS;
  try {
    expect(requiredQaCoordinates().artifacts).toBe(
      "/private/tmp/hvqa-client-test/artifacts",
    );
  } finally {
    // Restore the keys in place. Reassigning process.env swaps in a plain
    // object that Bun.env no longer tracks, so for the rest of the `bun test`
    // process every reader of Bun.env sees the startup snapshot while writers
    // of process.env change nothing.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, prior);
  }
});
