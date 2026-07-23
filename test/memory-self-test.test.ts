import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MEMORY_SELF_TEST_CANARY_COUNT,
  memorySelfTestCli,
  plantMemorySelfTestFixture,
  probeMemorySelfTest,
  runMemorySelfTest,
} from "../src/cli/memory-self-test";
import { liveSelfTestReport } from "../src/cli/memory-self-test-live";
import {
  MemoryEmbeddingService,
  type MemoryEmbedder,
} from "../src/daemon/memory-embeddings";
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

// The semantic assertions NEVER load the real model under `bun test` (the
// onnxruntime teardown SIGTRAP, see test/memory-embedding-live.test.ts) —
// they get a deterministic mock embedder with controlled geometry instead:
// the paraphrase canary and its query share one vector, the consolidation
// pair shares another, everything else hashes to an independent random
// direction in 64 dims (cosine ≈ 0, never ≥ 0.85 by chance).
function mockSelfTestEmbedder(): MemoryEmbedder {
  const unit = (seed: number): number[] => {
    let state = seed || 1;
    const vector = Array.from({ length: 64 }, () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state / 2 ** 30 - 1;
    });
    const magnitude = Math.hypot(...vector);
    return vector.map((component) => component / magnitude);
  };
  const semanticVector = unit(1);
  const pairVector = unit(2);
  const hash = (text: string): number => {
    let value = 7;
    for (const char of text) value = (value * 31 + char.charCodeAt(0)) % 2 ** 31;
    return value;
  };
  const pick = (text: string): number[] => {
    if (text.includes("free-memory floor") || text.includes("RAM is exhausted")) {
      return semanticVector;
    }
    if (text.includes("wake-delta injection budget defaults to 300 tokens")) {
      return pairVector;
    }
    return unit(hash(text));
  };
  return {
    model: "mock-self-test",
    dimensions: 64,
    embed: (texts) => Promise.resolve(texts.map(pick)),
    embedQuery: (text) => Promise.resolve(pick(text)),
  };
}

function mockService(): MemoryEmbeddingService {
  return new MemoryEmbeddingService(
    { provider: "local", model: "bge-small-en-v1.5" },
    { load: () => Promise.resolve(mockSelfTestEmbedder()) },
  );
}

function unavailableService(): MemoryEmbeddingService {
  return new MemoryEmbeddingService(
    { provider: "local", model: "bge-small-en-v1.5" },
    { load: () => Promise.reject(new Error("mock load failure")) },
  );
}

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

  test("semantic assertions SKIP honestly when embeddings are unavailable", async () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const exitCode = await memorySelfTestCli();
      expect(exitCode).toBe(0);
      const lines = log.mock.calls.map((call) => String(call[0]));
      const skips = lines.filter((line) => line.startsWith("SKIP "));
      expect(skips).toHaveLength(2);
      expect(skips[0]).toBe("SKIP semantic-recall — embeddings unavailable");
      expect(skips[1]).toBe(
        "SKIP consolidation-dry-run — embeddings unavailable",
      );
      // A SKIP is not a failure: the exit code reflects only what was provable.
      expect(lines.some((line) => line.startsWith("FAIL "))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  test("--strict turns skipped semantic assertions into FAIL (defect D4)", async () => {
    // No embedder (env var unset, no service): the semantic assertions skip.
    // Strict mode is the CI gate — a skip means the assertion never ran, so
    // it must fail the run instead of passing green behind a SKIP line.
    const report = await runMemorySelfTest({ strict: true });
    expect(report.ok).toBe(false);
    expect(report.lines).toContain(
      "FAIL semantic-recall — skipped in strict mode (embeddings unavailable)",
    );
    expect(report.lines).toContain(
      "FAIL consolidation-dry-run — skipped in strict mode (embeddings unavailable)",
    );
    // The six provable assertions still pass; only the skips flip to FAIL.
    expect(
      report.lines.filter((line) => line.startsWith("PASS ")),
    ).toHaveLength(6);
    expect(
      report.lines.filter((line) => line.startsWith("FAIL ")),
    ).toHaveLength(2);
    expect(report.lines.some((line) => line.startsWith("SKIP "))).toBe(false);
  });

  test("--strict passes when an embedder is available (nothing left to skip)", async () => {
    const report = await runMemorySelfTest({
      service: mockService(),
      strict: true,
    });
    expect(report.ok).toBe(true);
    expect(report.lines).toHaveLength(8);
    for (const line of report.lines) {
      expect(line.startsWith("PASS ")).toBe(true);
    }
  });

  test("default (non-strict) run keeps SKIP a pass-with-note", async () => {
    const report = await runMemorySelfTest();
    expect(report.ok).toBe(true);
    expect(
      report.lines.filter((line) => line.startsWith("SKIP ")),
    ).toHaveLength(2);
    expect(report.lines.some((line) => line.startsWith("FAIL "))).toBe(false);
  });

  test("--strict composes with --live: a skipped live assertion fails", () => {
    const skippedRun = [
      { name: "reported-state", passed: true, detail: "state=ready" },
      {
        name: "semantic-recall",
        passed: false,
        skipped: true,
        detail: "(disabled in config)",
      },
    ];
    const strictReport = liveSelfTestReport(skippedRun, true);
    expect(strictReport.ok).toBe(false);
    expect(strictReport.lines).toContain(
      "[live] FAIL semantic-recall — skipped in strict mode ((disabled in config))",
    );
    expect(strictReport.lines[0]).toBe(
      "[live] PASS reported-state — state=ready",
    );

    // The same assertions without strict keep the honest SKIP, pass-with-note.
    const defaultReport = liveSelfTestReport(skippedRun);
    expect(defaultReport.ok).toBe(true);
    expect(defaultReport.lines).toContain(
      "[live] SKIP semantic-recall — (disabled in config)",
    );
  });

  test("an injected unavailable service also yields SKIP, not failure", async () => {
    const home = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-self-test-home-"));
    const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-self-test-repo-"));
    tempRoots.push(home, root);
    process.env.HIVE_HOME = home;
    await plantMemorySelfTestFixture(root);

    const assertions = await probeMemorySelfTest(root, {
      service: unavailableService(),
    });
    expect(assertions).toHaveLength(8);
    const semantic = assertions.find((a) => a.name === "semantic-recall");
    const dryRun = assertions.find((a) => a.name === "consolidation-dry-run");
    expect(semantic?.skipped).toBe(true);
    expect(dryRun?.skipped).toBe(true);
    expect(assertions.every((a) => a.passed || a.skipped === true)).toBe(true);
  });

  test("with a mock embedder the semantic assertions PASS deterministically", async () => {
    const home = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-self-test-home-"));
    const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-self-test-repo-"));
    tempRoots.push(home, root);
    process.env.HIVE_HOME = home;
    await plantMemorySelfTestFixture(root);

    const assertions = await probeMemorySelfTest(root, {
      service: mockService(),
    });
    expect(assertions).toHaveLength(8);
    expect(assertions.every((a) => a.passed)).toBe(true);
    const semantic = assertions.find((a) => a.name === "semantic-recall");
    expect(semantic?.passed).toBe(true);
    expect(semantic?.detail).toContain("self-test-semantic-canary");
    const dryRun = assertions.find((a) => a.name === "consolidation-dry-run");
    expect(dryRun?.passed).toBe(true);
    expect(dryRun?.detail).toContain("identical bucket");
    expect(dryRun?.detail).toContain("nothing modified");
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
    expect(
      assertions.some((a) => !a.passed && a.skipped !== true),
    ).toBe(true);
    const recall = assertions.find((assertion) => assertion.name === "recall@5");
    expect(recall?.passed).toBe(false);
    expect(recall?.detail).toContain(
      `${MEMORY_SELF_TEST_CANARY_COUNT - 5}/${MEMORY_SELF_TEST_CANARY_COUNT}`,
    );
    const readBack = assertions.find((a) => a.name === "read-back");
    expect(readBack?.passed).toBe(false);
  });
});
