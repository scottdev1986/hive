import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  currentBuildHash,
  DaemonInstanceMismatchError,
  sourceBuildHash,
  verifyDaemonInstanceWhenReady,
} from "../../src/daemon/lifecycle/daemon-lifecycle";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

const fixtures: string[] = [];

function buildInputFixture(): string {
  const root = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-build-inputs-"));
  fixtures.push(root);
  mkdirSync(join(root, "src", "__fixtures__"), { recursive: true });
  mkdirSync(join(root, "skills", "test-skill"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "src", "app.test.ts"), "test('one', () => {});\n");
  writeFileSync(
    join(root, "src", "__fixtures__", "sample.ts"),
    "export const fixture = 1;\n",
  );
  writeFileSync(
    join(root, "skills", "test-skill", "SKILL.md"),
    "# Skill one\n",
  );
  writeFileSync(join(root, "graphify.lock"), "graphify-one\n");
  writeFileSync(join(root, "bun.lock"), "bun-one\n");
  return root;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe("sourceBuildHash", () => {
  test("hashes the source checkout containing the moved lifecycle module", async () => {
    expect(await currentBuildHash()).toBe(
      await sourceBuildHash(join(import.meta.dir, "..", "..")),
    );
  });

  test("changes for every non-TypeScript input embedded by the release build", async () => {
    const root = buildInputFixture();
    const baseline = await sourceBuildHash(root);
    for (const [path, contents] of [
      [join(root, "skills", "test-skill", "SKILL.md"), "# Skill two\n"],
      [join(root, "graphify.lock"), "graphify-two\n"],
      [join(root, "bun.lock"), "bun-two\n"],
    ] as const) {
      const original = readFileSync(path, "utf8");
      writeFileSync(path, contents);
      expect(await sourceBuildHash(root)).not.toBe(baseline);
      writeFileSync(path, original);
      expect(await sourceBuildHash(root)).toBe(baseline);
    }
  });

  test("changes for production TypeScript", async () => {
    const root = buildInputFixture();
    const baseline = await sourceBuildHash(root);
    writeFileSync(join(root, "src", "app.ts"), "export const value = 2;\n");
    expect(await sourceBuildHash(root)).not.toBe(baseline);
  });

  test("ignores tests and fixture directories", async () => {
    const root = buildInputFixture();
    const baseline = await sourceBuildHash(root);
    writeFileSync(join(root, "src", "app.test.ts"), "test('two', () => {});\n");
    writeFileSync(
      join(root, "src", "__fixtures__", "sample.ts"),
      "export const fixture = 2;\n",
    );
    expect(await sourceBuildHash(root)).toBe(baseline);
  });
});

describe("verifyDaemonInstanceWhenReady", () => {
  test("retries transient startup failures and succeeds once", async () => {
    let attempts = 0;
    let now = 0;

    await verifyDaemonInstanceWhenReady(4321, "expected", {
      verify: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("daemon is still starting");
      },
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      timeoutMs: 1_000,
      retryMs: 100,
    });

    expect(attempts).toBe(3);
    expect(now).toBe(200);
  });

  test("never retries an instance identity mismatch", async () => {
    let attempts = 0;

    await expect(
      verifyDaemonInstanceWhenReady(4321, "expected", {
        verify: async () => {
          attempts += 1;
          throw new DaemonInstanceMismatchError(4321, "expected", "different");
        },
        sleep: async () => {
          throw new Error("identity mismatches must not sleep");
        },
      }),
    ).rejects.toBeInstanceOf(DaemonInstanceMismatchError);

    expect(attempts).toBe(1);
  });

  test("rethrows the last startup error when the retry budget expires", async () => {
    let attempts = 0;
    let now = 0;

    await expect(
      verifyDaemonInstanceWhenReady(4321, "expected", {
        verify: async () => {
          attempts += 1;
          throw new Error(`startup attempt ${attempts}`);
        },
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 200,
        retryMs: 100,
      }),
    ).rejects.toThrow("startup attempt 3");

    expect(attempts).toBe(3);
  });
});
