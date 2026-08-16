// At session boundaries, the mistake-harvest pipeline proposes pitfall candidates for the REPO wiki. A signature observed once sets the episodic store's doorkeeper bit and writes no article; only a later boundary may create one. Admitted candidates remain unverified and require a different session to promote them. Titles and cluster keys come only from typed provenance fields (exit code, phase, blocker, command, tool, error). An absent field is unknown, never false: without a typed label the event is skipped and counted, never filled in from summary prose. The harvest read advances a per-agent high-water mark so each boundary only considers events not yet examined. Like every other memory projection, harvest is a derived write off the hot path: per-candidate failures are captured in the report, never thrown into the lifecycle path that triggered the harvest.

import type { MemoryScope, MemoryWriteInput } from "../schemas/memory";
import type { EpisodicEvent, EpisodicStore } from "./episodic";
import { discoverMemoryFacts, readMemoryFact } from "./memory-store";
import { normalizeTitle } from "./article-format";
import type { MemoryWriteFileResult } from "./store-records";
import { errorMessage } from "../shared/error-message";

export function isHarvestBoundaryEvent(
  kind: string,
  data: Record<string, unknown>,
): boolean {
  return /land|complete/i.test(kind) || data.phase === "complete";
}

interface ExactValue {
  kind: "sha256" | "sha" | "path" | "exit-code" | "error" | "count";
  value: string;
  eventId: number;
}

// Exact-value extraction: SHAs, file paths, error strings, exit codes, and typed counts are pulled out of the event's summary AND its provenance JSON into typed rows — never trusted to prose. Patterns are deliberately conservative: a false row costs a table line, a missed value costs a drill-down.
const SHA256_PATTERN = /\b[0-9a-f]{64}\b/g;
const SHA_PATTERN = /\b[0-9a-f]{40}\b/g;
const PATH_PATTERN = /\b(?:[\w@.~-]+\/)+[\w.@~-]+\b/g;
const EXIT_CODE_PATTERN =
  /\bexit(?:ed)?(?:\s+with)?(?:\s+code)?[\s:=]\s*(\d{1,5})\b/gi;
const ERROR_PATTERN = /\b(\w*(?:Error|Exception))\s*:?\s*([^\n;.]{0,100})/g;
const COUNT_PATTERN = /\b(\d+)\s+(commits?|files?|tests?|events?)\b/g;

function extractExactValues(event: EpisodicEvent, into: ExactValue[]): void {
  const text = `${event.summary} ${event.provenance}`;
  const push = (kind: ExactValue["kind"], value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > 0)
      into.push({ kind, value: trimmed, eventId: event.id });
  };
  for (const match of text.matchAll(SHA256_PATTERN)) push("sha256", match[0]);
  for (const match of text.matchAll(SHA_PATTERN)) push("sha", match[0]);
  for (const match of text.matchAll(PATH_PATTERN)) {
    if (!match[0].includes("://")) push("path", match[0]);
  }
  for (const match of text.matchAll(EXIT_CODE_PATTERN)) {
    if (match[1] !== undefined) push("exit-code", match[1]);
  }
  for (const match of text.matchAll(ERROR_PATTERN)) {
    const [, name, message] = match;
    if (name !== undefined && message !== undefined) {
      push("error", `${name}: ${message}`.replace(/:\s*$/, "").trim());
    }
  }
  for (const match of text.matchAll(COUNT_PATTERN)) {
    const [, count, unit] = match;
    if (count !== undefined && unit !== undefined)
      push("count", `${count} ${unit}`);
  }
}

type EpisodeOutcome = "failed" | "succeeded" | "unknown";

const SUCCESS_EVENT_TYPES = new Set(["agent.branch-landed"]);

function harvestHighWaterKey(agent: string): string {
  return `pitfall-harvest.high-water.${agent}`;
}

function readHarvestHighWater(store: EpisodicStore, agent: string): number {
  const raw = store.readMeta(harvestHighWaterKey(agent));
  if (raw === null) return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function writeHarvestHighWater(
  store: EpisodicStore,
  agent: string,
  eventId: number,
): void {
  store.writeMeta(harvestHighWaterKey(agent), String(eventId));
}

function eventData(event: EpisodicEvent): Record<string, unknown> {
  try {
    const provenance: unknown = JSON.parse(event.provenance);
    if (
      typeof provenance !== "object" ||
      provenance === null ||
      !("data" in provenance)
    ) {
      return {};
    }
    const data = provenance.data;
    return typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function episodeOutcome(event: EpisodicEvent): EpisodeOutcome {
  if (SUCCESS_EVENT_TYPES.has(event.type)) return "succeeded";

  const data = eventData(event);
  if (event.type === "agent.status-reported") {
    if (data.phase === "blocked") return "failed";
    if (data.phase === "complete") return "succeeded";
  }
  if (event.type === "status.turn") {
    if (data.value === "failed") return "failed";
    if (data.value === "done") return "succeeded";
  }
  if (typeof data.error === "string" && data.error.trim() !== "") {
    return "failed";
  }
  if (typeof data.exitCode === "number" && Number.isInteger(data.exitCode)) {
    return data.exitCode === 0 ? "succeeded" : "failed";
  }
  return "unknown";
}

const TITLE_MAX = 110;
const EXACT_VALUES_MAX = 12;
const ADVISORY_MAX = 3;
const harvestLocks = new WeakMap<EpisodicStore, Map<string, Promise<void>>>();

function harvestedSignatureKey(agent: string, signature: string): string {
  return `pitfall-harvest.persisted.${agent}.${signature}`;
}

function pruneHarvestReceipts(
  store: EpisodicStore,
  agent: string,
  highWater: number,
): void {
  const prefix = `pitfall-harvest.persisted.${agent}.`;
  for (const key of store.metaKeys(prefix)) {
    const persistedThrough = Number(store.readMeta(key));
    if (Number.isInteger(persistedThrough) && persistedThrough <= highWater) {
      store.deleteMeta(key);
    }
  }
}

function serializeAgentHarvest<T>(
  store: EpisodicStore,
  agent: string,
  operation: () => Promise<T>,
): Promise<T> {
  let locks = harvestLocks.get(store);
  if (locks === undefined) {
    locks = new Map();
    harvestLocks.set(store, locks);
  }
  const previous = locks.get(agent) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(agent, settled);
  void settled.then(() => {
    if (locks.get(agent) === settled) locks.delete(agent);
  });
  return run;
}

function sanitizeLabel(text: string): string {
  return text
    .replace(/\b(?:[\w@.~-]+\/)+[\w.@~-]+\b/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

interface FailureSignature {
  key: string;
  label: string;
}

/** Derive the cluster key and title label from typed provenance only. Summary prose is never consulted: an absent field is unknown, so this returns null and the caller counts a skip rather than inventing a label. */
function failureSignature(event: EpisodicEvent): FailureSignature | null {
  const data = eventData(event);

  const error = nonEmptyString(data.error) ?? nonEmptyString(data.errorName);
  if (error !== null) {
    const tool = nonEmptyString(data.tool);
    const raw = tool === null ? error : `${tool}: ${error}`;
    const label = sanitizeLabel(raw).slice(0, 80);
    if (label === "") return null;
    return { key: `error:${label.toLowerCase()}`, label };
  }

  if (typeof data.exitCode === "number" && Number.isInteger(data.exitCode)) {
    // Never mint an "(exit code 0)" title from prose or from a zero code.
    if (data.exitCode === 0) return null;
    const subject =
      nonEmptyString(data.command) ?? nonEmptyString(data.tool) ?? null;
    if (subject === null) {
      const label = `exit code ${data.exitCode}`;
      return { key: `exit:${data.exitCode}`, label };
    }
    const command = sanitizeLabel(subject);
    if (command === "") return null;
    const label = `${command} (exit code ${data.exitCode})`;
    return { key: `exit:${data.exitCode}:${command.toLowerCase()}`, label };
  }

  if (data.phase === "blocked") {
    const blocker = nonEmptyString(data.blocker);
    if (blocker === null) return null;
    const label = sanitizeLabel(blocker).slice(0, 80);
    if (label === "") return null;
    return { key: `phase:blocked:${label.toLowerCase()}`, label };
  }

  if (event.type === "status.turn" && data.value === "failed") {
    return { key: "status.turn:failed", label: "turn failed" };
  }

  return null;
}

export interface PitfallCandidate {
  id: string;
  title: string;
  action: "created" | "updated";
  signature: string;
  eventIds: number[];
  /** Advisory links (dedup layer 2, plan D1): similar-but-distinct articles the candidate body points at with "Possibly related:" — appended and linked, never merged. */
  related: Array<{ scope: MemoryScope; id: string; title: string }>;
}

export interface PitfallHarvestReport {
  candidates: PitfallCandidate[];
  /** Per-candidate failures, captured so one bad write cannot strand the rest of the harvest or the lifecycle path that fired it. */
  errors: string[];
  rejected: number;
  skipped: number;
}

export interface HarvestPitfallsDeps {
  store: EpisodicStore;
  repoRoot: string;
  agent: string;
  sessionId: string | null;
  /** The write path, and there is only one: the memory service's serialized write, which keeps the article file, the FTS row and the vector consistent. Required rather than defaulted, because the file-only fallback that used to stand here produced articles no search could reach. */
  write: (input: MemoryWriteInput) => Promise<MemoryWriteFileResult>;
  /** Advisory search for "Possibly related:" links (dedup layer 2). The daemon passes its FTS MemoryIndex; omitting it skips the advisory. */
  search?: (
    query: string,
  ) => Array<{ scope: MemoryScope; id: string; title: string }>;
}

function candidateBody(input: {
  cluster: EpisodicEvent[];
  label: string;
  agent: string;
  sessionId: string | null;
  related: Array<{ scope: MemoryScope; id: string; title: string }>;
}): string {
  const { cluster, label, agent, sessionId, related } = input;
  const eventIds = cluster.map((event) => event.id);
  const exactValues: ExactValue[] = [];
  for (const event of cluster) extractExactValues(event, exactValues);
  const seen = new Set<string>();
  const exactRows = exactValues
    .filter((row) => {
      const key = `${row.kind}${row.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, EXACT_VALUES_MAX);

  const lines: string[] = [
    "## What failed",
    "",
    ...cluster.map(
      (event) =>
        `- [e${event.id}] ${event.ts} \`${event.type}\` — ${event.summary
          .replace(/\s+/g, " ")
          .trim()}`,
    ),
    "",
    "## Context",
    "",
    `- Failure signature: ${label}`,
    `- Agent: ${agent}`,
    `- Session: ${sessionId ?? "unknown"}`,
    `- Failure events in admitted session: ${cluster.length}`,
    "- Admission: signature repeated at a later session boundary",
    "",
  ];
  if (exactRows.length > 0) {
    lines.push(
      "## Exact values",
      "",
      "| kind | value | source |",
      "| --- | --- | --- |",
    );
    for (const row of exactRows) {
      lines.push(`| ${row.kind} | \`${row.value}\` | e${row.eventId} |`);
    }
    lines.push("");
  }
  if (related.length > 0) {
    lines.push("## Possibly related", "");
    for (const candidate of related) {
      lines.push(
        `- Possibly related: [${candidate.scope}] ${candidate.id} — ${candidate.title}`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Provenance",
    "",
    `- Events: ${eventIds.map((id) => `e${id}`).join(", ")} ` +
      "(drill down with hive_status or the episodic store)",
    `- Session: ${sessionId ?? "unknown"}`,
    "",
    "UNVERIFIED repeated harvest candidate — a hint, not authority. Check " +
      "the failure against the cited source events, then promote it with " +
      "memory_verify before treating it as a lesson. Anyone but this " +
      "article's own author can do that, on any day after it was admitted.",
    "",
  );
  return lines.join("\n");
}

/** Propose one observation per normalized failure signature at a session boundary. The first boundary records only the doorkeeper bit; a later boundary may write an unverified repo pitfall. Repeated events inside one session stay one observation. Only events after the agent's harvest high-water mark are considered, and re-running the same history creates neither an article nor raw evidence. */
export async function harvestPitfalls(
  deps: HarvestPitfallsDeps,
): Promise<PitfallHarvestReport> {
  return serializeAgentHarvest(deps.store, deps.agent, () =>
    harvestPitfallsLocked(deps),
  );
}

async function harvestPitfallsLocked(
  deps: HarvestPitfallsDeps,
): Promise<PitfallHarvestReport> {
  const write = deps.write;
  const report: PitfallHarvestReport = {
    candidates: [],
    errors: [],
    rejected: 0,
    skipped: 0,
  };

  const highWater = readHarvestHighWater(deps.store, deps.agent);
  pruneHarvestReceipts(deps.store, deps.agent, highWater);
  const events = deps.store
    .eventsFor({ agent: deps.agent })
    .filter((event) => event.id > highWater);
  if (events.length === 0) return report;

  let maxExaminedId = highWater;
  for (const event of events) {
    if (event.id > maxExaminedId) maxExaminedId = event.id;
  }

  const failures = events.filter((event) => episodeOutcome(event) === "failed");
  if (failures.length === 0) {
    writeHarvestHighWater(deps.store, deps.agent, maxExaminedId);
    return report;
  }

  const clusters = new Map<
    string,
    { label: string; events: EpisodicEvent[] }
  >();
  for (const event of failures) {
    const signature = failureSignature(event);
    if (signature === null) {
      report.skipped += 1;
      continue;
    }
    const cluster = clusters.get(signature.key);
    if (cluster === undefined) {
      clusters.set(signature.key, { label: signature.label, events: [event] });
    } else {
      cluster.events.push(event);
    }
  }

  if (clusters.size === 0) {
    writeHarvestHighWater(deps.store, deps.agent, maxExaminedId);
    return report;
  }

  const articles = (await discoverMemoryFacts(deps.repoRoot, "repo")).map(
    (fact) => ({ id: fact.id, title: fact.title }),
  );

  for (const [signature, cluster] of clusters) {
    try {
      const persistedKey = harvestedSignatureKey(deps.agent, signature);
      const persistedThrough = Number(deps.store.readMeta(persistedKey));
      if (
        Number.isInteger(persistedThrough) &&
        cluster.events.every((event) => event.id <= persistedThrough)
      ) {
        continue;
      }
      const persistedThroughEvent = cluster.events[cluster.events.length - 1];
      const persistedThroughId = persistedThroughEvent?.id ?? maxExaminedId;
      if (
        deps.store.observeMemoryCandidate({
          signature,
          observedAt: persistedThroughEvent?.ts ?? new Date().toISOString(),
          firstObservationReceipt: {
            key: persistedKey,
            value: String(persistedThroughId),
          },
        }) === "rejected"
      ) {
        report.rejected += 1;
        continue;
      }
      const title = `Pitfall: ${cluster.label}`.slice(0, TITLE_MAX);
      const duplicate = articles.find(
        (article) => normalizeTitle(article.title) === normalizeTitle(title),
      );
      const related: PitfallCandidate["related"] = [];
      if (duplicate === undefined && deps.search !== undefined) {
        // Advisory (dedup layer 2): the cluster's most distinctive token is the FTS probe — an exact-title hit is the duplicate path above, so anything left here is similar-but-distinct and earns a link.
        const probe = cluster.label
          .split(/\s+/)
          .filter((token) => /^[a-z0-9]{4,}$/i.test(token))
          .sort((a, b) => b.length - a.length)[0];
        if (probe !== undefined) {
          const normalized = normalizeTitle(title);
          for (const hit of deps.search(probe)) {
            if (normalizeTitle(hit.title) === normalized) continue;
            if (
              related.some(
                (candidate) =>
                  candidate.scope === hit.scope && candidate.id === hit.id,
              )
            )
              continue;
            related.push({ scope: hit.scope, id: hit.id, title: hit.title });
            if (related.length >= ADVISORY_MAX) break;
          }
        }
      }
      const body = candidateBody({
        cluster: cluster.events,
        label: cluster.label,
        agent: deps.agent,
        sessionId: deps.sessionId,
        related,
      });
      const written = await write({
        scope: "repo",
        ...(duplicate === undefined ? {} : { id: duplicate.id }),
        topic: "pitfalls",
        title,
        body,
        tags: ["pitfall"],
        source: "orchestrator",
        evidence:
          `Admitted after this failure signature recurred; current session ` +
          `contributed ${cluster.events.length} failure event(s) ` +
          `(${cluster.events
            .map((event) => `e${event.id}`)
            .join(
              ", ",
            )}) of agent ${deps.agent}, session ${deps.sessionId ?? "unknown"}`,
        status: "unverified",
        kind: "pitfall",
        supersedes: duplicate === undefined ? [] : [duplicate.id],
        author: deps.agent,
      });
      if (duplicate === undefined) {
        articles.push({ id: written.id, title });
      }
      report.candidates.push({
        id: written.id,
        title,
        action: duplicate === undefined ? "created" : "updated",
        signature,
        eventIds: cluster.events.map((event) => event.id),
        related,
      });
      deps.store.writeMeta(persistedKey, String(persistedThroughId));
    } catch (error) {
      report.errors.push(`${signature}: ${errorMessage(error)}`);
    }
  }
  if (report.errors.length === 0) {
    writeHarvestHighWater(deps.store, deps.agent, maxExaminedId);
    pruneHarvestReceipts(deps.store, deps.agent, maxExaminedId);
  }
  return report;
}

export const VERIFICATION_ARTICLE_ID = "verification";
export const VERIFICATION_TITLE_PREFIX = "Verification: ";

export function verificationCommandFromTitle(title: string): string | null {
  if (!title.startsWith(VERIFICATION_TITLE_PREFIX)) return null;
  const command = title.slice(VERIFICATION_TITLE_PREFIX.length).trim();
  return command.length === 0 ? null : command;
}

export interface VerificationHarvestReport {
  readonly wrote: boolean;
  readonly command: string | null;
  readonly id: string | null;
}

/** Record the most recent typed successful command as this repo's verification. No command field means nothing was measured; exit-0 prose is not a command. Same command as the current article is a no-op. */
export async function harvestVerification(
  deps: HarvestPitfallsDeps,
): Promise<VerificationHarvestReport> {
  const events = deps.store.eventsFor({ agent: deps.agent });
  let command: string | null = null;
  let sourceEvent: EpisodicEvent | null = null;
  for (const event of events) {
    if (episodeOutcome(event) !== "succeeded") continue;
    const measured = nonEmptyString(eventData(event).command);
    if (measured === null) continue;
    command = measured;
    sourceEvent = event;
  }
  if (command === null || sourceEvent === null) {
    return { wrote: false, command: null, id: null };
  }

  const existing = await readMemoryFact(
    deps.repoRoot,
    "repo",
    VERIFICATION_ARTICLE_ID,
  );
  if (
    existing !== null &&
    verificationCommandFromTitle(existing.title) === command
  ) {
    return { wrote: false, command, id: existing.id };
  }

  const previous =
    existing === null ? null : verificationCommandFromTitle(existing.title);
  const title = `${VERIFICATION_TITLE_PREFIX}${command}`.slice(0, TITLE_MAX);
  const body = [
    "## Command",
    "",
    `\`${command}\``,
    "",
    "## Measured",
    "",
    `- Agent: ${deps.agent}`,
    `- Session: ${deps.sessionId ?? "unknown"}`,
    `- Event: e${sourceEvent.id} \`${sourceEvent.type}\``,
    previous === null || previous === command
      ? "- First measured command for this repository."
      : `- Replaces previously measured \`${previous}\`.`,
    "",
    "UNVERIFIED harvest — a later session must re-check this command still exists in the tree and call memory_verify before treating it as standing procedure.",
    "",
  ].join("\n");

  const written = await deps.write({
    scope: "repo",
    id: VERIFICATION_ARTICLE_ID,
    topic: "verification",
    title,
    body,
    tags: ["verification"],
    source: "orchestrator",
    evidence:
      `Measured successful command ${JSON.stringify(command)} from e${sourceEvent.id} ` +
      `of agent ${deps.agent}, session ${deps.sessionId ?? "unknown"}`,
    status: "unverified",
    kind: "article",
    supersedes: existing === null ? [] : [VERIFICATION_ARTICLE_ID],
    author: deps.agent,
  });
  return { wrote: true, command, id: written.id };
}
