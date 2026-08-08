import type { CapabilityProvider } from "../../schemas/capability";
import { processCommandName } from "../resource-management/resources";

function launchedCommandName(argv: string[]): string {
  return processCommandName(argv[0] ?? "");
}

export interface AgentUiLaunchOptions {
  readonly hiveCommand: readonly string[];
  readonly subject: string;
  readonly provider: CapabilityProvider;
  readonly executable: string;
  readonly daemonPort: number;
  readonly providerRunId: string;
  readonly worktreePath: string;
  readonly journalPath: string;
  readonly model: string;
  readonly effort?: string;
  readonly readOnly: boolean;
  readonly instructionPath: string;
  readonly kickoff: string;
  readonly providerArgv: readonly string[];
}

export function agentUiLaunchArgv(options: AgentUiLaunchOptions): string[] {
  if (options.providerRunId === "") {
    throw new Error(
      `Cannot launch ${options.subject}: provider run identity is unavailable`,
    );
  }
  return [
    ...options.hiveCommand,
    "agent-ui",
    "--subject",
    options.subject,
    "--provider",
    options.provider,
    "--executable",
    options.executable,
    "--port",
    String(options.daemonPort),
    "--provider-run-id",
    options.providerRunId,
    "--worktree",
    options.worktreePath,
    "--journal",
    options.journalPath,
    "--model",
    options.model,
    ...(options.effort === undefined ? [] : ["--effort", options.effort]),
    ...(options.readOnly ? ["--read-only"] : []),
    "--instruction",
    options.instructionPath,
    "--provider-argv",
    JSON.stringify(options.providerArgv),
    "--kickoff",
    options.kickoff,
  ];
}

export function protocolProviderArgv(
  provider: CapabilityProvider,
  nativeArgv: readonly string[],
): string[] {
  if (provider === "claude") return nativeArgv.slice(1);
  if (provider !== "codex") return [];
  const argv: string[] = [];
  for (let index = 1; index < nativeArgv.length; index += 1) {
    const value = nativeArgv[index + 1];
    if (nativeArgv[index] !== "-c" || value === undefined) continue;
    argv.push("-c", value);
    index += 1;
  }
  return argv;
}

export { launchedCommandName };
