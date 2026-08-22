import { createHash } from "node:crypto";
import { runGit } from "../../adapters/git";
import { type AgentRecord, isOrchestratorName } from "../../schemas/agent";
import { isString } from "../../shared/is-record";
import {
  type HandoffBundle,
  type HandoffSummary,
  HandoffBundleSchema,
} from "../../schemas/handoff-schema";
import type { MemoryFact } from "../../schemas/memory";
import type { ProviderEvent } from "../../schemas/provider-communication";
import type { ProviderRun } from "../../schemas/provider-run";
import type { WorkspaceEventV2 } from "../../schemas/status-envelope";
import type { MailItem } from "../../schemas/mail";
import {
  type RedactedText,
  redactTerminalEvidence,
} from "../status-service/status-service";
import type { SessiondOutputObservation } from "../session-host/sessiond-output-observer";

const FALLBACK_TAIL_BYTES = 2_000;

/** The fallback summary clips only text the redactor has vouched for. Typing the input as RedactedText makes the ordering structural: raw pane text cannot reach the slice, so a later edit cannot leak unredacted evidence by reordering the calls. */
function redactedTail(text: RedactedText): string {
  return text.trim().slice(-FALLBACK_TAIL_BYTES);
}

export type MeasuredHandoffWorktree = HandoffBundle["worktree"] &
  HandoffBundle["branch"];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args, { killSignal: "SIGKILL" });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? "command"} failed: ${result.stderr.trim() || result.exitCode}`,
    );
  }
  return result.stdout.trim();
}

export async function measureHandoffWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<MeasuredHandoffWorktree> {
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  const base = await git(repoRoot, ["merge-base", "HEAD", head]);
  const [dirty, untracked, log] = await Promise.all([
    git(worktreePath, ["diff", "--name-only", "HEAD"]),
    git(worktreePath, ["ls-files", "--others", "--exclude-standard"]),
    git(worktreePath, ["log", "--format=%H%x00%s", `${base}..${head}`]),
  ]);
  return {
    name: branch,
    base,
    head,
    dirtyPaths: dirty === "" ? [] : dirty.split("\n").sort(),
    untrackedPaths: untracked === "" ? [] : untracked.split("\n").sort(),
    commits:
      log === ""
        ? []
        : log.split("\n").map((line) => {
            const split = line.indexOf("\0");
            return {
              id: split < 0 ? line : line.slice(0, split),
              subject: split < 0 ? "" : line.slice(split + 1),
            };
          }),
  };
}

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const latestStatusReport = (
  events: readonly WorkspaceEventV2[],
): WorkspaceEventV2 | null =>
  events.filter((event) => event.kind === "agent.status-reported").at(-1) ??
  null;

function fallbackSummary(
  agent: AgentRecord,
  report: WorkspaceEventV2 | null,
  output: SessiondOutputObservation | null,
): HandoffSummary {
  const summary =
    report !== null && isString(report.data.summary)
      ? report.data.summary
      : null;
  const blocker =
    report !== null && isString(report.data.blocker)
      ? report.data.blocker
      : null;
  const nextAction =
    report !== null && isString(report.data.nextCheckpoint)
      ? report.data.nextCheckpoint
      : null;
  const tail = redactedTail(redactTerminalEvidence(output?.screen ?? ""));
  return {
    goal: agent.taskDescription,
    done: [
      ...(summary === null ? [] : [summary]),
      ...(tail === "" ? [] : [`Retained terminal tail:\n${tail}`]),
    ],
    remaining: blocker === null ? [] : [blocker],
    decisions: [],
    failedApproaches: [],
    uncertainty: [
      "Generated summarization was unavailable; this summary contains only measured status and retained terminal evidence.",
    ],
    nextAction,
    provenance: "fallback",
  };
}

function explicitMemoryRefs(
  report: WorkspaceEventV2 | null,
  memory: readonly MemoryFact[],
): HandoffBundle["memoryRefs"] {
  const evidence =
    report !== null && Array.isArray(report.data.evidenceRefs)
      ? report.data.evidenceRefs.filter((value): value is string =>
          isString(value),
        )
      : [];
  return memory
    .filter((fact) =>
      evidence.some(
        (ref) =>
          ref === fact.path ||
          ref === `${fact.scope}:${fact.id}` ||
          ref === `memory:${fact.scope}:${fact.id}`,
      ),
    )
    .map((fact) => ({
      scope: fact.scope,
      id: fact.id,
      digest: digest(fact.body),
      retrieval: {
        tool: "memory_read" as const,
        arguments: { scope: fact.scope, id: fact.id },
      },
    }));
}

export interface BuildHandoffBundleInput {
  handoffId: string;
  reason: HandoffBundle["reason"];
  agent: AgentRecord;
  run: ProviderRun;
  measurement: MeasuredHandoffWorktree | null;
  mail: readonly MailItem[];
  providerEvents: readonly ProviderEvent[];
  statusEvents: readonly WorkspaceEventV2[];
  output: SessiondOutputObservation | null;
  memory: readonly MemoryFact[];
  createdAt: string;
  summarize?: () => Promise<Omit<HandoffSummary, "provenance">>;
}

export async function buildHandoffBundle(
  input: BuildHandoffBundleInput,
): Promise<HandoffBundle> {
  if (
    input.run.agentId !== input.agent.id ||
    input.run.provider !== input.agent.tool ||
    input.run.model === null ||
    input.run.model !== input.agent.model
  ) {
    throw new Error("provider run does not match the handoff source agent");
  }
  const report = latestStatusReport(input.statusEvents);
  let summary: HandoffSummary;
  try {
    summary =
      input.summarize === undefined
        ? fallbackSummary(input.agent, report, input.output)
        : { ...(await input.summarize()), provenance: "generated" };
  } catch {
    summary = fallbackSummary(input.agent, report, input.output);
  }
  const requirements = input.mail.filter((item) =>
    isOrchestratorName(item.sender),
  );
  const measurement = input.measurement;
  return HandoffBundleSchema.parse({
    handoffId: input.handoffId,
    sourceRunId: input.run.runId,
    runOutcome: {
      decisionId: input.run.launchGrantId,
      providerRunId: input.run.runId,
      provider: input.run.provider,
      model: input.run.model,
      taskCategory: input.agent.category,
      outcome: {
        "quota-drain": "quota-drained",
        "capability-wall": "capability-escalated",
        crash: "crashed",
        user: "stopped",
      }[input.reason],
      handoffId: input.handoffId,
      startedAt: input.run.startedAt,
      endedAt: input.createdAt,
    },
    reason: input.reason,
    originalTaskRef: {
      kind: "agent-task",
      agentId: input.agent.id,
      content: input.agent.taskDescription,
      digest: digest(input.agent.taskDescription),
    },
    requirementRefs: requirements.map((item) => ({
      kind: "message",
      id: item.itemId,
      content: item.body,
      digest: digest(item.body),
    })),
    branch: {
      name: input.agent.branch ?? "(unknown)",
      base: measurement?.base ?? "unknown",
      head: measurement?.head ?? "unknown",
    },
    worktree: {
      dirtyPaths: measurement?.dirtyPaths ?? [],
      untrackedPaths: measurement?.untrackedPaths ?? [],
      commits: measurement?.commits ?? [],
    },
    messagesThrough: input.mail.reduce(
      (through, item) => Math.max(through, item.seq),
      0,
    ),
    pendingMessageIds: input.mail.map((item) => item.itemId),
    memoryRefs: explicitMemoryRefs(report, input.memory),
    activity: {
      providerEventRefs: input.providerEvents.map((event) => event.eventId),
      terminalOutputRanges:
        input.output === null
          ? []
          : [
              {
                terminal: input.output.locator,
                through: input.output.outputThrough,
                digest: digest(input.output.screen),
                bytes: Buffer.byteLength(input.output.screen),
                completeness: input.output.completeness,
              },
            ],
      providerTranscriptRefs: [],
      statusReportRef: report?.eventId ?? null,
    },
    summary,
    completeness:
      measurement === null
        ? "unknown"
        : input.output === null || input.output.completeness === "gap"
          ? "partial"
          : "complete",
    createdAt: input.createdAt,
  });
}
