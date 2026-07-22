import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MEMORY_SELF_TEST_CANARY_COUNT,
  memorySelfTestCli,
  plantMemorySelfTestFixture,
  probeMemorySelfTest,
} from "../src/cli/memory-self-test";
import { OUTSIDE_REPO_TMPDIR } from "./outside-repo-tmpdir";

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("hive memory self-test", () => {
  test("passes end-to-end on a fresh fixture: exit 0, all PASS lines", async () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const exitCode = await memorySelfTestCli();
      expect(exitCode).toBe(0);
      const lines = log.mock.calls.map((call) => String(call[0]));
      const assertionLines = lines.filter((line) =>
        line.startsWith("PASS ") || line.startsWith("FAIL ")
      );
      expect(assertionLines).toHaveLength(6);
      for (const line of assertionLines) {
        expect(line.startsWith("PASS ")).toBe(true);
      }
      expect(assertionLines[0]).toContain(
        `recall@5 — ${MEMORY_SELF_TEST_CANARY_COUNT}/${MEMORY_SELF_TEST_CANARY_COUNT}`,
      );
      expect(MEMORY_SELF_TEST_CANARY_COUNT).toBeGreaterThanOrEqual(30);
      expect(lines.at(-1)).toContain("all 6 assertions passed");
    } finally {
      log.mockRestore();
    }
  });

  test("sabotaged fixture fails the probe: deleting canaries breaks recall@5", async () => {
    const home = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-self-test-home-"));
    const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-self-test-repo-"));
    tempRoots.push(home, root);
    process.env.HIVE_HOME = home;
    await plantMemorySelfTestFixture(root);

    // Sabotage: delete five planted canary articles before indexing. A probe
    // that only checks "files exist" would still pass; the recall probe must
    // not.
    const wiki = join(root, ".hive", "memory", "wiki");
    let deleted = 0;
    for (const topic of await readdir(wiki, { withFileTypes: true })) {
      if (!topic.isDirectory()) continue;
      for (const entry of await readdir(join(wiki, topic.name))) {
        if (entry.startsWith("self-test-canary-") && deleted < 5) {
          await rm(join(wiki, topic.name, entry));
          deleted += 1;
        }
      }
    }
    expect(deleted).toBe(5);

    const assertions = await probeMemorySelfTest(root);
    expect(assertions.some((assertion) => !assertion.passed)).toBe(true);
    const recall = assertions.find((assertion) => assertion.name === "recall@5");
    expect(recall?.passed).toBe(false);
    expect(recall?.detail).toContain(
      `${MEMORY_SELF_TEST_CANARY_COUNT - 5}/${MEMORY_SELF_TEST_CANARY_COUNT}`,
    );
    const readBack = assertions.find((a) => a.name === "read-back");
    expect(readBack?.passed).toBe(false);
  });
});
