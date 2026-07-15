import type { Database } from "bun:sqlite";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { claudeProjectDirectory } from "../adapters/tools/claude";
import { findCodexRolloutBySessionId } from "../adapters/tools/codex";
import { findLatestGrokSessionDirectory } from "../adapters/tools/grok";
import {
  TokenUsageRoleSchema,
  TokenUsageSnapshotSchema,
  type AgentRecord,
  type TokenCounts,
  type TokenUsageBreakdown,
  type TokenUsageSession,
  type TokenUsageSnapshot,
  type TokenUsageSubject,
} from "../schemas";
import { isLiveAgent } from "../schemas";
import type { HiveDatabase } from "./db";

const SubjectRowSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  agentId: z.string().nullable(),
  name: z.string(),
  role: TokenUsageRoleSchema,
  provider: z.string(),
  model: z.string().nullable(),
  cwd: z.string(),
  providerSessionId: z.string().nullable(),
  profileRunId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  unknownReason: z.string().nullable(),
});
type SubjectRow = z.infer<typeof SubjectRowSchema>;

const ArtifactRowSchema = z.object({
  path: z.string(),
  cursorBytes: z.number().int().nonnegative(),
});

const EventRowSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  cacheCreationInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  observedAt: z.string(),
  source: z.string(),
});

export interface NormalizedTokenEvent {
  key: string;
  counts: Omit<TokenCounts, "totalTokens">;
  observedAt: string;
  source: string;
  /** Codex emits one cumulative counter; Claude/Grok emit stable deltas. */
  cumulative?: boolean;
}

export interface TokenArtifactUpdate {
  cursorBytes: number;
  events: NormalizedTokenEvent[];
}

/** One provider implementation. OpenCode only needs to supply this interface;
 * the store, daemon wire, and Settings UI remain unchanged. */
export interface TokenUsageAdapter {
  readonly provider: string;
  discover(subject: SubjectRow, knownPaths: string[]): Promise<{
    providerSessionId?: string;
    paths: string[];
  }>;
  read(path: string, cursorBytes: number): Promise<TokenArtifactUpdate>;
}

async function appendedLines(
  path: string,
  cursorBytes: number,
): Promise<{ lines: string[]; cursorBytes: number }> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const offset = cursorBytes <= size ? cursorBytes : 0;
    if (offset === size) return { lines: [], cursorBytes: offset };
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const complete = buffer.subarray(0, bytesRead);
    const newline = complete.lastIndexOf(0x0a);
    if (newline < 0) return { lines: [], cursorBytes: offset };
    const consumed = complete.subarray(0, newline + 1);
    return {
      lines: consumed.toString("utf8").split("\n").filter(Boolean),
      cursorBytes: offset + consumed.length,
    };
  } finally {
    await handle.close();
  }
}

const observedCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

async function jsonlFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files;
}

class ClaudeTokenUsageAdapter implements TokenUsageAdapter {
  readonly provider = "claude";
  constructor(private readonly home = homedir()) {}

  async discover(subject: SubjectRow, knownPaths: string[]) {
    const sessionId = subject.providerSessionId;
    if (sessionId === null) return { paths: [] };
    const directory = claudeProjectDirectory(subject.cwd, this.home);
    const main = join(directory, `${sessionId}.jsonl`);
    const nested = await jsonlFiles(join(directory, sessionId, "subagents"));
    return {
      providerSessionId: sessionId,
      paths: [...new Set([...knownPaths, main, ...nested])],
    };
  }

  async read(path: string, cursorBytes: number): Promise<TokenArtifactUpdate> {
    const appended = await appendedLines(path, cursorBytes);
    const events: NormalizedTokenEvent[] = [];
    for (const line of appended.lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = record(value);
      const message = record(entry?.message);
      const usage = record(message?.usage);
      if (entry?.type !== "assistant" || usage === null) continue;
      const input = observedCount(usage.input_tokens);
      const cacheCreation = observedCount(usage.cache_creation_input_tokens);
      const cacheRead = observedCount(usage.cache_read_input_tokens);
      const output = observedCount(usage.output_tokens);
      // Claude's input total is three separate counters. If one is absent,
      // there is no honest total to publish for this message.
      if (
        input === null || cacheCreation === null || cacheRead === null ||
        output === null
      ) continue;
      const id = typeof message?.id === "string"
        ? message.id
        : typeof entry?.uuid === "string"
        ? entry.uuid
        : null;
      if (id === null) continue;
      events.push({
        key: `message:${id}`,
        counts: {
          inputTokens: input + cacheCreation + cacheRead,
          cachedInputTokens: cacheRead,
          cacheCreationInputTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: null,
        },
        observedAt: typeof entry?.timestamp === "string"
          ? entry.timestamp
          : new Date().toISOString(),
        source: "claude-transcript",
      });
    }
    return { cursorBytes: appended.cursorBytes, events };
  }
}

class CodexTokenUsageAdapter implements TokenUsageAdapter {
  readonly provider = "codex";
  constructor(private readonly home = homedir()) {}

  async discover(subject: SubjectRow, knownPaths: string[]) {
    if (knownPaths.length > 0) return { paths: knownPaths };
    if (subject.providerSessionId == null) return { paths: [] };
    const rollout = await findCodexRolloutBySessionId(
      subject.cwd,
      subject.providerSessionId,
      this.home,
    );
    if (rollout === null) return { paths: [] };
    return {
      providerSessionId: rollout.sessionId,
      paths: [rollout.path],
    };
  }

  async read(path: string, cursorBytes: number): Promise<TokenArtifactUpdate> {
    const appended = await appendedLines(path, cursorBytes);
    let latest: NormalizedTokenEvent | null = null;
    for (const line of appended.lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = record(value);
      const payload = record(entry?.payload);
      const info = record(payload?.info);
      const usage = record(info?.total_token_usage);
      if (payload?.type !== "token_count" || usage === null) continue;
      const input = observedCount(usage.input_tokens);
      const output = observedCount(usage.output_tokens);
      if (input === null || output === null) continue;
      latest = {
        key: "cumulative",
        cumulative: true,
        counts: {
          inputTokens: input,
          cachedInputTokens: observedCount(usage.cached_input_tokens),
          cacheCreationInputTokens: null,
          outputTokens: output,
          reasoningTokens: observedCount(usage.reasoning_output_tokens),
        },
        observedAt: typeof entry?.timestamp === "string"
          ? entry.timestamp
          : new Date().toISOString(),
        source: "codex-rollout",
      };
    }
    return {
      cursorBytes: appended.cursorBytes,
      events: latest === null ? [] : [latest],
    };
  }
}

class GrokTokenUsageAdapter implements TokenUsageAdapter {
  readonly provider = "grok";
  constructor(private readonly home = join(homedir(), ".grok")) {}

  async discover(subject: SubjectRow, knownPaths: string[]) {
    if (knownPaths.length > 0) return { paths: knownPaths };
    if (subject.providerSessionId === null) return { paths: [] };
    const directory = await findLatestGrokSessionDirectory(
      subject.cwd,
      subject.providerSessionId,
      this.home,
    );
    if (directory === null) return { paths: [] };
    return {
      providerSessionId: directory.split("/").at(-1),
      paths: [join(directory, "updates.jsonl")],
    };
  }

  async read(path: string, cursorBytes: number): Promise<TokenArtifactUpdate> {
    const appended = await appendedLines(path, cursorBytes);
    const events: NormalizedTokenEvent[] = [];
    for (const line of appended.lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = record(value);
      const params = record(entry?.params);
      const update = record(params?.update);
      const usage = record(update?.usage);
      if (update?.sessionUpdate !== "turn_completed" || usage === null) continue;
      const input = observedCount(usage.inputTokens);
      const output = observedCount(usage.outputTokens);
      if (input === null || output === null) continue;
      const promptId = typeof update.prompt_id === "string"
        ? update.prompt_id
        : typeof entry?.timestamp === "number"
        ? String(entry.timestamp)
        : null;
      if (promptId === null) continue;
      const timestamp = typeof entry?.timestamp === "number"
        ? new Date(entry.timestamp * 1_000).toISOString()
        : new Date().toISOString();
      events.push({
        key: `turn:${promptId}`,
        counts: {
          inputTokens: input,
          cachedInputTokens: observedCount(usage.cachedReadTokens),
          cacheCreationInputTokens: null,
          outputTokens: output,
          reasoningTokens: observedCount(usage.reasoningTokens),
        },
        observedAt: timestamp,
        source: "grok-turn-completed",
      });
    }
    return { cursorBytes: appended.cursorBytes, events };
  }
}

export function defaultTokenUsageAdapters(home = homedir()): TokenUsageAdapter[] {
  return [
    new ClaudeTokenUsageAdapter(home),
    new CodexTokenUsageAdapter(home),
    new GrokTokenUsageAdapter(join(home, ".grok")),
  ];
}

export class TokenUsageStore {
  private readonly adapters: Map<string, TokenUsageAdapter>;
  private readonly database: Database;

  constructor(
    private readonly db: HiveDatabase,
    adapters: TokenUsageAdapter[] = defaultTokenUsageAdapters(),
  ) {
    this.database = db.database;
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS token_usage_sessions (
        id TEXT PRIMARY KEY,
        repoRoot TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        endedAt TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS token_usage_one_active_repo
        ON token_usage_sessions(repoRoot) WHERE endedAt IS NULL;
      CREATE TABLE IF NOT EXISTS token_usage_subjects (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL REFERENCES token_usage_sessions(id),
        agentId TEXT,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('orchestrator', 'worker', 'profiler')),
        provider TEXT NOT NULL,
        model TEXT,
        cwd TEXT NOT NULL,
        providerSessionId TEXT,
        profileRunId TEXT,
        startedAt TEXT NOT NULL,
        endedAt TEXT,
        unknownReason TEXT
      );
      CREATE TABLE IF NOT EXISTS token_usage_artifacts (
        subjectId TEXT NOT NULL REFERENCES token_usage_subjects(id),
        path TEXT NOT NULL,
        cursorBytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(subjectId, path)
      );
      CREATE TABLE IF NOT EXISTS token_usage_events (
        subjectId TEXT NOT NULL REFERENCES token_usage_subjects(id),
        eventKey TEXT NOT NULL,
        cumulative INTEGER NOT NULL DEFAULT 0,
        inputTokens INTEGER NOT NULL,
        cachedInputTokens INTEGER,
        cacheCreationInputTokens INTEGER,
        outputTokens INTEGER NOT NULL,
        reasoningTokens INTEGER,
        observedAt TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY(subjectId, eventKey)
      );
    `);
    // A pre-profiler database keeps its old table (CREATE ... IF NOT EXISTS is a
    // no-op there): the role CHECK still rejects 'profiler' and there is no
    // profileRunId column. Widen it before creating the subject indexes, because
    // a rebuild drops the old table and its indexes with it.
    this.migrateSubjects();
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS token_usage_one_subject_per_agent
        ON token_usage_subjects(sessionId, agentId) WHERE agentId IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS token_usage_one_profiler_per_run
        ON token_usage_subjects(sessionId, profileRunId) WHERE profileRunId IS NOT NULL;
    `);
  }

  /** Bring a pre-profiler `token_usage_subjects` up to the current shape. SQLite
   * cannot ALTER a CHECK constraint, so the table is rebuilt to widen `role` and
   * gain the nullable `profileRunId`; existing rows are copied and their
   * profileRunId defaults to NULL. Keyed on the column's absence so it runs at
   * most once. Follows the SQLite table-rebuild recipe (build the new table,
   * copy, drop the old, rename into place) with foreign keys disabled around it,
   * because artifacts/events reference this table. */
  private migrateSubjects(): void {
    const hasProfileRunId = z.object({ name: z.string() }).array().parse(
      this.database.query("PRAGMA table_info(token_usage_subjects)").all(),
    ).some((column) => column.name === "profileRunId");
    if (hasProfileRunId) return;
    // Restore enforcement to whatever it was, even if the rebuild throws.
    const enforced = z.array(z.object({ foreign_keys: z.number() })).parse(
      this.database.query("PRAGMA foreign_keys").all(),
    )[0]?.foreign_keys ?? 1;
    this.database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE token_usage_subjects_rebuilt (
            id TEXT PRIMARY KEY,
            sessionId TEXT NOT NULL REFERENCES token_usage_sessions(id),
            agentId TEXT,
            name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('orchestrator', 'worker', 'profiler')),
            provider TEXT NOT NULL,
            model TEXT,
            cwd TEXT NOT NULL,
            providerSessionId TEXT,
            profileRunId TEXT,
            startedAt TEXT NOT NULL,
            endedAt TEXT,
            unknownReason TEXT
          );
          INSERT INTO token_usage_subjects_rebuilt (
            id, sessionId, agentId, name, role, provider, model, cwd,
            providerSessionId, profileRunId, startedAt, endedAt, unknownReason
          )
          SELECT id, sessionId, agentId, name, role, provider, model, cwd,
            providerSessionId, NULL, startedAt, endedAt, unknownReason
          FROM token_usage_subjects;
          DROP TABLE token_usage_subjects;
          ALTER TABLE token_usage_subjects_rebuilt RENAME TO token_usage_subjects;
        `);
      })();
    } finally {
      this.database.exec(
        `PRAGMA foreign_keys = ${enforced === 0 ? "OFF" : "ON"}`,
      );
    }
  }

  private activeSession(repoRoot?: string): { id: string; repoRoot: string; startedAt: string } | null {
    const row = repoRoot === undefined
      ? this.database.query(`
          SELECT id, repoRoot, startedAt FROM token_usage_sessions
          WHERE endedAt IS NULL ORDER BY startedAt DESC LIMIT 1
        `).get()
      : this.database.query(`
          SELECT id, repoRoot, startedAt FROM token_usage_sessions
          WHERE repoRoot = ? AND endedAt IS NULL LIMIT 1
        `).get(repoRoot);
    return z.object({ id: z.string(), repoRoot: z.string(), startedAt: z.string() })
      .nullable().parse(row);
  }

  private hasLiveProfiler(sessionId: string): boolean {
    return this.database.query(`
      SELECT 1 FROM token_usage_subjects
      WHERE sessionId = ? AND role = 'profiler' AND endedAt IS NULL LIMIT 1
    `).get(sessionId) !== null;
  }

  async startSession(repoRoot: string, at = new Date().toISOString()): Promise<string> {
    const active = this.activeSession(repoRoot);
    // Gate-critical profiling runs before the orchestrator, when no agent is yet
    // live. An unfinished profiler subject keeps its session alive so the
    // orchestrator's later startSession joins it instead of closing the
    // profiler's run into a throwaway session.
    if (
      active !== null &&
      (this.db.listAgents().some(isLiveAgent) || this.hasLiveProfiler(active.id))
    ) return active.id;
    if (active !== null) await this.endSession(active.id, at);
    const id = crypto.randomUUID();
    this.database.query(`
      INSERT INTO token_usage_sessions (id, repoRoot, startedAt, endedAt)
      VALUES (?, ?, ?, NULL)
    `).run(id, repoRoot, at);
    await this.syncWorkers(id);
    return id;
  }

  async endSession(id: string, at = new Date().toISOString()): Promise<void> {
    await this.refreshSession(id);
    this.database.query(`
      UPDATE token_usage_sessions SET endedAt = COALESCE(endedAt, ?)
      WHERE id = ?
    `).run(at, id);
  }

  startOrchestrator(
    sessionId: string,
    provider: string,
    cwd: string,
    at = new Date().toISOString(),
  ): string {
    const id = crypto.randomUUID();
    this.database.query(`
      INSERT INTO token_usage_subjects (
        id, sessionId, agentId, name, role, provider, model, cwd,
        providerSessionId, startedAt, endedAt, unknownReason
      ) VALUES (?, ?, NULL, 'Orchestrator', 'orchestrator', ?, NULL, ?, NULL, ?, NULL, NULL)
    `).run(id, sessionId, provider, cwd, at);
    return id;
  }

  /** The durable id of the profiler subject for a run, or null if none exists.
   * Recovery keys on this identity — `(sessionId, runId)` — never on the
   * ephemeral subject UUID a crashed caller may not have retained. */
  profilerSubjectId(sessionId: string, runId: string): string | null {
    return z.object({ id: z.string() }).nullable().parse(
      this.database.query(`
        SELECT id FROM token_usage_subjects
        WHERE sessionId = ? AND role = 'profiler' AND profileRunId = ? LIMIT 1
      `).get(sessionId, runId),
    )?.id ?? null;
  }

  /** Open (or reacquire) a usage subject for a specialized profiler run. It
   * carries the run's id and name, its isolated runtime cwd, and its
   * provider/model, but never an ordinary `agentId` — a profiler has no row in
   * the agents table. The provider session id is attached later, once observed,
   * via `registerProfilerProviderSession`.
   *
   * Idempotent by run: a retry for the same `(sessionId, runId)` — the common
   * case after a daemon crash, when the caller no longer holds the returned
   * UUID — reacquires the existing subject by its durable identity rather than
   * inserting a duplicate the unique index would reject. So a legitimate same-run
   * recovery closes or continues the row instead of dead-ending on a hard error,
   * while a superseding rerun still uses a fresh runId and gets a fresh subject.
   * The unique `(sessionId, profileRunId)` index remains a backstop against any
   * raw double insert. */
  startProfiler(
    sessionId: string,
    runId: string,
    name: string,
    provider: string,
    model: string | null,
    cwd: string,
    providerSessionId: string | null = null,
    at = new Date().toISOString(),
  ): string {
    const existing = this.profilerSubjectId(sessionId, runId);
    if (existing !== null) return existing;
    const id = crypto.randomUUID();
    this.database.query(`
      INSERT INTO token_usage_subjects (
        id, sessionId, agentId, name, role, provider, model, cwd,
        providerSessionId, profileRunId, startedAt, endedAt, unknownReason
      ) VALUES (?, ?, NULL, ?, 'profiler', ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(id, sessionId, name, provider, model, cwd, providerSessionId, runId, at);
    return id;
  }

  /** Attach the observed provider session id to a profiler subject. Until this
   * is set, the adapter cannot locate the run's token artifact and the subject
   * reads as an honest unknown. */
  registerProfilerProviderSession(
    subjectId: string,
    providerSessionId: string,
  ): void {
    this.database.query(`
      UPDATE token_usage_subjects SET providerSessionId = ?
      WHERE id = ? AND role = 'profiler'
    `).run(providerSessionId, subjectId);
  }

  async endSubject(id: string, at = new Date().toISOString()): Promise<void> {
    await this.refreshSubject(id);
    this.database.query(`
      UPDATE token_usage_subjects SET endedAt = COALESCE(endedAt, ?) WHERE id = ?
    `).run(at, id);
  }

  registerOrchestratorProviderSession(
    providerSessionId: string,
    repoRoot: string,
  ): void {
    const active = this.activeSession(repoRoot);
    if (active === null) return;
    this.database.query(`
      UPDATE token_usage_subjects SET providerSessionId = ?
      WHERE id = (
        SELECT id FROM token_usage_subjects
        WHERE sessionId = ? AND role = 'orchestrator' AND endedAt IS NULL
        ORDER BY startedAt DESC LIMIT 1
      )
    `).run(providerSessionId, active.id);
  }

  private async syncWorkers(sessionId: string): Promise<void> {
    const session = z.object({ startedAt: z.string() }).parse(
      this.database.query("SELECT startedAt FROM token_usage_sessions WHERE id = ?")
        .get(sessionId),
    );
    for (const agent of this.db.listAgents()) {
      if (agent.createdAt < session.startedAt && !isLiveAgent(agent)) continue;
      const cwd = agent.worktreePath;
      if (cwd === null) continue;
      this.database.query(`
        INSERT OR IGNORE INTO token_usage_subjects (
          id, sessionId, agentId, name, role, provider, model, cwd,
          providerSessionId, startedAt, endedAt, unknownReason
        ) VALUES (?, ?, ?, ?, 'worker', ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        crypto.randomUUID(),
        sessionId,
        agent.id,
        agent.name,
        agent.tool,
        agent.liveModel ?? agent.model,
        cwd,
        agent.toolSessionId ?? null,
        agent.createdAt,
        agent.closedAt ?? null,
      );
      this.database.query(`
        UPDATE token_usage_subjects SET
          providerSessionId = COALESCE(?, providerSessionId),
          model = COALESCE(?, model),
          endedAt = COALESCE(?, endedAt)
        WHERE sessionId = ? AND agentId = ?
      `).run(
        agent.toolSessionId ?? null,
        agent.liveModel ?? agent.model,
        agent.closedAt ?? null,
        sessionId,
        agent.id,
      );
    }
  }

  async refreshCurrent(repoRoot?: string): Promise<void> {
    const active = this.activeSession(repoRoot);
    if (active !== null) await this.refreshSession(active.id);
  }

  async refreshSession(sessionId: string): Promise<void> {
    await this.syncWorkers(sessionId);
    const ids = z.object({ id: z.string() }).array().parse(
      this.database.query(`
        SELECT id FROM token_usage_subjects AS subject
        WHERE sessionId = ? AND (
          endedAt IS NULL OR unknownReason IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM token_usage_events AS event
            WHERE event.subjectId = subject.id
          )
        )
        ORDER BY startedAt
      `).all(sessionId),
    );
    for (const { id } of ids) await this.refreshSubject(id);
  }

  async refreshSubject(id: string): Promise<void> {
    const subject = SubjectRowSchema.nullable().parse(
      this.database.query("SELECT * FROM token_usage_subjects WHERE id = ?").get(id),
    );
    if (subject === null) return;
    const adapter = this.adapters.get(subject.provider);
    if (adapter === undefined) {
      this.database.query(
        "UPDATE token_usage_subjects SET unknownReason = ? WHERE id = ?",
      ).run(`No token collector is installed for provider ${subject.provider}`, id);
      return;
    }
    if (subject.providerSessionId === null) {
      this.database.query(
        "UPDATE token_usage_subjects SET unknownReason = ? WHERE id = ?",
      ).run(
        `${subject.provider} provider session id has not been observed`,
        id,
      );
      return;
    }
    const artifacts = ArtifactRowSchema.array().parse(
      this.database.query(`
        SELECT path, cursorBytes FROM token_usage_artifacts WHERE subjectId = ?
      `).all(id),
    );
    let discovered: Awaited<ReturnType<TokenUsageAdapter["discover"]>>;
    try {
      discovered = await adapter.discover(subject, artifacts.map((row) => row.path));
    } catch (error) {
      this.database.query(
        "UPDATE token_usage_subjects SET unknownReason = ? WHERE id = ?",
      ).run(
        `Could not discover ${subject.provider} token artifacts: ${
          error instanceof Error ? error.message : String(error)
        }`,
        id,
      );
      return;
    }
    if (discovered.providerSessionId !== undefined) {
      this.database.query(`
        UPDATE token_usage_subjects SET providerSessionId = ? WHERE id = ?
      `).run(discovered.providerSessionId, id);
    }
    for (const path of discovered.paths) {
      this.database.query(`
        INSERT OR IGNORE INTO token_usage_artifacts (subjectId, path, cursorBytes)
        VALUES (?, ?, 0)
      `).run(id, path);
    }
    const currentArtifacts = ArtifactRowSchema.array().parse(
      this.database.query(`
        SELECT path, cursorBytes FROM token_usage_artifacts WHERE subjectId = ?
      `).all(id),
    );
    let readFailure: string | null = null;
    for (const artifact of currentArtifacts) {
      let update: TokenArtifactUpdate;
      try {
        update = await adapter.read(artifact.path, artifact.cursorBytes);
      } catch (error) {
        readFailure = `Could not read ${subject.provider} token artifact: ${
          error instanceof Error ? error.message : String(error)
        }`;
        continue;
      }
      this.database.transaction(() => {
        for (const event of update.events) this.upsertEvent(id, event);
        this.database.query(`
          UPDATE token_usage_artifacts SET cursorBytes = ?
          WHERE subjectId = ? AND path = ?
        `).run(update.cursorBytes, id, artifact.path);
      })();
    }
    const measured = z.object({ count: z.number() }).parse(
      this.database.query(
        "SELECT COUNT(*) AS count FROM token_usage_events WHERE subjectId = ?",
      ).get(id),
    ).count > 0;
    this.database.query(
      "UPDATE token_usage_subjects SET unknownReason = ? WHERE id = ?",
    ).run(
      readFailure ?? (measured
        ? null
        : discovered.paths.length === 0
        ? `${subject.provider} has not produced a token artifact for this session`
        : `${subject.provider} has not reported token usage yet`),
      id,
    );
  }

  private upsertEvent(subjectId: string, event: NormalizedTokenEvent): void {
    const values = [
      subjectId,
      event.key,
      event.cumulative === true ? 1 : 0,
      event.counts.inputTokens,
      event.counts.cachedInputTokens,
      event.counts.cacheCreationInputTokens,
      event.counts.outputTokens,
      event.counts.reasoningTokens,
      event.observedAt,
      event.source,
    ];
    if (event.cumulative === true) {
      this.database.query(`
        INSERT INTO token_usage_events (
          subjectId, eventKey, cumulative, inputTokens, cachedInputTokens,
          cacheCreationInputTokens, outputTokens, reasoningTokens, observedAt, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subjectId, eventKey) DO UPDATE SET
          inputTokens = MAX(inputTokens, excluded.inputTokens),
          cachedInputTokens = CASE
            WHEN excluded.cachedInputTokens IS NULL THEN NULL
            WHEN cachedInputTokens IS NULL THEN excluded.cachedInputTokens
            ELSE MAX(cachedInputTokens, excluded.cachedInputTokens) END,
          cacheCreationInputTokens = excluded.cacheCreationInputTokens,
          outputTokens = MAX(outputTokens, excluded.outputTokens),
          reasoningTokens = CASE
            WHEN excluded.reasoningTokens IS NULL THEN NULL
            WHEN reasoningTokens IS NULL THEN excluded.reasoningTokens
            ELSE MAX(reasoningTokens, excluded.reasoningTokens) END,
          observedAt = MAX(observedAt, excluded.observedAt),
          source = excluded.source
      `).run(...values);
      return;
    }
    this.database.query(`
      INSERT INTO token_usage_events (
        subjectId, eventKey, cumulative, inputTokens, cachedInputTokens,
        cacheCreationInputTokens, outputTokens, reasoningTokens, observedAt, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subjectId, eventKey) DO UPDATE SET
        inputTokens = MAX(inputTokens, excluded.inputTokens),
        cachedInputTokens = CASE
          WHEN cachedInputTokens IS NULL OR excluded.cachedInputTokens IS NULL THEN NULL
          ELSE MAX(cachedInputTokens, excluded.cachedInputTokens) END,
        cacheCreationInputTokens = CASE
          WHEN cacheCreationInputTokens IS NULL OR excluded.cacheCreationInputTokens IS NULL THEN NULL
          ELSE MAX(cacheCreationInputTokens, excluded.cacheCreationInputTokens) END,
        outputTokens = MAX(outputTokens, excluded.outputTokens),
        reasoningTokens = CASE
          WHEN reasoningTokens IS NULL OR excluded.reasoningTokens IS NULL THEN NULL
          ELSE MAX(reasoningTokens, excluded.reasoningTokens) END,
        observedAt = MAX(observedAt, excluded.observedAt),
        source = excluded.source
    `).run(...values);
  }

  private subjectReading(subject: SubjectRow): TokenUsageSubject {
    const rows = EventRowSchema.array().parse(
      this.database.query(`
        SELECT inputTokens, cachedInputTokens, cacheCreationInputTokens,
          outputTokens, reasoningTokens, observedAt, source
        FROM token_usage_events WHERE subjectId = ?
      `).all(subject.id),
    );
    if (rows.length === 0 || subject.unknownReason !== null) {
      return {
        id: subject.id,
        name: subject.name,
        role: subject.role,
        provider: subject.provider,
        model: subject.model,
        startedAt: subject.startedAt,
        endedAt: subject.endedAt,
        reading: {
          state: "unknown",
          reason: subject.unknownReason ?? "No provider token reading has been observed",
        },
      };
    }
    const nullableSum = (
      key: "cachedInputTokens" | "cacheCreationInputTokens" | "reasoningTokens",
    ): number | null => rows.every((row) => row[key] !== null)
      ? rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)
      : null;
    const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
    const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
    const observedAt = rows.reduce(
      (latest, row) => row.observedAt > latest ? row.observedAt : latest,
      rows[0]!.observedAt,
    );
    return {
      id: subject.id,
      name: subject.name,
      role: subject.role,
      provider: subject.provider,
      model: subject.model,
      startedAt: subject.startedAt,
      endedAt: subject.endedAt,
      reading: {
        state: "measured",
        counts: {
          inputTokens,
          cachedInputTokens: nullableSum("cachedInputTokens"),
          cacheCreationInputTokens: nullableSum("cacheCreationInputTokens"),
          outputTokens,
          reasoningTokens: nullableSum("reasoningTokens"),
          totalTokens: inputTokens + outputTokens,
        },
        source: [...new Set(rows.map((row) => row.source))].join(","),
        observedAt,
      },
    };
  }

  private breakdown(subjects: TokenUsageSubject[]): TokenUsageBreakdown {
    const measured = subjects.filter((subject) => subject.reading.state === "measured");
    const aggregateNullable = (
      key: "cachedInputTokens" | "cacheCreationInputTokens" | "reasoningTokens",
    ): number | null => measured.every((subject) =>
      subject.reading.state === "measured" && subject.reading.counts[key] !== null
    )
      ? measured.reduce((sum, subject) =>
        sum + (subject.reading.state === "measured"
          ? subject.reading.counts[key] ?? 0
          : 0), 0)
      : null;
    const inputTokens = measured.reduce((sum, subject) =>
      sum + (subject.reading.state === "measured" ? subject.reading.counts.inputTokens : 0), 0);
    const outputTokens = measured.reduce((sum, subject) =>
      sum + (subject.reading.state === "measured" ? subject.reading.counts.outputTokens : 0), 0);
    return {
      subjectCount: measured.length,
      counts: measured.length === 0
        ? null
        : {
            inputTokens,
            cachedInputTokens: aggregateNullable("cachedInputTokens"),
            cacheCreationInputTokens: aggregateNullable("cacheCreationInputTokens"),
            outputTokens,
            reasoningTokens: aggregateNullable("reasoningTokens"),
            totalTokens: inputTokens + outputTokens,
          },
    };
  }

  private readSession(id: string): TokenUsageSession {
    const session = z.object({
      id: z.string().uuid(),
      repoRoot: z.string(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
    }).parse(this.database.query(
      "SELECT id, repoRoot, startedAt, endedAt FROM token_usage_sessions WHERE id = ?",
    ).get(id));
    const subjects = SubjectRowSchema.array().parse(
      this.database.query(`
        SELECT * FROM token_usage_subjects WHERE sessionId = ? ORDER BY startedAt
      `).all(id),
    ).map((subject) => this.subjectReading(subject));
    const unknownSubjects = subjects
      .filter((subject) => subject.reading.state === "unknown")
      .map((subject) => `${subject.name} (${subject.provider})`);
    return {
      ...session,
      complete: unknownSubjects.length === 0,
      unknownSubjects,
      fleet: this.breakdown(subjects),
      hiveControl: this.breakdown(
        subjects.filter((subject) => subject.role === "orchestrator"),
      ),
      workerSessions: this.breakdown(
        subjects.filter((subject) => subject.role === "worker"),
      ),
      profilingSessions: this.breakdown(
        subjects.filter((subject) => subject.role === "profiler"),
      ),
      subjects,
    };
  }

  async snapshot(repoRoot?: string, limit = 20): Promise<TokenUsageSnapshot> {
    await this.refreshCurrent(repoRoot);
    const rows = z.object({ id: z.string() }).array().parse(
      repoRoot === undefined
        ? this.database.query(`
            SELECT id FROM token_usage_sessions ORDER BY startedAt DESC LIMIT ?
          `).all(limit)
        : this.database.query(`
            SELECT id FROM token_usage_sessions WHERE repoRoot = ?
            ORDER BY startedAt DESC LIMIT ?
          `).all(repoRoot, limit),
    );
    return TokenUsageSnapshotSchema.parse({
      generatedAt: new Date().toISOString(),
      currentSessionId: this.activeSession(repoRoot)?.id ?? null,
      sessions: rows.map((row) => this.readSession(row.id)),
      attribution: "control-lower-bound",
    });
  }
}
