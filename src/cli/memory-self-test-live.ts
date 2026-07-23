import { randomBytes } from "node:crypto";
import { readDaemonPort } from "../daemon/lifecycle";
import type { MemoryWriteInput } from "../schemas";
import {
  deleteMemory,
  digestMemory,
  fetchMemoryEmbeddingsStatus,
  type MemoryEmbeddingsStatus,
  noteMemory,
  queryMemory,
  readMemory,
  recallMemory,
  searchMemory,
  writeMemory,
} from "./mcp";
import type {
  MemorySelfTestReport,
  SelfTestAssertion,
} from "./memory-self-test";

// HiveMemory defect D3: the fixture probe (memory-self-test.ts) runs
// in-process from a checkout — node_modules present, embedder loadable — so
// it passes 8/8 while the DEPLOYED single-binary daemon runs degraded ("the
// friendly health check lied"). This is the live tier: it drives the RUNNING
// daemon over MCP, the same binary, config, and code paths users and agents
// actually hit, and proves
//
//   1. the daemon-reported embedding state (hive_status memory.embeddings),
//   2. the write-projection outcomes on memory_write AND memory_note
//      (indexed/queued, never unavailable:<state>),
//   3. live semantic recall — a paraphrase with zero content-token overlap
//      must rank the canary with semantic: "hybrid",
//   4. live FTS recall plus read-back drill-down through the live path.
//
// A degraded deployed binary FAILS here instead of passing green behind an
// in-process fixture. Canaries are planted with nonce-unique ids/titles (so
// reruns never hit normalized-title dedup) and labeled "self-test canary,
// safe to delete"; the wiki canary is deleted over MCP afterwards, and the
// episodic note canary — the store is bi-temporal with no MCP invalidate
// path — is documented in the cleanup line.

/** Default bound for waiting on queued vector projections to settle. */
const DEFAULT_SETTLE_BUDGET_MS = 30_000;
const INITIAL_POLL_MS = 150;
const MAX_POLL_MS = 1_000;

const CANARY_LABEL = "self-test canary, safe to delete";

// The same zero-overlap construction the fixture probe's semantic canary
// uses (proven against the real model in test/memory-embedding-live.test.ts):
// "RAM", "exhausted", "worker", "starts" appear nowhere in the article, so
// the porter-tokenizer FTS leg cannot answer the query — only the semantic
// leg can.
const ARTICLE_TITLE_BASE = "Daemon rejects spawns below the free-memory floor";
const ARTICLE_BODY =
  "When available system memory drops under the configured floor, hive " +
  "refuses to launch another agent and reports resource pressure instead.";
const PARAPHRASE_QUERY =
  "what happens when RAM is exhausted and a new worker starts";

class Skip extends Error {}

async function attempt(
  name: string,
  check: () => Promise<string>,
): Promise<SelfTestAssertion> {
  try {
    return { name, passed: true, detail: await check() };
  } catch (error) {
    if (error instanceof Skip) {
      return { name, passed: false, skipped: true, detail: error.message };
    }
    return {
      name,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function skipped(name: string, detail: string): SelfTestAssertion {
  return { name, passed: false, skipped: true, detail };
}

function report(assertions: SelfTestAssertion[]): MemorySelfTestReport {
  return {
    ok: assertions.every((assertion) =>
      assertion.passed || assertion.skipped === true
    ),
    lines: assertions.map((assertion) =>
      `[live] ${
        assertion.skipped === true ? "SKIP" : assertion.passed ? "PASS" : "FAIL"
      } ${assertion.name} — ` + assertion.detail
    ),
  };
}

export interface LiveSelfTestOptions {
  /** How long semantic recall polls for the queued projection to settle. */
  settleBudgetMs?: number;
  /** Initial poll interval (doubles up to 1 s). */
  pollIntervalMs?: number;
}

export async function runMemoryLiveSelfTest(
  options: LiveSelfTestOptions = {},
): Promise<MemorySelfTestReport> {
  const settleBudgetMs = options.settleBudgetMs ?? DEFAULT_SETTLE_BUDGET_MS;
  const initialPollMs = options.pollIntervalMs ?? INITIAL_POLL_MS;
  const nonce = randomBytes(4).toString("hex");
  const articleId = `self-test-live-${nonce}`;
  const articleTitle = `${ARTICLE_TITLE_BASE} (self-test ${nonce})`;

  // 1. Discovery: the same daemon.port + operator credential every other CLI
  // command uses. No daemon is an honest failure, never a green run.
  const port = readDaemonPort();
  if (port === null || port <= 0 || port > 65_535) {
    return report([{
      name: "daemon-discovery",
      passed: false,
      detail:
        "no live daemon found (no daemon.port under HIVE_HOME) — start one " +
        "with `hive claude` or `hive codex`; the fixture probe alone cannot " +
        "see a degraded deployed daemon",
    }]);
  }

  let embeddings: MemoryEmbeddingsStatus | null = null;
  const discovery = await attempt("daemon-discovery", async () => {
    embeddings = await fetchMemoryEmbeddingsStatus(port);
    return `live daemon on 127.0.0.1:${port} answers hive_status with the operator credential`;
  });
  if (!discovery.passed) return report([discovery]);
  const status = embeddings as unknown as MemoryEmbeddingsStatus;
  const disabled = status.state === "disabled";

  // 2. Reported-state assertion: the daemon's own embedding health section.
  const reportedState = disabled
    ? skipped(
      "reported-state",
      `(disabled in config) — ${status.detail ?? "the semantic leg is not wired on this daemon"}`,
    )
    : await attempt("reported-state", async () => {
      if (status.state !== "ready" && status.state !== "pending") {
        throw new Error(
          `memory.embeddings state is "${status.state}" — the deployed ` +
            "daemon's semantic leg is degraded" +
            (status.detail === undefined ? "" : ` (${status.detail})`),
        );
      }
      return (
        `provider=${status.provider ?? "?"} model=${status.model ?? "?"} ` +
        `state=${status.state} vectors.total=${status.vectors?.total ?? 0} ` +
        `runtimeDir=${status.runtimeDir ?? "?"}`
      );
    });

  // 3. Write-projection assertions. Both canaries plant even when embeddings
  // are disabled (the FTS/read-back tiers still need them); only the
  // projection outcome check skips.
  let articlePlanted = false;
  const articleInput: MemoryWriteInput = {
    scope: "repo",
    id: articleId,
    topic: "memory",
    title: articleTitle,
    body: `${ARTICLE_BODY} ${CANARY_LABEL}; nonce ${nonce}.`,
    source: "agent",
    evidence: "Planted by hive memory self-test --live",
    status: "unverified",
    supersedes: [],
  };
  const articleProjection = await attempt("write-article-projection", async () => {
    const written = await writeMemory(port, articleInput);
    articlePlanted = true;
    const outcome = written.embedding;
    if (disabled) {
      throw new Skip(
        `(disabled in config) — canary ${articleId} planted, projection outcome ${outcome ?? "absent"}`,
      );
    }
    if (outcome === undefined) {
      throw new Error("memory_write response carries no embedding field");
    }
    if (outcome.startsWith("unavailable:")) {
      throw new Error(
        `memory_write reports embedding: ${outcome} — the deployed daemon's ` +
          `semantic leg is down (state: ${outcome.slice("unavailable:".length)})`,
      );
    }
    return `memory_write reports embedding: ${outcome} for ${articleId}`;
  });

  let noteRecorded = false;
  let noteSurfaceAbsent = false;
  let noteId: string | null = null;
  const noteProjection = await attempt("write-note-projection", async () => {
    const note = await noteMemory(port, {
      topic: "self-test",
      title: `Live self-test note canary ${nonce}`,
      body:
        `${CANARY_LABEL}; nonce ${nonce}. Recorded through the running ` +
        "daemon by hive memory self-test --live.",
    });
    if (note.state === "absent") {
      noteSurfaceAbsent = true;
      throw new Skip(
        note.detail ?? "episodic store is not open on this daemon",
      );
    }
    if (note.state !== "recorded") {
      throw new Error(
        `memory_note returned state "${note.state}"` +
          (note.detail === undefined ? "" : ` — ${note.detail}`),
      );
    }
    noteRecorded = true;
    noteId = note.fact?.id ?? null;
    if (disabled) {
      throw new Skip(
        `(disabled in config) — note canary recorded, projection outcome ${note.embedding ?? "absent"}`,
      );
    }
    if (note.embedding === undefined) {
      throw new Error("memory_note response carries no embedding field");
    }
    if (note.embedding.startsWith("unavailable:")) {
      throw new Error(
        `memory_note reports embedding: ${note.embedding} — the deployed ` +
          `daemon's semantic leg is down (state: ${note.embedding.slice("unavailable:".length)})`,
      );
    }
    return `memory_note reports embedding: ${note.embedding} for fact ${noteId ?? "?"}`;
  });

  // 4. Live semantic recall: poll memory_recall with the paraphrase until the
  // queued projection settles, bounded. A degraded envelope fails LOUDLY with
  // the state named — this is the assertion that would have caught D1.
  const semanticRecall = disabled
    ? skipped("semantic-recall", "(disabled in config)")
    : !articlePlanted
    ? {
      name: "semantic-recall",
      passed: false,
      detail: "the article canary was never planted (see write-article-projection)",
    }
    : await attempt("semantic-recall", async () => {
      const deadline = Date.now() + settleBudgetMs;
      let delay = initialPollMs;
      let lastRowCount = 0;
      for (;;) {
        const envelope = await recallMemory(port, PARAPHRASE_QUERY);
        if (envelope.semantic.startsWith("degraded:")) {
          throw new Error(
            `memory_recall envelope is semantic: ${envelope.semantic} — the ` +
              "deployed daemon's semantic leg is down (state: " +
              `${envelope.semantic.slice("degraded:".length)})`,
          );
        }
        if (envelope.semantic !== "hybrid") {
          throw new Error(
            `memory_recall envelope reports unexpected semantic: ${envelope.semantic}`,
          );
        }
        const rows = [...envelope.pitfalls, ...envelope.articles];
        lastRowCount = rows.length;
        if (rows.some((row) => row.scope === "repo" && row.id === articleId)) {
          return `paraphrase recall ranks ${articleId} with semantic: hybrid`;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `paraphrase recall did not surface ${articleId} within ` +
              `${Math.round(settleBudgetMs / 1000)}s (last bundle had ` +
              `${lastRowCount} row(s)) — the queued projection never settled`,
          );
        }
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, MAX_POLL_MS);
      }
    });

  // 5. Live FTS recall + drill-down through the live path.
  const ftsRecall = await attempt("fts-recall", async () => {
    if (!articlePlanted) {
      throw new Error(
        "the article canary was never planted (see write-article-projection)",
      );
    }
    const hits = await searchMemory(port, nonce, { scope: "repo", limit: 5 });
    if (!hits.some((hit) => hit.id === articleId)) {
      throw new Error(
        `memory_search did not find ${articleId} by its nonce term ` +
          `(got: ${hits.map((hit) => hit.id).join(", ") || "no hits"})`,
      );
    }
    return `memory_search finds ${articleId} by exact term`;
  });

  const articleReadBack = await attempt("article-read-back", async () => {
    if (!articlePlanted) {
      throw new Error(
        "the article canary was never planted (see write-article-projection)",
      );
    }
    const fact = await readMemory(port, "repo", articleId);
    if (fact.title !== articleTitle) {
      throw new Error(`memory_read returned a mismatched title for ${articleId}`);
    }
    return `memory_read round-trips ${articleId} intact`;
  });

  const noteReadBack = noteSurfaceAbsent
    ? skipped("note-read-back", "episodic store is not open on this daemon")
    : await attempt("note-read-back", async () => {
      if (!noteRecorded) {
        throw new Error(
          "the note canary was never recorded (see write-note-projection)",
        );
      }
      const envelope = await queryMemory(port, {
        class: "point-search",
        query: nonce,
      });
      const found = envelope.results.some((row) =>
        JSON.stringify(row).includes(nonce)
      );
      if (!found) {
        throw new Error(
          `memory_query point-search did not find the note canary by its ` +
            `nonce (state: ${envelope.state}, rows: ${envelope.results.length})`,
        );
      }
      return `memory_query point-search finds note canary ${noteId ?? "?"} by its nonce`;
    });

  const digestRead = await attempt("digest-read", async () => {
    const envelope = await digestMemory(port, { digestId: 1 });
    if (envelope.state === "absent") {
      throw new Skip(
        envelope.detail ?? "episodic store is not open on this daemon",
      );
    }
    if (envelope.state !== "ok" && envelope.state !== "empty") {
      throw new Error(`memory_digest returned unexpected state "${envelope.state}"`);
    }
    // A fresh project honestly answers "empty"; a lived one answers "ok".
    // Both prove the digest surface responds through the live path.
    return `memory_digest answers through the live path (state: ${envelope.state})`;
  });

  // 6. Cleanup, best the tool surface allows: the wiki canary deletes over
  // MCP; the episodic note canary has no invalidate path over MCP (the store
  // is bi-temporal — supersede, never delete), so it stays, labeled.
  const cleanup = await attempt("cleanup", async () => {
    if (!articlePlanted) return "nothing was planted — nothing to clean";
    const deleted = await deleteMemory(port, "repo", articleId);
    if (!deleted) {
      throw new Error(`memory_delete returned deleted:false for ${articleId}`);
    }
    return (
      `deleted ${articleId} via memory_delete; note canary ${noteId ?? "?"} ` +
      "remains in the episodic store (bi-temporal, no MCP invalidate path) " +
      `— it is labeled "${CANARY_LABEL}"`
    );
  });

  return report([
    discovery,
    reportedState,
    articleProjection,
    noteProjection,
    semanticRecall,
    ftsRecall,
    articleReadBack,
    noteReadBack,
    digestRead,
    cleanup,
  ]);
}

export async function memoryLiveSelfTestCli(
  options: LiveSelfTestOptions = {},
): Promise<number> {
  const report = await runMemoryLiveSelfTest(options);
  for (const line of report.lines) console.log(line);
  const passed = report.lines.filter((line) =>
    line.startsWith("[live] PASS ")
  ).length;
  const skippedCount = report.lines.filter((line) =>
    line.startsWith("[live] SKIP ")
  ).length;
  console.log(
    report.ok
      ? `memory self-test --live: all ${passed} live assertions passed` +
        (skippedCount > 0
          ? ` (${skippedCount} skipped — embeddings disabled in config)`
          : "")
      : "memory self-test --live: FAILED — the deployed daemon's memory " +
        "surface is degraded",
  );
  return report.ok ? 0 : 1;
}
