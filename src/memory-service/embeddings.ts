// Semantic memory uses local ONNX embeddings plus the vector index maintained in the episodic store. Posture, mirroring graphify's healthy/unhealthy stance: the semantic surface is either AVAILABLE (model loaded, dimension asserted) or UNAVAILABLE with a plain-language detail — it NEVER crashes the daemon and NEVER fabricates vectors (hash pseudo-embeddings are the named failure mode). When it is unavailable, recall degrades to the FTS-only bundle. There is deliberately no automatic fallback machinery: `embedding_provider: "api"` is a manual escape hatch, not a failover — the knob parses and reports an honest not-configured/not-implemented state, and that is all it does. The model loads LAZILY on first use: daemon start pays nothing (~2 s init, ~100–300 MB RSS warm), and daemons that never see a recall never load it. Models cache under the Hive-owned models dir (~/.hive/models, HIVE_HOME-respecting), not any global default cache. The deployed daemon is a single-file `bun build --compile` binary. A compiled binary cannot resolve a package's bare-specifier dependency graph from a real node_modules directory — fastembed's own `import "onnxruntime-node"` fails, and the onnxruntime .node/.dylib natives cannot ride inside the single file. A compiled binary can dynamic-import a pre-bundled single ESM file by absolute path, whose internal runtime `require()` of relative native assets then loads fine. So the runtime ships as an EXTERNAL bundle under ~/.hive/tools/embeddings (HIVE_EMBEDDINGS_HOME override), provisioned and probe-verified by installing, updating, or initializing Hive; the repo's node_modules stays the dev fallback. Each mode — runtime missing, bundle broken, native lib unloadable, bytes not matching the digest this build shipped — is a DISTINCT labeled state, never one generic "unavailable". A release build refuses to import a runtime whose loaded bytes are not the ones it shipped with (release/embeddings-digest.ts): importing dist/entry.js executes plain JavaScript out of a user-writable directory, so integrity is checked immediately before the import, and fails closed.
import { dirname, join } from "node:path";
import { getHiveHome } from "../hive-home/home";
import { embeddingsRuntimeDigest } from "../release/embeddings-digest";
import type { MemoryEmbeddingModel } from "../schemas/config-schema";
import { HIVE_EMBEDDINGS_DIGEST } from "../shared/version";
import type { EpisodicStore, MemoryEmbeddingRow } from "./episodic";
import { errorMessage } from "../shared/error-message";

/** The embedder the rest of the daemon codes against. Unit tests substitute a mock here — `bun test` never downloads a model. */
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

export type MemoryEmbeddingStateLabel =
  | "ready"
  | "pending"
  | "disabled"
  | "embedding-runtime-missing"
  | "embedding-runtime-broken"
  | "embedding-native-unloadable"
  | "embedding-runtime-unverified"
  | "unavailable";

const DISTINGUISHED_FAILURE_LABELS = [
  "embedding-runtime-missing",
  "embedding-runtime-broken",
  "embedding-native-unloadable",
  "embedding-runtime-unverified",
] as const;

export function embeddingStateLabelFromDetail(
  detail: string,
): MemoryEmbeddingStateLabel {
  for (const label of DISTINGUISHED_FAILURE_LABELS) {
    if (detail.includes(label)) return label;
  }
  return "unavailable";
}

/** What actually happened to a write's vector projection: "indexed" — the vector is stored; "queued" — the first-ever embed is loading the model, so the projection runs in the background rather than blocking the write inside the memory lock; "unavailable:<state>" — the semantic leg is down and the write is keyword-searchable only. */
export type MemoryEmbeddingWriteOutcome =
  | "indexed"
  | "queued"
  | `unavailable:${MemoryEmbeddingStateLabel}`;

export interface MemoryEmbeddingConfig {
  provider: "local" | "api";
  model: MemoryEmbeddingModel;
}

export const MEMORY_EMBEDDING_API_KEY_ENV = "HIVE_EMBEDDING_API_KEY";

/** Where local models cache. Hive-owned, HIVE_HOME-respecting — never the library's global default cache. */
export function memoryModelsDir(): string {
  return join(getHiveHome(), "models");
}

export const EMBEDDINGS_RUNTIME_HOME_ENV = "HIVE_EMBEDDINGS_HOME";

export const EMBEDDINGS_RUNTIME_BUNDLE = join("dist", "entry.js");

export function embeddingsRuntimeDir(): string {
  const override = Bun.env[EMBEDDINGS_RUNTIME_HOME_ENV];
  if (override !== undefined) return override;
  return join(getHiveHome(), "tools", "embeddings");
}

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

/** Refuse a runtime whose loaded bytes are not the ones this build shipped. FAIL CLOSED, and the failure is loud: importing dist/entry.js executes plain JavaScript from a user-writable directory, so an unverifiable runtime is not loaded at all. Memory degrades to keyword-only with a distinct state rather than running code nobody vouched for. A build with no embedded digest (a source checkout, or any build without a release key) skips this: such a host is itself unsigned and rewritable, so verification would prove nothing, and a dev-staged runtime could never match a build-time constant. The gate is the presence of the compiled-in digest, which is a property of the signed artifact and deliberately not settable at runtime. */
async function verifyRuntimeIntegrity(runtimeDir: string): Promise<void> {
  if (HIVE_EMBEDDINGS_DIGEST === null) return;
  const remedy =
    "reinstall or update Hive to restore the runtime this build shipped " +
    "(a release build will not load a locally staged one)";
  let actual: string;
  try {
    actual = await embeddingsRuntimeDigest(runtimeDir);
  } catch (error) {
    throw new Error(
      `embedding-runtime-unverified: could not verify the embedding runtime ` +
        `at ${runtimeDir} (${errorMessage(error)}) — refusing to load it; ` +
        remedy,
    );
  }
  if (actual !== HIVE_EMBEDDINGS_DIGEST) {
    throw new Error(
      `embedding-runtime-unverified: the embedding runtime at ${runtimeDir} ` +
        `does not match this hive build (expected ${HIVE_EMBEDDINGS_DIGEST}, ` +
        `found ${actual}) — refusing to load it; ${remedy}`,
    );
  }
}

/** Recover the TRUE reason a bundle load failed, when the bundle lies about it. The tokenizers loader vendored inside the bundle swallows its own failure (`} catch {}`) and then reports the last leg of a per-architecture cascade, so a dlopen problem on the darwin-universal binding surfaces as "Cannot require module @anush008/tokenizers-darwin-arm64" — naming a package that is not supposed to exist and sending the reader after a missing file that was never missing. Loading the native libraries beside the bundle directly reproduces the real error (code-signature rejection, missing dependent library, wrong architecture), so the diagnostic can name the actual cause. Returns null when every native library loads, which means the failure is genuinely elsewhere in the bundle. */
export async function nativeLoadFailure(
  bundlePath: string,
): Promise<string | null> {
  const distDir = dirname(bundlePath);
  try {
    for await (const name of new Bun.Glob("*.node").scan(distDir)) {
      try {
        import.meta.require(join(distDir, name));
      } catch (error) {
        return `${name} could not be loaded: ${errorMessage(error)}`;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function importFastembedRuntime(): Promise<{
  runtime: FastembedRuntime;
  origin: string;
}> {
  const runtimeDir = embeddingsRuntimeDir();
  const bundlePath = join(runtimeDir, EMBEDDINGS_RUNTIME_BUNDLE);
  if (await Bun.file(bundlePath).exists()) {
    await verifyRuntimeIntegrity(runtimeDir);
    try {
      return {
        runtime: (await import(bundlePath)) as FastembedRuntime,
        origin: bundlePath,
      };
    } catch (error) {
      const native = await nativeLoadFailure(bundlePath);
      const message = native ?? errorMessage(error);
      const label =
        native !== null || /\.node|\.dylib|dlopen/i.test(message)
          ? "embedding-native-unloadable"
          : "embedding-runtime-broken";
      throw new Error(
        `${label}: the external embedding runtime bundle at ${bundlePath} ` +
          `failed to load: ${message} — re-run \`hive init\` to reprovision it`,
      );
    }
  }
  try {
    return {
      runtime: (await import("fastembed")) as FastembedRuntime,
      origin: "fastembed from node_modules (repo dev path)",
    };
  } catch (error) {
    throw new Error(
      `embedding-runtime-missing: no external runtime bundle at ${bundlePath} ` +
        `and the fastembed package is not resolvable (${errorMessage(error)}) — ` +
        "run `hive init` to provision it",
    );
  }
}

/** Expected output dimension per supported model, asserted at load: a model that loads but embeds at the wrong width is a drift bug, so the surface goes unavailable rather than mixing widths in the vector store. */
const EXPECTED_DIMENSIONS: Record<MemoryEmbeddingModel, number> = {
  "bge-small-en-v1.5": 384,
  "all-MiniLM-L6-v2": 384,
};

/** Build the embedder from a resolved fastembed module: init the session and assert the width at load (D4) — one warm-up probe doubles as the check. A model that loads but embeds at the wrong width is a drift bug, so the surface goes unavailable rather than mixing widths in the vector store. */
async function embedderFromRuntime(
  runtime: FastembedRuntime,
  model: MemoryEmbeddingModel,
  cacheDir: string,
): Promise<MemoryEmbedder> {
  const { FlagEmbedding, EmbeddingModel } = runtime;
  const fastembedModel =
    model === "bge-small-en-v1.5"
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

async function loadLocalEmbedder(
  model: MemoryEmbeddingModel,
  cacheDir: string,
): Promise<MemoryEmbedder> {
  const { runtime } = await importFastembedRuntime();
  return embedderFromRuntime(runtime, model, cacheDir);
}

/** The strict post-install probe every provisioning path runs: load the bundle at `runtimeDir` — and ONLY that bundle, never the node_modules fallback, so a broken install can never be masked by a checkout's dev path — and embed a probe string, asserting the model width. Install is only "done" when this passes. Throws on any failure. */
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
  // Provisioning must fail loudly here rather than leave a runtime that looks installed and is refused on first load.
  await verifyRuntimeIntegrity(runtimeDir);
  const runtime = (await import(bundlePath)) as FastembedRuntime;
  const embedder = await embedderFromRuntime(runtime, model, cacheDir);
  return {
    bundlePath,
    model: embedder.model,
    dimensions: embedder.dimensions,
  };
}

/** The embedder factory the service calls on first use — the production default loads fastembed; tests substitute a mock so `bun test` never downloads a model. */
export type MemoryEmbedderLoad = (
  model: MemoryEmbeddingModel,
  cacheDir: string,
) => Promise<MemoryEmbedder>;

/** The lazy singleton behind the semantic surface. One init attempt is memoized: a failure is a permanent UNAVAILABLE state for the daemon's lifetime (logged, never retried into a crash loop, never thrown into a caller). Test seam: `load` substitutes the embedder factory. */
export class MemoryEmbeddingService {
  private attempt: Promise<MemoryEmbedder | null> | null = null;
  private failureDetail: string | null = null;
  private loaded: MemoryEmbedder | null = null;

  constructor(
    private readonly config: MemoryEmbeddingConfig,
    private readonly options: {
      cacheDir?: string;
      load?: MemoryEmbedderLoad;
      log?: (message: string) => void;
    } = {},
  ) {}

  get provider(): "local" | "api" {
    return this.config.provider;
  }

  get model(): MemoryEmbeddingModel {
    return this.config.model;
  }

  status(): MemoryEmbeddingStatus {
    if (this.config.provider === "api") {
      return { state: "unavailable", detail: this.apiUnavailableDetail() };
    }
    if (this.loaded !== null) {
      return {
        state: "available",
        model: this.loaded.model,
        dimensions: this.loaded.dimensions,
      };
    }
    if (this.failureDetail !== null) {
      return { state: "unavailable", detail: this.failureDetail };
    }
    return { state: "pending" };
  }

  stateLabel(): MemoryEmbeddingStateLabel {
    if (this.config.provider === "api") return "disabled";
    if (this.loaded !== null) return "ready";
    if (this.failureDetail !== null) {
      return embeddingStateLabelFromDetail(this.failureDetail);
    }
    return "pending";
  }

  private apiUnavailableDetail(): string {
    if (Bun.env[MEMORY_EMBEDDING_API_KEY_ENV] === undefined) {
      return (
        `embedding_provider is "api" but ${MEMORY_EMBEDDING_API_KEY_ENV} ` +
        "is not set — semantic memory is unavailable (the api knob is a " +
        'manual escape hatch, not a fallback; set the key or use "local")'
      );
    }
    return (
      'embedding_provider is "api" and an API key is set, but no API ' +
      "embedding provider ships in this build (HM-5 is local-only per plan " +
      "D4) — semantic memory is unavailable"
    );
  }

  /** The embedder, loading the model on first call; null when unavailable. Never throws. */
  async embedder(): Promise<MemoryEmbedder | null> {
    if (this.config.provider === "api") return null;
    if (this.attempt === null) {
      const cacheDir = this.options.cacheDir ?? memoryModelsDir();
      const load = this.options.load ?? loadLocalEmbedder;
      this.attempt = load(this.config.model, cacheDir)
        .then((embedder) => {
          this.loaded = embedder;
          this.options.log?.(
            `Hive memory embeddings: READY — model ${embedder.model} loaded ` +
              `(${embedder.dimensions}-dim)`,
          );
          return embedder;
        })
        .catch((error) => {
          this.failureDetail = `local embedding model ${this.config.model} failed to load: ${
            error instanceof Error ? error.message : "unknown error"
          } — semantic memory is unavailable, recall is FTS-only`;
          console.error(`Hive memory embeddings: ${this.failureDetail}`);
          this.options.log?.(`Hive memory embeddings: ${this.failureDetail}`);
          return null;
        });
    }
    return this.attempt;
  }
}

const dot = (a: Float32Array, b: readonly number[]): number => {
  if (a.length !== b.length) {
    throw new Error(
      "Cannot compare embedding vectors with different dimensions",
    );
  }
  let sum = 0;
  for (const [i, value] of a.entries()) sum += value * (b[i] ?? 0);
  return sum;
};

const norm = (a: Float32Array | readonly number[]): number => {
  let sum = 0;
  for (const value of a) sum += value * value;
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
  score: number;
}

/** The maintained half of the semantic leg: embeds sources into the episodic store's vector table on the memory write paths and answers brute-force cosine top-k queries over it. Index maintenance is failure-isolated — an embedding failure is logged and the write it rode on still succeeds, with the projection's outcome reported back (indexed/queued/unavailable:<state>) so the write response can say what actually happened; recall with an unavailable surface returns null (the caller then renders the FTS-only bundle, labeled degraded). */
export class MemoryEmbeddingIndex {
  private readonly inflight = new Set<Promise<unknown>>();

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

  async settle(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  /** The text an article embeds as: title plus body — the same fields the FTS index feeds its porter tokenizer. */
  static articleText(article: { title: string; body: string }): string {
    return `${article.title}\n${article.body}`;
  }

  private async runEmbed(
    kind: "article" | "fact",
    scope: string,
    sourceId: string,
    text: string,
  ): Promise<MemoryEmbeddingWriteOutcome> {
    try {
      const embedder = await this.deps.service.embedder();
      if (embedder === null) {
        return `unavailable:${this.deps.service.stateLabel()}`;
      }
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
      return "indexed";
    } catch (error) {
      this.log(
        `Hive memory embedding index maintenance failed for ${kind} ` +
          `${sourceId}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return `unavailable:${this.deps.service.stateLabel()}`;
    }
  }

  private embedAndStore(
    kind: "article" | "fact",
    scope: string,
    sourceId: string,
    text: string,
  ): Promise<MemoryEmbeddingWriteOutcome> {
    const label = this.deps.service.stateLabel();
    if (label !== "ready" && label !== "pending") {
      // The leg is known-down (the load failure is memoized) or configured off — do not re-attempt on every write, say so on the response.
      return Promise.resolve<MemoryEmbeddingWriteOutcome>(
        `unavailable:${label}`,
      );
    }
    if (label === "pending") {
      // The first-ever embed pays the model load (~seconds warm, a download cold); that wait must not block the write inside the daemon's serialized memory lock. The projection runs in the background — tracked so settle() can drain it — and the write reports "queued".
      const pending = this.runEmbed(kind, scope, sourceId, text);
      this.inflight.add(pending);
      void pending.finally(() => this.inflight.delete(pending));
      return Promise.resolve("queued");
    }
    return this.runEmbed(kind, scope, sourceId, text);
  }

  upsertArticle(
    scope: string,
    id: string,
    text: string,
  ): Promise<MemoryEmbeddingWriteOutcome> {
    return this.embedAndStore("article", scope, id, text);
  }

  removeArticle(scope: string, id: string): void {
    this.deps.store.removeMemoryEmbedding("article", scope, id);
  }

  /** Drop vector rows whose article disappeared — the stale-row half of index maintenance. Rows of any other kind are left untouched: nothing writes them any more, so this pass has no basis on which to call one stale. */
  prune(keepArticles: ReadonlySet<string>): number {
    try {
      return this.deps.store.pruneMemoryEmbeddings(keepArticles);
    } catch (error) {
      this.log(
        `Hive memory embedding prune failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return 0;
    }
  }

  /** Cosine top-k over the stored article vectors, or null when the semantic surface is unavailable — the exact signal the recall bundle uses to fall back to byte-identical FTS-only output. Brute force by design: corpora are small and there is no sqlite-vec native dependency. */
  async searchArticles(
    query: string,
    limit: number,
  ): Promise<SemanticArticleHit[] | null> {
    const embedder = await this.deps.service.embedder();
    if (embedder === null) return null;
    const queryVector = await embedder.embedQuery(query);
    const rows = this.deps.store
      .memoryEmbeddings({ kind: "article" })
      .filter(
        (row: MemoryEmbeddingRow) => row.dimensions === queryVector.length,
      );
    const scored = rows.map((row) => ({
      scope: row.scope,
      id: row.sourceId,
      score: cosineSimilarity(row.vector, queryVector),
    }));
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.scope.localeCompare(b.scope) ||
        a.id.localeCompare(b.id),
    );
    return scored.slice(0, limit);
  }
}
