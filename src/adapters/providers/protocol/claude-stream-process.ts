export const CLAUDE_CHANNELS_WARNING =
  /WARNING:\s*Loading development channels|Channels are enabled|MCP channels? enabled/i;

export const CLAUDE_CHANNELS_ENABLEMENT =
  /channelsEnabled|channel_enable|tengu_mcp_channel_enable|--channels?\b|CLAUDE_[A-Z0-9_]*CHANNEL[A-Z0-9_]*=(?:1|true)/i;

interface ClaudeProcessInput {
  write(data: string): void;
  end(): void;
}

export interface ClaudeProcess {
  readonly pid: number;
  readonly stdin: ClaudeProcessInput;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
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
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: { ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  return {
    pid: child.pid,
    stdin: {
      write(data: string): void {
        child.stdin.write(data);
      },
      end(): void {
        child.stdin.end();
      },
    },
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill(signal?: number | NodeJS.Signals): void {
      child.kill(signal);
    },
  };
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
