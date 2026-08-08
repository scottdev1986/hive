import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProjectGate } from "../../src/daemon/landing/project-gate";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture(format: string, typecheck = "exit 0"): string {
  const root = join(
    tmpdir(),
    `hive-project-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { "format:check": format, typecheck } }),
  );
  roots.push(root);
  return root;
}

describe("project landing gate", () => {
  test("runs format then typecheck from the requested checkout", async () => {
    const root = fixture(
      'printf "%s:format:check\\n" "$PWD" >> "$PWD/calls"',
      'printf "%s:typecheck\\n" "$PWD" >> "$PWD/calls"',
    );
    await runProjectGate(root);

    const requestedRoot = realpathSync(root);
    expect(await Bun.file(join(root, "calls")).text()).toBe(
      `${requestedRoot}:format:check\n${requestedRoot}:typecheck\n`,
    );
  });

  test("uses Bun for checks when process.execPath is a compiled Hive binary", async () => {
    const root = fixture(
      'printf "format:check\\n" >> "$PWD/calls"',
      'printf "typecheck\\n" >> "$PWD/calls"',
    );
    const hiveExecutable = join(root, "hive");
    writeFileSync(
      hiveExecutable,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PWD/hive-calls"\nexit 64\n',
    );
    chmodSync(hiveExecutable, 0o755);

    const bunExecutable = process.execPath;
    process.execPath = hiveExecutable;
    try {
      await runProjectGate(root);
    } finally {
      process.execPath = bunExecutable;
    }

    expect(await Bun.file(join(root, "calls")).text()).toBe(
      "format:check\ntypecheck\n",
    );
    expect(existsSync(join(root, "hive-calls"))).toBe(false);
  });

  test("fails closed and does not continue after a red check", async () => {
    const root = fixture(
      'printf "format:check\\n" >> "$PWD/calls"; printf "bad format" >&2; exit 7',
      'printf "typecheck\\n" >> "$PWD/calls"',
    );
    await expect(runProjectGate(root)).rejects.toThrow(
      "Project format:check blocked landing:",
    );

    expect(await Bun.file(join(root, "calls")).text()).toBe("format:check\n");
  });
});
