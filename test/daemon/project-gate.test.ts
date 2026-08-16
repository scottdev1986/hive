import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectGate } from "../../src/daemon/landing/project-gate";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("project landing gate", () => {
  test("does not compile in format:check or typecheck", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/daemon/landing/project-gate.ts"),
      "utf8",
    );
    expect(source).not.toContain("format:check");
    expect(source).not.toContain("typecheck");
    expect(source).not.toContain("bun run");
  });

  test("does not run compiled-in scripts, even when a checkout has them", async () => {
    const root = join(
      tmpdir(),
      `hive-project-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
    roots.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          "format:check": 'printf "format:check\\n" >> "$PWD/calls"; exit 7',
          typecheck: 'printf "typecheck\\n" >> "$PWD/calls"; exit 7',
        },
      }),
    );

    await runProjectGate(root);

    expect(await Bun.file(join(root, "calls")).exists()).toBe(false);
  });
});
