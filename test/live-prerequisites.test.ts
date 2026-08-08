import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireExecutable,
  requireLiveInput,
  requireSuccessfulTurn,
  requireVerifiedVersion,
} from "./live-prerequisites";

describe("live-test prerequisites", () => {
  test("an absent vendor is a loud failure, never a skip", () => {
    expect(() => requireExecutable("Grok", null)).toThrow(
      "Grok is not installed on PATH",
    );
  });

  test("a declared input is required rather than inherited", () => {
    const name = "HIVE_TEST_MISSING_LIVE_INPUT";
    delete process.env[name];
    expect(() => requireLiveInput(name)).toThrow(`${name} is required`);
  });

  test("patch releases stay compatible while a series change is loud", () => {
    expect(requireVerifiedVersion("Codex", "0.147.9", "0.147")).toBe("0.147.9");
    expect(() => requireVerifiedVersion("Codex", "0.148.0", "0.147")).toThrow(
      "Codex moved outside the verified 0.147.x series to 0.148.0; re-verify the live protocol and update the bound",
    );
  });

  test("an accepted receipt cannot hide a failed vendor turn", () => {
    const receipt = {
      clientInputId: "live-turn",
      outcome: "accepted" as const,
      turnId: "turn-1",
    };
    const failed = {
      kind: "turn-failed" as const,
      turnId: "turn-1",
      reason: "not logged in",
      sequence: 1,
      occurredAt: new Date(0).toISOString(),
      raw: {},
    };

    expect(() => requireSuccessfulTurn("live turn", receipt, [failed])).toThrow(
      "live turn failed: not logged in",
    );
    expect(() => requireSuccessfulTurn("live turn", receipt, [])).toThrow(
      "live turn produced no terminal event",
    );
    expect(() =>
      requireSuccessfulTurn("live turn", receipt, [
        { ...failed, kind: "turn-idle" as const },
      ]),
    ).not.toThrow();
  });

  test("aggregate preflight reports every missing input and runs available coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "live-preflight-"));
    const bin = join(root, "bin");
    const input = join(root, "declared.json");
    const invocations = join(root, "invocations.log");
    await mkdir(bin, { recursive: true });
    await Bun.write(input, "{}\n");
    const fakeBun = join(bin, "bun");
    await Bun.write(
      fakeBun,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HIVE_TEST_ROOT/invocations.log"\n`,
    );
    await chmod(fakeBun, 0o755);

    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    Object.assign(env, {
      HIVE_TEST_ROOT: root,
      HOME: join(root, "home"),
      XDG_DATA_HOME: join(root, "data"),
      PATH: `${bin}:${env.PATH ?? ""}`,
      HIVE_LIVE_GROK_AUTH_FILE: input,
      HIVE_LIVE_GROK_CONFIG_FILE: input,
      HIVE_LIVE_KIMI_AUTH_FILE: input,
      HIVE_LIVE_KIMI_OAUTH_FILE: input,
      HIVE_LIVE_KIMI_CONFIG_FILE: input,
      HIVE_LIVE_CODEX_AUTH_FILE: input,
      HIVE_LIVE_CODEX_CONFIG_FILE: input,
      HIVE_LIVE_OPENCODE_AUTH_FILE: input,
    });
    delete env.HIVE_LIVE_CLAUDE_CREDENTIAL_FILE;
    delete env.HIVE_LIVE_CLAUDE_CONFIG_FILE;

    const child = Bun.spawn([process.execPath, "scripts/test-live.ts"], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain(
      "Claude FAILED (not run): missing HIVE_LIVE_CLAUDE_CREDENTIAL_FILE, HIVE_LIVE_CLAUDE_CONFIG_FILE",
    );
    expect(stdout).toContain("[test:live] vendor protocols exit 0");
    expect(stdout).toContain("[test:live] capability discovery exit 0");
    expect(stdout).toContain("[test:live] memory embeddings exit 0");

    const calls = (await readFile(invocations, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("Grok|grok");
    expect(calls[0]).toContain("Codex|codex");
    expect(calls[0]).not.toContain("Claude|claude");
    expect(calls[1]).toContain("Codex|codex");
    expect(calls[1]).not.toContain("Claude|claude");
    expect(calls[2]).not.toContain("--test-name-pattern");
  });
});
