import { join } from "node:path";
import { unknownVendor, type CapabilityProvider } from "../../schemas/capability";
import {
  buildClaudeResumeCommand,
  buildClaudeSpawnCommand,
  resolveWorkingClaudeExecutable,
  seedClaudeWorktreeTrust,
  writeClaudeAgentConfig,
  type ClaudeSpawnOptions,
} from "./claude";
import {
  buildCodexResumeCommand,
  buildCodexSpawnCommand,
  resolveWorkingCodexExecutable,
  wrapCodexSpawnWithCapabilityEnv,
  writeCodexAgentConfig,
  type CodexSpawnOptions,
} from "./codex";
import {
  buildGrokResumeCommand,
  buildGrokSpawnCommand,
  resolveWorkingGrokExecutable,
  wrapGrokSpawnWithCompatibilityEnv,
  writeGrokAgentConfig,
  type GrokSpawnOptions,
} from "./grok";
import {
  buildKimiResumeCommand,
  buildKimiSpawnCommand,
  resolveWorkingKimiExecutable,
  wrapKimiSpawnWithEffort,
  wrapKimiWithInstructionFile,
  writeKimiAgentConfig,
  type KimiSpawnOptions,
} from "./kimi";
import {
  ClaudeCapabilityProbe,
  ClaudeStdioCapabilityTransport,
  CodexCapabilityProbe,
  CodexStdioCapabilityTransport,
  GrokCapabilityProbe,
  GrokCliCapabilityTransport,
  KimiCapabilityProbe,
  KimiCliCapabilityTransport,
  type CapabilityDiscoveryResult,
} from "../../daemon/capability-discovery";
import {
  codexInstructionProfileName,
  wrapCodexWithInstructionProfile,
  wrapGrokWithRulesFile,
  writeCodexInstructionProfile,
} from "../../daemon/launch-prompt";
import { shellJoin } from "../../daemon/session-host/shell-session";

/**
 * The ONE vendor adapter surface behind the spawn path (#38).
 *
 * Everything the daemon used to branch on `switch (tool)` for at launch time
 * lives behind this interface: worktree preparation, the agent config write,
 * argv construction, the launch-shell wrapping (capability token, instruction
 * profile, rules file), and runtime model discovery. The per-vendor builder
 * functions in claude.ts / codex.ts / grok.ts / kimi.ts are unchanged — the
 * adapters here delegate to them; nothing about how a vendor is launched was
 * rewritten.
 *
 * What is deliberately NOT here: crash-recovery resume wiring (recovery.ts
 * keeps its own test-seamed switch), the orchestrator's structurally
 * different root launch (cli/orchestrator.ts), and billing/quota surfaces.
 */

/**
 * Everything a launch needs that is not vendor-specific. The permission
 * posture is the pair (readOnly, dangerous) — Hive's manual /
 * sandboxed-autonomous / unsafe-bypass modes — and each adapter maps it to
 * its vendor-native flags and config. That mapping lives ONLY in the
 * adapters; call sites never translate it themselves.
 *
 * The vendor-specific extras at the bottom are read only by the adapter whose
 * vendor they name; a call site that cannot know them leaves them undefined.
 */
export interface SpawnContext {
  name: string;
  model: string;
  effort?: string;
  worktreePath: string;
  daemonPort: number;
  readOnly: boolean;
  dangerous: boolean;
  executable?: string;
  /** Exact argv prefix for this Hive build, forwarded into hook commands. */
  hiveCommand?: readonly string[];
  /** Minted capability; enters the process through the launch shell or a
   * 0600 file, never an argv. */
  capabilityToken?: string;
  graphifyUrl?: string;
  /** 0600 launch-prompt file. Each vendor consumes it natively: claude reads
   * it as a system-prompt file, codex through its instruction profile, grok
   * as `--rules`, kimi installed as the worktree's `.kimi-code/AGENTS.md`.
   * Absent (crash recovery with no prompt on disk) means no instruction is
   * wired at all. */
  instructionPath?: string;
  /** Hive's session-locator id; codex names its instruction profile from it. */
  sessionId?: string;
  /** The opening instruction. Claude and codex take it as the positional
   * launch argument, grok as the trailing prompt of its rules wrap, kimi as
   * the closing section of its AGENTS.md copy (its TUI rejects a positional). */
  kickoff?: string;
  /** Resume this vendor session instead of starting a fresh one. */
  resumeSessionId?: string;
  /** claude: grant a read-only session `Bash(gh:*)` for board management. */
  boardTools?: boolean;
  /** codex: user-config MCP servers to detach for this process only. */
  excludeMcpServers?: readonly string[];
  /** grok: Hive-minted id for `--session-id` (grok has no session-id hook
   * channel, so Hive assigns one at creation). Never a resume id. */
  newVendorSessionId?: string;
}

export interface PreparedSpawn {
  /** The vendor argv, before the kickoff positional and shell wrapping. */
  argv: string[];
  /** The complete command handed to the session host: argv joined, kickoff
   * appended, and the vendor's launch-shell wrapping applied. */
  command: string;
}

export interface VendorAdapter {
  readonly id: CapabilityProvider;
  /** Worktree preparation that must precede the config write. Only claude
   * has one: folder-trust seeding, without which the CLI discards the hooks
   * and permissions the config write is about to lay down. */
  prepareWorktree?(worktreePath: string): Promise<void>;
  /** The vendor-specific copy of the launch instructions, when the vendor
   * cannot read the shared 0600 prompt file directly. Only codex has one:
   * its ephemeral developer-instructions profile. */
  writeInstructionCopy?(sessionId: string, prompt: string): Promise<void>;
  /** Write the worktree config and build the launch. A throw here is a local
   * failure — nothing has reached the vendor yet. */
  prepareSpawn(context: SpawnContext): Promise<PreparedSpawn>;
  /** The vendor's own runtime model catalog, read for free from the
   * signed-in CLI. Discovery is facts only — it never grants consent, and an
   * unreadable catalog comes back `unavailable` with the reason, never as an
   * empty list. Defaults to the resolved working executable. */
  discover(executable?: string): Promise<CapabilityDiscoveryResult>;
}

const claudeAdapter: VendorAdapter = {
  id: "claude",
  prepareWorktree: seedClaudeWorktreeTrust,
  async prepareSpawn(context) {
    await writeClaudeAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      name: context.name,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      ...(context.boardTools === undefined ? {} : { boardTools: context.boardTools }),
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
      ...(context.hiveCommand === undefined
        ? {}
        : { hiveCommand: context.hiveCommand }),
    });
    const options: ClaudeSpawnOptions = {
      daemonPort: context.daemonPort,
      model: context.model,
      ...(context.effort === undefined ? {} : { effort: context.effort }),
      name: context.name,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      worktreePath: context.worktreePath,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
      // Agent launches are always scoped to the worktree's own `.mcp.json` —
      // the file writeClaudeAgentConfig just wrote — so `--strict-mcp-config`
      // drops everything the human configured for interactive sessions.
      scopedMcpConfigPath: join(context.worktreePath, ".mcp.json"),
      ...(context.instructionPath === undefined
        ? {}
        : { appendSystemPromptFile: context.instructionPath }),
    };
    const argv = context.resumeSessionId === undefined
      ? buildClaudeSpawnCommand(options)
      : buildClaudeResumeCommand(options, context.resumeSessionId);
    return {
      argv,
      command: shellJoin(
        context.kickoff === undefined ? argv : [...argv, context.kickoff],
      ),
    };
  },
  discover: (executable = resolveWorkingClaudeExecutable().path) =>
    new ClaudeCapabilityProbe(
      new ClaudeStdioCapabilityTransport(
        [
          executable,
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        [executable],
      ),
    ).read(),
};

const codexAdapter: VendorAdapter = {
  id: "codex",
  writeInstructionCopy: async (sessionId, prompt) => {
    await writeCodexInstructionProfile(sessionId, prompt);
  },
  async prepareSpawn(context) {
    await writeCodexAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      name: context.name,
      readOnly: context.readOnly,
      ...(context.hiveCommand === undefined
        ? {}
        : { hiveCommand: context.hiveCommand }),
      ...(context.capabilityToken === undefined
        ? {}
        : { capabilityToken: context.capabilityToken }),
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
    });
    const withInstructions = context.instructionPath !== undefined &&
      context.sessionId !== undefined;
    const options: CodexSpawnOptions = {
      daemonPort: context.daemonPort,
      effort: context.effort ?? "medium",
      model: context.model,
      name: context.name,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      worktreePath: context.worktreePath,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
      excludeMcpServers: context.excludeMcpServers ?? [],
      withCapabilityToken: context.capabilityToken !== undefined,
      ...(withInstructions
        ? { profile: codexInstructionProfileName(context.sessionId!) }
        : {}),
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
    };
    const argv = context.resumeSessionId === undefined
      ? buildCodexSpawnCommand(options)
      : buildCodexResumeCommand(options, context.resumeSessionId);
    let command = shellJoin(
      context.kickoff === undefined ? argv : [...argv, context.kickoff],
    );
    // The token value enters through the launch shell, never an argv.
    if (context.capabilityToken !== undefined) {
      command = wrapCodexSpawnWithCapabilityEnv(command, context.worktreePath);
    }
    if (withInstructions) {
      command = wrapCodexWithInstructionProfile(command, context.sessionId!);
    }
    return { argv, command };
  },
  discover: (executable = resolveWorkingCodexExecutable()?.path ?? "codex") =>
    new CodexCapabilityProbe(
      new CodexStdioCapabilityTransport(
        [executable, "app-server", "--stdio"],
        [executable],
      ),
    ).read(),
};

const grokAdapter: VendorAdapter = {
  id: "grok",
  async prepareSpawn(context) {
    await writeGrokAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      ...(context.capabilityToken === undefined
        ? {}
        : { capabilityToken: context.capabilityToken }),
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
    });
    const options: GrokSpawnOptions = {
      model: context.model,
      ...(context.effort === undefined ? {} : { effort: context.effort }),
      worktreePath: context.worktreePath,
      readOnly: context.readOnly,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
    };
    const argv = context.resumeSessionId !== undefined
      ? buildGrokResumeCommand(options, context.resumeSessionId)
      : buildGrokSpawnCommand({
        ...options,
        ...(context.newVendorSessionId === undefined
          ? {}
          : { sessionId: context.newVendorSessionId }),
      });
    // Grok takes no positional kickoff: the opening instruction rides the
    // rules wrap as its trailing prompt. The compatibility env disables
    // inheritance of the operator's Claude/Cursor surface.
    let command = shellJoin(argv);
    if (context.instructionPath !== undefined) {
      command = wrapGrokWithRulesFile(
        command,
        context.instructionPath,
        context.kickoff,
      );
    }
    return { argv, command: wrapGrokSpawnWithCompatibilityEnv(command) };
  },
  discover: (executable = resolveWorkingGrokExecutable()?.path ?? "grok") =>
    new GrokCapabilityProbe(new GrokCliCapabilityTransport(executable)).read(),
};

const kimiAdapter: VendorAdapter = {
  id: "kimi",
  async prepareSpawn(context) {
    await writeKimiAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      ...(context.capabilityToken === undefined
        ? {}
        : { capabilityToken: context.capabilityToken }),
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
    });
    const options: KimiSpawnOptions = {
      model: context.model,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
    };
    const argv = context.resumeSessionId === undefined
      ? buildKimiSpawnCommand(options)
      : buildKimiResumeCommand(options, context.resumeSessionId);
    // Kimi takes no positional kickoff: the interactive TUI rejects one, so
    // the brief and the opening instruction ride the .kimi-code/AGENTS.md
    // copy the wrap installs. Effort enters through the process environment
    // because Kimi has no effort flag.
    let command = shellJoin(argv);
    if (context.effort !== undefined) {
      command = wrapKimiSpawnWithEffort(command, context.effort);
    }
    if (context.instructionPath !== undefined) {
      command = wrapKimiWithInstructionFile(
        command,
        context.instructionPath,
        context.kickoff,
      );
    }
    return { argv, command };
  },
  discover: (executable = resolveWorkingKimiExecutable()?.path ?? "kimi") =>
    new KimiCapabilityProbe(new KimiCliCapabilityTransport(executable)).read(),
};

const ADAPTERS: Record<CapabilityProvider, VendorAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
  kimi: kimiAdapter,
};

/** The one registry lookup. The record makes a missing vendor a compile
 * error; the guard keeps a value that slipped past the types loud. */
export function getVendorAdapter(id: CapabilityProvider): VendorAdapter {
  const adapter: VendorAdapter | undefined = ADAPTERS[id];
  if (adapter === undefined) {
    return unknownVendor(id as never, "vendor adapter registry");
  }
  return adapter;
}
