import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CodexRoute } from "../../schemas";

export interface CodexSpawnOptions {
  name: string;
  model: CodexRoute["model"];
  effort: NonNullable<CodexRoute["effort"]>;
  worktreePath: string;
  daemonPort: number;
  readOnly: boolean;
}

export type CodexAgentConfigOptions = Pick<
  CodexSpawnOptions,
  "name" | "daemonPort" | "readOnly"
>;

export const CODEX_NOTIFY_SCRIPT = "hive-notify.sh";

const shellToken = (value: string): string => {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
};

const tomlString = (value: string): string => JSON.stringify(value);

export function buildCodexTrustArgs(worktreePath: string): string[] {
  const absoluteWorktreePath = resolve(worktreePath);
  return [
    "-c",
    `projects.${tomlString(absoluteWorktreePath)}.trust_level="trusted"`,
  ];
}

export function buildCodexSpawnCommand(options: CodexSpawnOptions): string[] {
  const command = ["codex"];
  if (options.model !== "default") {
    command.push("-c", `model=${options.model}`);
  }
  command.push("-c", `model_reasoning_effort=${options.effort}`);

  if (options.readOnly) {
    command.push("--sandbox", "read-only");
  } else {
    command.push(
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="on-request"',
    );
  }

  const notifyPath = resolve(
    options.worktreePath,
    ".codex",
    CODEX_NOTIFY_SCRIPT,
  );
  command.push(
    ...buildCodexTrustArgs(options.worktreePath),
    "-c",
    `mcp_servers.hive.url=${tomlString(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
    "-c",
    `notify=[${tomlString(notifyPath)}]`,
  );

  return command;
}

export async function writeCodexAgentConfig(
  worktreePath: string,
  options: CodexAgentConfigOptions,
): Promise<void> {
  const codexDirectory = join(worktreePath, ".codex");
  const notifyPath = join(codexDirectory, CODEX_NOTIFY_SCRIPT);
  await mkdir(codexDirectory, { recursive: true });

  const notifyScript = [
    "#!/bin/sh",
    [
      "exec hive event turn-end",
      "--agent",
      shellToken(options.name),
      "--port",
      String(options.daemonPort),
      '--payload "$1"',
    ].join(" "),
    "",
  ].join("\n");
  const config = [
    "[mcp_servers.hive]",
    `url = ${tomlString(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
    "",
  ].join("\n");

  await Promise.all([
    writeFile(join(codexDirectory, "config.toml"), config),
    writeFile(notifyPath, notifyScript, { mode: 0o755 }),
  ]);
  await chmod(notifyPath, 0o755);
}
