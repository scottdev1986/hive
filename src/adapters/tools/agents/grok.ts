import {
  GrokCapabilityProbe,
  GrokCliCapabilityTransport,
} from "../../../daemon/capability-discovery";
import { wrapGrokWithRulesFile } from "../../../daemon/launch-prompt";
import { shellJoin } from "../../../daemon/session-host/shell-session";
import { wrapSpawnWithCapabilityEnv } from "../capability-env";
import {
  buildGrokResumeCommand,
  buildGrokSpawnCommand,
  type GrokSpawnOptions,
  inspectGrokProjectTrust,
  resolveWorkingGrokExecutable,
  wrapGrokSpawnWithCompatibilityEnv,
  writeGrokAgentConfig,
} from "../grok";
import type { AgentAdapter } from "./agent-adapter";

export const grokAgentAdapter: AgentAdapter = {
  id: "grok",
  // Project hooks cover session, turn, tool, failure, and compaction events,
  // but only fire once the user trusts the worktree — that is Grok's own
  // behaviour, not a gate Hive applies. Hive writes the hook config
  // unconditionally (see prepareSpawn: the write happens before trust is even
  // inspected) and only REPORTS what trust it observed, degrading the evidence
  // it claims when the worktree is untrusted or unverifiable. Trust-reported,
  // never trust-gated. updates.jsonl remains the only structured interrupted
  // source, and approval-waiting remains terminal-only.
  communication: {
    provider: "grok",
    eventSource: "hooks",
    nativeDelivery: false,
    toolBoundaryEvents: true,
    turnBoundaryEvents: true,
    transcriptReader: true,
    nativeCancel: false,
    conversationResume: true,
  },
  async prepareSpawn(context) {
    if (context.providerRunId === undefined) {
      throw new Error("Grok launch requires a provider run id");
    }
    await writeGrokAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      name: context.name,
      providerRunId: context.providerRunId,
      ...(context.hiveCommand === undefined
        ? {}
        : { hiveCommand: context.hiveCommand }),
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
    });
    if (context.executable !== undefined) {
      const trust = inspectGrokProjectTrust(
        context.worktreePath,
        context.executable,
      );
      if (trust === "untrusted") {
        console.warn(
          `Grok hooks are unavailable for ${context.name} until the user trusts ` +
            `${context.worktreePath}; the agent will run normally using updates.jsonl, terminal, and process evidence.`,
        );
      } else if (trust === "trusted") {
        console.warn(
          // Name settings.local.json first: it is the file that actually exists
          // in a Hive worktree (see the worktree wiring list), so warning only
          // about settings.json named the file least likely to fire.
          `Grok reads project .claude/settings.local.json and .claude/settings.json ` +
            `hooks in trusted worktrees; any such hooks in ${context.worktreePath} ` +
            "are user-owned and may also fire.",
        );
      } else {
        console.warn(
          `Hive could not verify Grok hook trust for ${context.worktreePath}; ` +
            "the agent will run normally using updates.jsonl, terminal, and process evidence.",
        );
      }
    }
    const options: GrokSpawnOptions = {
      model: context.model,
      ...(context.effort === undefined ? {} : { effort: context.effort }),
      worktreePath: context.worktreePath,
      readOnly: context.readOnly,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
    };
    const argv =
      context.resumeSessionId !== undefined
        ? buildGrokResumeCommand(options, context.resumeSessionId)
        : buildGrokSpawnCommand({
            ...options,
            ...(context.newVendorSessionId === undefined
              ? {}
              : { sessionId: context.newVendorSessionId }),
          });
    let command = shellJoin(argv);
    if (context.instructionPath !== undefined) {
      command = wrapGrokWithRulesFile(
        command,
        context.instructionPath,
        context.kickoff,
      );
    }
    command = wrapGrokSpawnWithCompatibilityEnv(command);
    if (context.withCapability === true) {
      command = wrapSpawnWithCapabilityEnv(command, context.name);
    }
    return { argv, command };
  },
  discover: (executable = resolveWorkingGrokExecutable()?.path ?? "grok") =>
    new GrokCapabilityProbe(new GrokCliCapabilityTransport(executable)).read(),
};
