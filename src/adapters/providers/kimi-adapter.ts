import {
  KimiCapabilityProbe,
  KimiCliCapabilityTransport,
} from "../../daemon/capability-discovery";
import { hiveInstanceSuffix } from "../../daemon/instance-identity";
import { shellJoin } from "../../daemon/session-host/shell-session";
import {
  buildKimiResumeCommand,
  buildKimiSpawnCommand,
  type KimiSpawnOptions,
  kimiReadOnlyContainmentGap,
  resolveWorkingKimiExecutable,
  wrapKimiSpawnWithEffort,
  wrapKimiWithInstructionFile,
  wrapKimiWithTurnHookContext,
  writeKimiAgentConfig,
  writeKimiTurnHook,
} from "./kimi-cli";
import type { AgentAdapter } from "./provider-adapter";
import { wrapSpawnWithCapabilityEnv } from "./shared/capability-env";

export const kimiAgentAdapter: AgentAdapter = {
  id: "kimi",
  communication: {
    provider: "kimi",
    eventSource: "hooks",
    nativeDelivery: false,
    toolBoundaryEvents: false,
    // Kimi reads hook config only from user-level files Hive does not write:
    // no turn-start ever arrives and turn-end is sporadic at best. Claiming a
    // turn stream makes every busy kimi agent read as deaf ("no turn events
    // at all") and makes paste confirmation wait on a turn-start that never
    // comes; judging it by lastEventAt is the honest surface.
    turnBoundaryEvents: false,
    transcriptReader: false,
    nativeCancel: false,
    conversationResume: true,
  },
  /** Kimi's TUI takes no prompt from argv — it opens a composer and waits. Its
   * first turn is therefore typed in, as a bracketed paste so the TUI reads it
   * as one insertion, then Enter. This is Kimi's startup protocol and lives
   * here; the spawner only supplies a way to write to the terminal. */
  async startInitialTurn(input, kickoff) {
    await input.write(
      new TextEncoder().encode(`\x1b[200~${kickoff}\x1b[201~\r`),
      "kimi-kickoff",
    );
  },

  async prepareSpawn(context) {
    await writeKimiAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
    });
    if (context.providerRunId !== undefined) {
      await writeKimiTurnHook(context.hiveCommand);
    }
    // Read-only is a label Hive cannot enforce on this vendor. Say so at the
    // moment it stops being true, rather than letting the posture read as
    // contained on a launch that is not.
    if (context.readOnly && !context.dangerous) {
      const gap = kimiReadOnlyContainmentGap();
      if (gap !== null) console.error(`Hive ${context.name}: ${gap}`);
    }
    const options: KimiSpawnOptions = {
      model: context.model,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
    };
    const argv =
      context.resumeSessionId === undefined
        ? buildKimiSpawnCommand(options)
        : buildKimiResumeCommand(options, context.resumeSessionId);
    let command = shellJoin(argv);
    if (context.effort !== undefined) {
      command = wrapKimiSpawnWithEffort(command, context.effort);
    }
    if (context.withCapability === true) {
      command = wrapSpawnWithCapabilityEnv(command, context.name);
    }
    if (context.providerRunId !== undefined) {
      command = wrapKimiWithTurnHookContext(command, {
        name: context.name,
        daemonPort: context.daemonPort,
        instanceId: hiveInstanceSuffix(),
        providerRunId: context.providerRunId,
      });
    }
    // After the env prefixes, never before: the instruction wrapper leads with
    // its own `mkdir && install`, and an assignment placed in front of that
    // would reach those commands instead of kimi.
    if (context.instructionPath !== undefined) {
      command = wrapKimiWithInstructionFile(command, context.instructionPath);
    }
    return { argv, command };
  },
  discover: (executable = resolveWorkingKimiExecutable()?.path ?? "kimi") =>
    new KimiCapabilityProbe(new KimiCliCapabilityTransport(executable)).read(),
};
