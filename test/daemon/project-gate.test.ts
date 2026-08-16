import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLearnedProjectGate,
  runProjectGate,
  verificationCommandDeclared,
} from "../../src/daemon/landing/project-gate";
import { AGENT_STANDARDS_FILE } from "../../src/daemon/spawn/agent-standards";
import {
  VERIFICATION_ARTICLE_ID,
  VERIFICATION_TITLE_PREFIX,
} from "../../src/memory-service/harvest";
import { writeMemoryFact } from "../../src/memory-service/memory-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-project-gate-"));
  roots.push(root);
  return root;
}

async function recordCommand(root: string, command: string): Promise<void> {
  await writeMemoryFact(root, {
    scope: "repo",
    id: VERIFICATION_ARTICLE_ID,
    topic: "verification",
    title: `${VERIFICATION_TITLE_PREFIX}${command}`,
    body: `Measured \`${command}\`.`,
    source: "orchestrator",
    evidence: "project-gate.test.ts",
    status: "unverified",
    supersedes: [],
    author: "harvester",
  });
}

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
    const root = await tempRoot();
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

  test("runs the harvested command in the worktree and promotes on green", async () => {
    const primary = await tempRoot();
    const worktree = await tempRoot();
    const command = "printf ran >> calls";
    writeFileSync(
      join(primary, "package.json"),
      JSON.stringify({ scripts: { test: command } }),
    );
    await recordCommand(primary, command);

    await runLearnedProjectGate(primary, worktree);

    expect(await Bun.file(join(worktree, "calls")).text()).toBe("ran");
    expect(await Bun.file(join(primary, "calls")).exists()).toBe(false);
    expect(
      await Bun.file(join(primary, AGENT_STANDARDS_FILE)).text(),
    ).toContain(`\`${command}\``);
  });

  test("a red harvested command blocks landing and does not promote", async () => {
    const root = await tempRoot();
    const command = "printf ran >> calls; exit 7";
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: command } }),
    );
    await recordCommand(root, command);

    await expect(runProjectGate(root)).rejects.toThrow(
      "Learned verification blocked landing",
    );
    expect(await Bun.file(join(root, "calls")).text()).toBe("ran");
    expect(await Bun.file(join(root, AGENT_STANDARDS_FILE)).exists()).toBe(
      false,
    );
  });

  test("an undeclared harvested command is not run", async () => {
    const root = await tempRoot();
    await recordCommand(root, "printf ran >> calls");

    await runProjectGate(root);

    expect(await Bun.file(join(root, "calls")).exists()).toBe(false);
  });
});

describe("verificationCommandDeclared", () => {
  test("a package script, a make target, and an exact haystack hit count", async () => {
    const root = await tempRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node test.js" } }),
    );
    writeFileSync(join(root, "Makefile"), "verify:\n\ttrue\n");
    writeFileSync(join(root, "AGENTS.md"), "run: custom-check --strict\n");

    expect(verificationCommandDeclared(root, "npm test")).toBe(true);
    expect(verificationCommandDeclared(root, "make verify")).toBe(true);
    expect(verificationCommandDeclared(root, "custom-check --strict")).toBe(
      true,
    );
    expect(verificationCommandDeclared(root, "secret-cmd")).toBe(false);
  });
});
