// The semantic memory leg (HiveMemory HM-5 core, board #122; plan
// 2026-07-22-hivememory-epic-rework.md decision D4): local fastembed-class
// ONNX embeddings plus the vector index maintained in the episodic store.
//
// Posture, mirroring graphify's healthy/unhealthy stance: the semantic
// surface is either AVAILABLE (model loaded, dimension asserted) or
// UNAVAILABLE with a plain-language detail — it NEVER crashes the daemon and
// NEVER fabricates vectors (hash pseudo-embeddings are the named failure
// mode from the design research). When it is unavailable, recall degrades to
// exactly today's FTS-only bundle. There is deliberately no automatic
// fallback machinery (D4): `embedding_provider: "api"` is a manual escape
// hatch, not a failover — the knob parses and reports an honest
// not-configured/not-implemented state, and that is all it does.
//
// The model loads LAZILY on first use: daemon start pays nothing (~2 s init,
// ~100–300 MB RSS warm — measured by scripts/memory-embedding-bench.ts), and
// daemons that never see a recall never load it. Models cache under the
// Hive-owned models dir (~/.hive/models, HIVE_HOME-respecting), not any
// global default cache.
//
// Where the fastembed runtime itself comes from (defect D1): the deployed
// daemon is a single-file `bun build --compile` binary, and a compiled binary
// cannot resolve a package's bare-specifier dependency graph from a real
// node_modules directory — fastembed's own `import "onnxruntime-node"` fails,
// and the onnxruntime .node/.dylib natives cannot ride inside the single
// file. What a compiled binary CAN do (spiked 2026-07-22) is dynamic-import a
// pre-bundled single ESM file by absolute path, whose internal runtime
// `require()` of relative native assets then loads fine. So the runtime ships
// as an EXTERNAL bundle under ~/.hive/tools/embeddings (HIVE_EMBEDDINGS_HOME
// override), provisioned and probe-verified by `hive embeddings install`;
// the repo's node_modules stays the dev fallback. Each failure mode —
// runtime missing, bundle broken, native lib unloadable — is a DISTINCT
// labeled state, never one generic "unavailable".
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryEmbeddingModel } from "../schemas";
import type { EpisodicStore, MemoryEmbeddingRow } from "./episodic-store";

/** The embedder the rest of the daemon codes against. Unit tests substitute
 * a mock here — `bun test` never downloads a model. */
export interface MemoryEmbedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export type MemoryEmbeddingStatus =
  | { state: "pending" }
  | { state: "available"; model: string; dimensions: number }
  | { state: "unavailable"; detail: string };

export interface MemoryEmbeddingConfig {
  provider: "local" | "api";
  model: MemoryEmbeddingModel;
}

/** The env var the "api" knob checks. HM-5 ships no API provider; the knob
 * exists so the config surface is ratified and the error is honest (D4). */
export const MEMORY_EMBEDDING_API_KEY_ENV = "HIVE_EMBEDDING_API_KEY";

/** Where local models cache. Hive-owned, HIVE_HOME-respecting — never the
 * library's global default cache. */
export function memoryModelsDir(): string {
  const home = Bun.env.HIVE_HOME ?? join(homedir(), ".hive");
  return join(home, "models");
}

/** The env override for the external embedding runtime dir. */
export const EMBEDDINGS_RUNTIME_HOME_ENV = "HIVE_EMBEDDINGS_HOME";

/** The bundle (relative to the runtime dir) `hive embeddings install`
 * produces: one pre-bundled ESM file plus its native assets alongside. */
export const EMBEDDINGS_RUNTIME_BUNDLE = join("dist", "entry.js");

/** Where the external embedding runtime (bundled fastembed + onnxruntime
 * native libs) lives. Machine-level, like the graphify tool install;
 * HIVE_EMBEDDINGS_HOME wins, then HIVE_HOME's tools dir. */
export function embeddingsRuntimeDir(): string {
  const override = Bun.env[EMBEDDINGS_RUNTIME_HOME_ENV];
  if (override !== undefined) return override;
  const home = Bun.env.HIVE_HOME ?? join(homedir(), ".hive");
  return join(home, "tools", "embeddings");
}

/** The slice of the fastembed module surface the daemon uses, structurally
 * typed so the external bundle and the package import both satisfy it. */
interface FastembedRuntime {
  FlagEmbedding: {
    init(options: {
      model: unknown;
      cacheDir: string;
      showDownloadProgress: boolean;
    }): Promise<{
      embed(texts: string[]): AsyncIterable<number[][]>;
      queryEmbed(text: string): Promise<number[]>;
    }>;
  };
  EmbeddingModel: {
    BGESmallENV15: unknown;
    AllMiniLML6V2: unknown;
  };
}

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Resolve the fastembed module: the external runtime bundle first (the only
 * path that works in the compiled daemon), then the repo's node_modules (the
 * dev path under plain `bun`). Every failure is thrown with a DISTINCT label
 * so the daemon's unavailable state says exactly which leg broke. */
async function importFastembedRuntime(): Promise<{
  runtime: FastembedRuntime;
  origin: string;
}> {
  const bundlePath = join(embeddingsRuntimeDir(), EMBEDDINGS_RUNTIME_BUNDLE);
  if (await Bun.file(bundlePath).exists()) {
    try {
      return {
        runtime: await import(bundlePath) as FastembedRuntime,
        origin: bundlePath,
      };
    } catch (error) {
      const message = errorDetail(error);
      const label = /\.node|\.dylib|dlopen/i.test(message)
        ? "embedding-native-unloadable"
        : "embedding-runtime-broken";
      throw new Error(
        `${label}: the external embedding runtime bundle at ${bundlePath} ` +
          `failed to load: ${message} — reinstall with \`hive embeddings install\``,
      );
    }
  }
  try {
    return {
      runtime: await import("fastembed") as FastembedRuntime,
      origin: "fastembed from node_modules (repo dev path)",
    };
  } catch (error) {
    throw new Error(
      `embedding-runtime-missing: no external runtime bundle at ${bundlePath} ` +
        `and the fastembed package is not resolvable (${errorDetail(error)}) — ` +
        "run `hive embeddings install`",
    );
  }
}

/** Expected output dimension per supported model, asserted at load: a model
 * that loads but embeds at the wrong width is a drift bug, so the surface
 * goes unavailable rather than mixing widths in the vector store. */
const EXPECTED_DIMENSIONS: Record<MemoryEmbeddingModel, number> = {
  "bge-small-en-v1.5": 384,
  "all-MiniLM-L6-v2": 384,
};

/** Build the embedder from a resolved fastembed module: init the session and
 * assert the width at load (D4) — one warm-up probe doubles as the check. A
 * model that loads but embeds at the wrong width is a drift bug, so the
 * surface goes unavailable rather than mixing widths in the vector store. */
async function embedderFromRuntime(
  runtime: FastembedRuntime,
  model: MemoryEmbeddingModel,
  cacheDir: string,
): Promise<MemoryEmbedder> {
  const { FlagEmbedding, EmbeddingModel } = runtime;
  const fastembedModel = model === "bge-small-en-v1.5"
    ? EmbeddingModel.BGESmallENV15
    : EmbeddingModel.AllMiniLML6V2;
  const session = await FlagEmbedding.init({
    model: fastembedModel,
    cacheDir,
    showDownloadProgress: false,
  });
  const collect = async (texts: string[]): Promise<number[][]> => {
    const vectors: number[][] = [];
    for await (const batch of session.embed(texts)) {
      vectors.push(...batch);
    }
    return vectors;
  };
  const probe = await collect(["hive memory embedding dimension probe"]);
  const dimensions = probe[0]?.length ?? 0;
  const expected = EXPECTED_DIMENSIONS[model];
  if (dimensions !== expected) {
    throw new Error(
      `embedding model ${model} produced ${dimensions}-dim vectors, ` +
        `expected ${expected} — refusing to mix widths in the vector store`,
    );
  }
  return {
    model,
    dimensions,
    embed: collect,
    embedQuery: (text) => session.queryEmbed(text),
  };
}

/** Load a local fastembed model. The runtime resolves dynamically (external
 * bundle, then repo node_modules — see the header) so nothing pays the module
 * (or the ~90 MB model download) until the first real embed. */
async function loadLocalEmbedder(
  model: MemoryEmbeddingModel,
  cacheDir: string,
): Promise<MemoryEmbedder> {
  const { runtime } = await importFastembedRuntime();
  return embedderFromRuntime(runtime, model, cacheDir);
}

/** The strict post-install probe `hive embeddings install` runs: load the
 * bundle at `runtimeDir` — and ONLY that bundle, never the node_modules
 * fallback, so a broken install can never be masked by a checkout's dev
 * path — and embed a probe string, asserting the model width. Install is
 * only "done" when this passes. Throws on any failure. */
export async function probeExternalRuntime(
  runtimeDir: string,
  model: MemoryEmbeddingModel,
  cacheDir: string,
): Promise<{ bundlePath: string; model: string; dimensions: number }> {
  const bundlePath = join(runtimeDir, EMBEDDINGS_RUNTIME_BUNDLE);
  if (!(await Bun.file(bundlePath).exists())) {
    throw new Error(
      `embedding-runtime-missing: no runtime bundle at ${bundlePath}`,
    );
  }
  const runtime = await import(bundlePath) as FastembedRuntime;
  const embedder = await embedderFromRuntime(runtime, model, cacheDir);
  return {
    bundlePath,
    model: embedder.model,
    dimensions: embedder.dimensions,
  };
}

/** The embedder factory the service calls on first use — the production
 * default loads fastembed; tests substitute a mock so `bun test` never
 * downloads a model. */
export type MemoryEmbedderLoad = (
  model: MemoryEmbeddingModel,
  cacheDir: string,
) => Promise<MemoryEmbedder>;

/**
 * The lazy singleton behind the semantic surface. One init attempt is
 * memoized: a failure is a permanent UNAVAILABLE state for the daemon's
 * lifetime (logged, never retried into a crash loop, never thrown into a
 * caller). Test seam: `load` substitutes the embedder factory.
 */
export class MemoryEmbeddingService {
  private attempt: Promise<MemoryEmbedder | null> | null = null;
  private failureDetail: string | null = null;

  constructor(
    private readonly config: MemoryEmbeddingConfig,
    private readonly options: {
      cacheDir?: string;
      load?: MemoryEmbedderLoad;
    } = {},
  ) {}

  /** The configured provider/model, for the daemon's loud start log. */
  get provider(): "local" | "api" {
    return this.config.provider;
  }

  get model(): MemoryEmbeddingModel {
    return this.config.model;
  }

  /** The current surface state without forcing a load. */
  status(): MemoryEmbeddingStatus {
    if (this.config.provider === "api") {
      return { state: "unavailable", detail: this.apiUnavailableDetail() };
    }
    if (this.failureDetail !== null) {
      return { state: "unavailable", detail: this.failureDetail };
    }
    return { state: "pending" };
  }

  private apiUnavailableDetail(): string {
    if (Bun.env[MEMORY_EMBEDDING_API_KEY_ENV] === undefined) {
      return `embedding_provider is "api" but ${MEMORY_EMBEDDING_API_KEY_ENV} ` +
        "is not set — semantic memory is unavailable (the api knob is a " +
        "manual escape hatch, not a fallback; set the key or use \"local\")";
    }
    return "embedding_provider is \"api\" and an API key is set, but no API " +
      "embedding provider ships in this build (HM-5 is local-only per plan " +
      "D4) — semantic memory is unavailable";
  }

  /** The embedder, loading the model on first call; null when unavailable.
   * Never throws. */
  async embedder(): Promise<MemoryEmbedder | null> {
    if (this.config.provider === "api") return null;
    if (this.attempt === null) {
      const cacheDir = this.options.cacheDir ?? memoryModelsDir();
      const load = this.options.load ?? loadLocalEmbedder;
      this.attempt = load(this.config.model, cacheDir).catch((error) => {
        this.failureDetail =
          `local embedding model ${this.config.model} failed to load: ${
            error instanceof Error ? error.message : "unknown error"
          } — semantic memory is unavailable, recall is FTS-only`;
        console.error(`Hive memory embeddings: ${this.failureDetail}`);
        return null;
      });
    }
    return this.attempt;
  }
}

const dot = (a: Float32Array, b: readonly number[]): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
};

const norm = (a: Float32Array | readonly number[]): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * a[i]!;
  return Math.sqrt(sum);
};

export function cosineSimilarity(
  a: Float32Array,
  b: readonly number[],
): number {
  const denominator = norm(a) * norm(b);
  return denominator === 0 ? 0 : dot(a, b) / denominator;
}

export interface SemanticArticleHit {
  scope: string;
  id: string;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

/**
 * The maintained half of the semantic leg: embeds sources into the episodic
 * store's vector table on the memory write paths and answers brute-force
 * cosine top-k queries over it. Index maintenance is failure-isolated — an
 * embedding failure is logged and the write it rode on still succeeds;
 * recall with an unavailable surface returns null (the caller then renders
 * exactly the FTS-only bundle).
 */
export class MemoryEmbeddingIndex {
  constructor(
    private readonly deps: {
      store: EpisodicStore;
      service: MemoryEmbeddingService;
      log?: (message: string) => void;
    },
  ) {}

  private log(message: string): void {
    (this.deps.log ?? console.error)(message);
  }

  /** The text an article embeds as: title plus body — the same fields the
   * FTS index feeds its porter tokenizer. */
  static articleText(article: { title: string; body: string }): string {
    return `${article.title}\n${article.body}`;
  }

  static factText(fact: { title: string; body: string }): string {
    return `${fact.title}\n${fact.body}`;
  }

  private async embedAndStore(
    kind: "article" | "fact",
    scope: string,
    sourceId: string,
    text: string,
  ): Promise<void> {
    try {
      const embedder = await this.deps.service.embedder();
      if (embedder === null) return;
      const [vector] = await embedder.embed([text]);
      if (vector === undefined) {
        throw new Error(`embedder returned no vector for ${kind} ${sourceId}`);
      }
      this.deps.store.upsertMemoryEmbedding({
        kind,
        scope,
        sourceId,
        model: embedder.model,
        vector: Float32Array.from(vector),
      });
    } catch (error) {
      // Failure-isolated by contract: the source write already succeeded and
      // the semantic leg is a recall enhancement, not correctness (D4).
      this.log(
        `Hive memory embedding index maintenance failed for ${kind} ` +
          `${sourceId}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  upsertArticle(scope: string, id: string, text: string): Promise<void> {
    return this.embedAndStore("article", scope, id, text);
  }

  removeArticle(scope: string, id: string): void {
    this.deps.store.removeMemoryEmbedding("article", scope, id);
  }

  upsertFact(id: string, text: string): Promise<void> {
    return this.embedAndStore("fact", "", id, text);
  }

  /** Drop vector rows whose source disappeared (deleted article,
   * invalidated fact) — the stale-row half of index maintenance. */
  prune(keep: { articles: ReadonlySet<string>; facts: ReadonlySet<string> }): number {
    try {
      return this.deps.store.pruneMemoryEmbeddings(keep);
    } catch (error) {
      this.log(
        `Hive memory embedding prune failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return 0;
    }
  }

  /** Cosine top-k over the stored article vectors, or null when the semantic
   * surface is unavailable — the exact signal the recall bundle uses to fall
   * back to byte-identical FTS-only output. Brute force by design: corpora
   * are small and there is no sqlite-vec native dependency. */
  async searchArticles(query: string, limit: number): Promise<SemanticArticleHit[] | null> {
    const embedder = await this.deps.service.embedder();
    if (embedder === null) return null;
    const queryVector = await embedder.embedQuery(query);
    const rows = this.deps.store.memoryEmbeddings({ kind: "article" })
      .filter((row: MemoryEmbeddingRow) => row.dimensions === queryVector.length);
    const scored = rows.map((row) => ({
      scope: row.scope,
      id: row.sourceId,
      score: cosineSimilarity(row.vector, queryVector),
    }));
    scored.sort((a, b) =>
      b.score - a.score || a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id)
    );
    return scored.slice(0, limit);
  }
}
