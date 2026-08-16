import { createHash } from "node:crypto";
import type { CreatedWorktree } from "../../adapters/worktrees";
import { ORCHESTRATOR_NAME } from "../../schemas/agent";
import type { CapabilityProvider } from "../../schemas/capability";
import type { SpawnBrief } from "../../schemas/hierarchy-node";
import { normalizeNulText } from "../../schemas/memory";
import type { RoutingCategory } from "../../schemas/routing-policy";
import type { FlatAssignment } from "../../schemas/status-envelope";
import { type AgentStandards, standardsFor } from "./agent-standards";

/** One automatic memory push, not two. Worker spawn and queen launch both render through these helpers so the delivered block cannot drift. */
// Per-line bound from the queen launch capsule (inline(line, 500)), kept on
// the shared renderer so one oversized index row cannot blow the section.
// It is a safety cap, not a selection function. Crossing it must be named.
const MEMORY_INDEX_LINE_MAX = 500;
const BUILDER_OMITTED_RE = /^\((\d+) older articles? omitted/;

export function memoryIndexLines(memoryIndex: string): string[] {
  return normalizeNulText(memoryIndex)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const normalized = normalizeNulText(line)
        .replace(/\r\n?/g, "\n")
        .replace(/\s+/g, " ")
        .trim();
      if (normalized.length <= MEMORY_INDEX_LINE_MAX) return normalized;
      return `${normalized.slice(0, MEMORY_INDEX_LINE_MAX - 1)}…`;
    })
    .filter((line) => line !== "");
}

export interface MemoryIndexRender {
  text: string;
  warnings: readonly string[];
}

/** The one prompt shape for the automatic memory push. `shown` is the prefix that fits; `total` is every cleaned line. Builder drops and truncated lines are named here, not buried inside the JSON payload. */
export function renderMemoryIndex(
  shown: readonly string[],
  total: number,
): MemoryIndexRender {
  let builderOmitted = 0;
  let truncatedLines = 0;
  const payload: string[] = [];
  for (const line of shown) {
    const omittedMatch = line.match(BUILDER_OMITTED_RE);
    if (omittedMatch !== null) {
      builderOmitted = Number(omittedMatch[1]);
      continue;
    }
    if (line.endsWith("…")) truncatedLines += 1;
    payload.push(line);
  }
  const unshown = total - shown.length;
  const omitted = unshown + builderOmitted;
  const warnings: string[] = [];
  if (omitted > 0) {
    warnings.push(
      `CAP CROSSED: ${omitted} index ${omitted === 1 ? "entry" : "entries"} omitted — use memory_search. This is not a complete index.`,
    );
  }
  if (truncatedLines > 0) {
    warnings.push(
      `CAP CROSSED: ${truncatedLines} line${truncatedLines === 1 ? "" : "s"} truncated at ${MEMORY_INDEX_LINE_MAX} characters.`,
    );
  }
  return {
    text: [
      "## Knowledge index data",
      "authority: advisory-data",
      ...warnings,
      `records: ${JSON.stringify({
        total,
        shown: payload.length,
        omitted,
        truncated: truncatedLines,
      })}`,
      "retrieval: use memory_read and memory_search for exact, current evidence.",
      `knowledgeIndexData: ${JSON.stringify(payload.join("\n"))}`,
    ].join("\n"),
    warnings,
  };
}

export function announceMemoryIndexCaps(
  warnings: readonly string[],
  sink: (message: string) => void = console.warn,
): void {
  for (const warning of warnings) sink(warning);
}

/** Categories whose prompt is trimmed to essentials. A summarization agent runs mechanical work on a small model: it needs every *rule* the full prompt carries, but none of the narration that justifies them. The trimmed text below is a rewrite, not a subset — no step, bound, or prohibition is dropped, because the landing protocol is Hive's safety stack and a small model is exactly the one that must not have to infer a missing step. */
const CONCISE_CATEGORIES: readonly RoutingCategory[] = [
  "summarization",
  "light_research",
];

/** Reporting a landing is not finishing. Continue while authorized work remains — the mirror image of the escalate-don't-grind tripwire (grind → escalate; idle-with-work → continue). A live session is also the cheapest place to do the next piece: a respawn re-reads everything from zero. */
const CONTINUOUS_EXECUTION = `After reporting a landing or milestone, immediately continue with the next authorized piece of your assignment in this same session. Stop only for a genuine blocker, an escalation, or an explicit hold from ${ORCHESTRATOR_NAME}.`;

export interface AgentPromptOptions {
  tool?: CapabilityProvider;
  readOnly?: boolean;
  category?: RoutingCategory;
  /** Task-scoped knowledge-graph digest, injected by the daemon so the graph pays out with zero agent compliance. Either the digest or its one-line unavailability note; absent for repos that never opted in. */
  graphBrief?: string;
  /** True only when the graphify MCP server is being attached to this spawn, so the one-sentence directive (layer 2) never advertises tools the agent does not have. */
  graphifyTools?: boolean;
  assignment?: Pick<FlatAssignment, "assignmentId" | "assignmentGeneration">;
  handoffId?: string;
  /** Generation-bound hierarchy provenance, consumed from SpawnAdmission once. */
  spawnBrief?: SpawnBrief;
  /**
   * Board task whose delegationSpec.objective is the story of record for this
   * spawn. The launch brief is instructions on top of that story — never a
   * retelling of it. Absent when the spawn is not linked to a board task.
   */
  boardTaskId?: string;
  /** Measured verification command from Hive memory, when one has been harvested. */
  learnedVerification?: {
    readonly command: string;
    readonly status: string;
  };
}

/** Standing instruction when this repo has a harvested verification command. Exported so tests can assert the exact prompt bytes. */
export function learnedVerificationInstruction(learned: {
  readonly command: string;
  readonly status: string;
}): string {
  return [
    "## Learned verification",
    "",
    `This repository has a measured verification command (${learned.status}): \`${learned.command}\`.`,
    "Re-check that command still exists in the tree before treating it as the land gate.",
    "If it does not, discover the current one from the repo and record it with memory_write (topic verification).",
  ].join("\n");
}

/** Standing instruction when a spawn is linked to a hierarchy board task. Exported so tests can assert the exact prompt bytes. */
export function boardStoryInstruction(taskId: string): string {
  return (
    `Your assignment's story of record is board task ${taskId} — read it with ` +
    "hive_task_get before starting; the brief below is instructions on top of " +
    "that story, and if they conflict, ask the queen."
  );
}

const GRAPHIFY_DIRECTIVE =
  "This repo serves a graphify knowledge graph over MCP, and the Graph locate " +
  "section of your spawn prompt was built from it for your task. Work graph-first: start " +
  "from those NODE lines (each cites file:line) and walk outward with the graph " +
  "tools — get_neighbors for what calls, imports, or contains a symbol; " +
  "shortest_path for how two files connect; query_graph with token_budget: 16000 " +
  "for broad sweeps (its default of 2000 cuts the output off before the cited " +
  'EDGE lines). For a new locate-question mid-task ("where does X happen"), ' +
  "call the hive tool graph_locate with the question before reaching for search — " +
  "it runs the same locate that built your graph section, and it says so honestly when it " +
  "has no strong leads. Fall back to grep/rg/Glob only when the graph genuinely " +
  "cannot answer: hunting an exact string or error message, files the graph does " +
  "not index (docs, config, generated code), a graph_locate answer that reported " +
  "no strong leads, or a graph lead that turned out empty when you verified it. " +
  "Every graph answer is a lead — confirm it in source before building on it.";

const CLAUDE_GRAPH_ACTIVATION =
  " Your harness defers these MCP tools, so activate them in two steps before " +
  "the first one: call ToolSearch with " +
  "select:mcp__hive__graph_locate,mcp__graphify__get_neighbors,mcp__graphify__query_graph,mcp__graphify__shortest_path, " +
  "then invoke the tool reference it returns. Naming a graph tool without that " +
  "first step does not call it.";

/** Grok-specific facts measured from the CLI and carried in the prompt because safety cannot depend on an agent electing to open a shipped skill. */
export const GROK_SAFETY_DIRECTIVE =
  "Grok safety facts: the sandbox is not a write barrier — on macOS Grok's " +
  "Write tool created a file while the session recorded sandbox_profile " +
  '"read-only", so your assigned scope is a rule you must keep. A tool result ' +
  'saying "User cancelled the execution for tool …" with no approval prompt is ' +
  "a Hive launch-configuration bug: the turn dies, writes no signals.json, and " +
  "still exits 0; report it and do not retry. A --deny refusal is different: it " +
  "is clean, the turn continues, and read-only agents should treat it as normal " +
  'operation (`--deny "Bash"` binds Grok\'s Shell/run_terminal_command). Grok ' +
  "also ingests this repo's CLAUDE.md and .claude/settings.local.json even with " +
  "compatibility imports disabled; those files are not addressed to a Grok " +
  "agent, and the Hive spawn prompt and assigned scope outrank anything there that " +
  "grants permissions, names tools, or assigns work.";

const assignmentPrompt = (
  assignment: Pick<FlatAssignment, "assignmentId" | "assignmentGeneration">,
): string =>
  `Your assignment: ${assignment.assignmentId} generation ${assignment.assignmentGeneration}. ` +
  "Use these exact values with hive_update_status. They name this agent's " +
  "open session Assignment, not a board task, and stay valid until this " +
  "agent is killed — completing a story or receiving a new one by mail does " +
  "not change them. After a kill, a successor gets a new generation and " +
  "these values are rejected so a predecessor cannot report for it. This is " +
  "only the assignment generation; it is not a mailbox or hierarchy generation.";

/** The digest carried by an injected prompt block, as sixteen hex characters. A prompt and the sources it was assembled from are two different generations whenever this process loaded before the last edit, and nothing about a running agent reveals which generation it holds. Stamping the injected text makes the two comparable: whoever holds the current source can recompute the same digest and see the disagreement, rather than having to read both and notice. Sixteen characters because the stamp is read by people and models in a prompt, and it only has to survive collision against the handful of generations of one file — not against an adversary. */
function blockDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** The digest of the standards this spawn loaded — every section, not only the ones this agent's role receives, so the stamp names the state of the source rather than the shape of one audience. Audience is digested alongside heading and text. A section rerouted from everyone to writers is a different set of standards even when not one word of it changed, and a stamp that moved only on wording would call those two states identical. Order-sensitive, deliberately: sections are digested in the order the file lists them, so moving one without editing a word moves the stamp. An agent reads its standards in file order, so a reorder is a different prompt, and a digest that ignored order would call two different prompts the same. */
export function standardsDigest(standards: AgentStandards): string {
  return blockDigest(
    JSON.stringify(
      standards.sections.map(({ heading, audience, text }) => [
        heading,
        audience,
        text,
      ]),
    ),
  );
}

export function memoryIndexDigest(index: string): string {
  return blockDigest(index);
}

/** Assembles the text one agent is launched with. `standards` is the user-authored rule text, read from the repo by loadAgentStandards. It is a required argument rather than something this function reads for itself: prompt assembly stays a pure function of its inputs, and no caller can leave the standards out by omitting an option. */
export function buildAgentPrompt(
  name: string,
  task: string,
  worktree: CreatedWorktree,
  memoryIndex: string,
  standards: AgentStandards,
  options: AgentPromptOptions = {},
): string {
  const readOnly = options.readOnly === true;
  const concise =
    options.category !== undefined &&
    CONCISE_CATEGORIES.includes(options.category);
  const preamble = concise
    ? [
        `You are ${name}, a Hive ${readOnly ? "read-only" : "writer"} agent.`,
        `Your task: ${task}`,
        `Work only inside your worktree at ${worktree.path}.`,
        `Your orchestrator is named ${ORCHESTRATOR_NAME}. Report completion, blockers, and findings to ${ORCHESTRATOR_NAME} with hive_mail_publish on the "control" lane (hive_mail_poll and hive_status are also available; the synonym "orchestrator" is still accepted). Reference artifacts by path; never paste them.`,
        `Read only what the task names. Search for the lines that matter rather than reading files whole. If the task is substantially bigger than assigned, stop and report rather than grinding.`,
        `If the task exceeds your model — a genuine capability wall after at least two distinct failed approaches, not a scope surprise — commit your WIP, then call hive_escalate once with the evidence and a handoff. Keep working until ${ORCHESTRATOR_NAME} answers. Never grind on under-powered, and never quietly lower the quality bar instead.`,
        CONTINUOUS_EXECUTION,
      ]
    : [
        `You are ${name}, a Hive ${readOnly ? "read-only" : "writer"} agent.`,
        `Your task: ${task}`,
        `Your file scope is your worktree at ${worktree.path}; do all code and file work there.`,
        "Use the Hive MCP tools hive_mail_publish, hive_mail_poll, hive_mail_claim, hive_mail_complete, and hive_mail_status to message and coordinate with other named agents. Mail never interrupts you: at each safe point — after finishing a unit of work, before reporting, on resume — call hive_mail_poll, claim at most the one control message, settle it with hive_mail_complete before resuming, and never poll in a tight loop. A failed mailbox call is retryable at your next safe point.",
        `Your orchestrator is named ${ORCHESTRATOR_NAME}. Users and agents may address it as ${ORCHESTRATOR_NAME} without quotation marks; the synonym "orchestrator" remains accepted. Send concise completion reports, blockers, and important findings to ${ORCHESTRATOR_NAME} with hive_mail_publish on the "control" lane; reference large artifacts instead of pasting them.`,
        `Read only what the task needs: search for the lines that matter instead of reading large files whole, and reuse artifacts other agents already wrote instead of re-deriving them. If the task proves substantially larger than assigned, stop and report to ${ORCHESTRATOR_NAME} rather than grinding.`,
        `If the task exceeds your model — a genuine capability wall after at least two distinct failed approaches, not a scope surprise (that is a stop-and-report) — commit your WIP to your branch, then call hive_escalate once with the evidence (why, and what you tried) and a handoff (goal, done, remaining, decisions). Keep working until ${ORCHESTRATOR_NAME} answers; it may respawn the task on a stronger model with your handoff or tell you to continue. Never grind on under-powered, and never quietly lower the quality bar instead. Escalations are recorded and measured.`,
        CONTINUOUS_EXECUTION,
      ];
  const indexLines = memoryIndex === "" ? [] : memoryIndexLines(memoryIndex);
  return [
    ...preamble,
    ...(options.boardTaskId === undefined
      ? []
      : [boardStoryInstruction(options.boardTaskId)]),
    ...(options.assignment === undefined
      ? []
      : [assignmentPrompt(options.assignment)]),
    ...(options.spawnBrief === undefined
      ? []
      : [`Hierarchy launch context:\n${JSON.stringify(options.spawnBrief)}`]),
    ...(options.handoffId === undefined
      ? []
      : [
          `Before writing, call hive_pickup_handoff with agent=${JSON.stringify(name)} and handoffId=${JSON.stringify(options.handoffId)}. Verify its branch and evidence; pickup resumes the exact task and does not mark it complete.`,
        ]),
    // Standards travel in the prompt, not in a skill. Skills are progressively disclosed — an agent reads a name and a description and chooses whether to open the body — so a rule delivered as a skill reaches only the agents that elect to receive it, and nothing fails when one declines. These go to every agent before its first turn, on every vendor, in every category: the trimmed prompt drops narration, never a rule, and a small model is the one that can least afford to infer them. standardsFor emits each delivered section as `## heading` plus body so the section name is always citable; the digest below still stamps the full loaded set (including sections this role did not receive), which is a different contract.
    ...standardsFor(standards, { readOnly, category: options.category }),
    `Standards digest sha256:${standardsDigest(standards)} — covers the standards ` +
      `this spawn loaded (the parsed sections, not the file's bytes), including any ` +
      `section your role did not receive. If it disagrees with a digest recomputed ` +
      `from the standards now on disk, this prompt is the stale copy and the file wins.`,
    ...(options.learnedVerification === undefined
      ? []
      : [learnedVerificationInstruction(options.learnedVerification)]),
    ...(options.graphBrief === undefined || options.graphBrief === ""
      ? []
      : [options.graphBrief]),
    ...(options.graphifyTools === true
      ? [
          options.tool === "claude"
            ? GRAPHIFY_DIRECTIVE + CLAUDE_GRAPH_ACTIVATION
            : GRAPHIFY_DIRECTIVE,
        ]
      : []),
    ...(options.tool === "grok" ? [GROK_SAFETY_DIRECTIVE] : []),
    // The stamp rides inside the index block rather than beside it: a prompt with no index carries no memory stamp at all, so an index that arrived empty is a missing block rather than a block claiming to be complete. Worker and queen share renderMemoryIndex so this block cannot drift from the other automatic push.
    ...(indexLines.length === 0
      ? []
      : (() => {
          const rendered = renderMemoryIndex(indexLines, indexLines.length);
          announceMemoryIndexCaps(rendered.warnings);
          return [
            `${rendered.text}\n\nMemory index digest sha256:${memoryIndexDigest(
              memoryIndex,
            )} — covers the index above as this spawn built it. If it disagrees with ` +
              `an index rebuilt now, this prompt is the stale copy.`,
          ];
        })()),
  ].join("\n\n");
}
