// Owns the Claude child-process contract and transport-level channel guards
// shared by the runtime adapter and stream session.

export const CLAUDE_CHANNELS_WARNING =
  /WARNING:\s*Loading development channels|Channels are enabled|MCP channels? enabled/i;

export const CLAUDE_CHANNELS_ENABLEMENT =
  /channelsEnabled|channel_enable|tengu_mcp_channel_enable|--channels?\b|CLAUDE_[A-Z0-9_]*CHANNEL[A-Z0-9_]*=(?:1|true)/i;

interface ClaudeProcessInput {
  write(data: string): unknown;
  end(): unknown;
}

export interface ClaudeProcess {
  readonly pid: number;
  readonly stdin: ClaudeProcessInput;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): unknown;
}

export type ClaudeProcessFactory = (
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  },
) => ClaudeProcess;

export function defaultProcessFactory(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  },
): ClaudeProcess {
  return Bun.spawn([...command], {
    cwd: options.cwd,
    env: { ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  }) as unknown as ClaudeProcess;
}

export function signalClaudeProcessGroup(
  child: ClaudeProcess,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
