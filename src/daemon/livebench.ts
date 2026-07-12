import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  type ProviderDiscovery,
} from "../schemas";
import type {
  BenchmarkSourceAdapter,
  InventoryBenchmark,
} from "./benchmarks";

const LIVEBENCH_ORIGIN = "https://livebench.ai";
const SOURCE = `${LIVEBENCH_ORIGIN}/`;
const REFRESH_MS = 24 * 60 * 60 * 1_000;
const INDEX_LIMIT = 64 * 1_024;
const BUNDLE_LIMIT = 10 * 1_024 * 1_024;
const DATA_LIMIT = 5 * 1_024 * 1_024;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,199}$/;
const SAFE_METRIC = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CATEGORY = /^[A-Za-z][A-Za-z0-9 ]{0,63}$/;
const RELEASE = /^\d{4}-\d{2}-\d{2}$/;

const ScoreMapSchema = z.record(
  z.string().regex(SAFE_METRIC),
  z.number().finite().min(0).max(100),
);
const CostMapSchema = z.record(
  z.string().regex(SAFE_METRIC),
  z.number().finite().nonnegative(),
);

export const LiveBenchRowSchema = z.strictObject({
  model: z.string().regex(SAFE_MODEL_ID),
  scores: ScoreMapSchema,
  costs: CostMapSchema,
  scoreSource: z.url(),
  costSource: z.url(),
  releaseDate: z.string().regex(RELEASE),
  fetchedAt: z.iso.datetime({ offset: true }),
});

export type LiveBenchRow = z.infer<typeof LiveBenchRowSchema>;

export const LiveBenchSnapshotSchema = z.strictObject({
  source: z.literal(SOURCE),
  releaseDate: z.string().regex(RELEASE),
  fetchedAt: z.iso.datetime({ offset: true }),
  categoriesSource: z.url(),
  categories: z.record(
    z.string().regex(SAFE_CATEGORY),
    z.array(z.string().regex(SAFE_METRIC)),
  ),
  rows: z.array(LiveBenchRowSchema),
});

export type LiveBenchSnapshot = z.infer<typeof LiveBenchSnapshotSchema>;

const LiveBenchCacheSchema = z.strictObject({
  checkedAt: z.iso.datetime({ offset: true }),
  lastError: z.string().nullable(),
  snapshot: LiveBenchSnapshotSchema.nullable(),
});

type LiveBenchCache = z.infer<typeof LiveBenchCacheSchema>;

export type LiveBenchRead = {
  status: "off" | "current" | "last-good" | "unavailable";
  detail: string;
  snapshot: LiveBenchSnapshot | null;
};

export type LiveBenchFetcher = (url: string) => Promise<Response>;

export type LiveBenchOptions = {
  mode: "auto" | "off";
  fetcher?: LiveBenchFetcher;
  cachePath?: string;
  now?: () => Date;
};

const defaultCachePath = (): string =>
  join(Bun.env.HIVE_HOME ?? join(homedir(), ".hive"), "livebench-cache.json");

async function responseText(
  response: Response,
  url: string,
  limit: number,
): Promise<string> {
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`${url} exceeds the ${limit}-byte limit`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > limit) {
    throw new Error(`${url} exceeds the ${limit}-byte limit`);
  }
  return text;
}

async function fetchText(
  fetcher: LiveBenchFetcher,
  url: string,
  limit: number,
): Promise<string> {
  return responseText(await fetcher(url), url, limit);
}

export function releaseFromBundle(bundle: string): string {
  const arrays = bundle.match(/\["\d{4}-\d{2}-\d{2}"(?:,"\d{4}-\d{2}-\d{2}")+\]/g) ?? [];
  const candidates = arrays.flatMap((value) => {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.length >= 2 &&
          parsed.every((item) => typeof item === "string" && RELEASE.test(item))
        ? [parsed as string[]]
        : [];
    } catch {
      return [];
    }
  });
  if (candidates.length === 0) {
    throw new Error("LiveBench bundle contained no release list");
  }
  const longest = Math.max(...candidates.map((candidate) => candidate.length));
  const winners = candidates.filter((candidate) => candidate.length === longest);
  if (winners.length !== 1) {
    throw new Error("LiveBench bundle contained an ambiguous release list");
  }
  const releases = [...new Set(winners[0])].sort();
  const latest = releases.at(-1);
  if (latest === undefined || Number.isNaN(Date.parse(`${latest}T00:00:00Z`))) {
    throw new Error("LiveBench bundle's latest release date is invalid");
  }
  return latest;
}

async function discoverRelease(fetcher: LiveBenchFetcher): Promise<string> {
  const index = await fetchText(fetcher, SOURCE, INDEX_LIMIT);
  const scripts = [...index.matchAll(/src=["'](\.\/static\/js\/main\.[a-f0-9]+\.js)["']/g)]
    .map((match) => match[1]);
  if (scripts.length !== 1) {
    throw new Error("LiveBench index did not name exactly one main JavaScript bundle");
  }
  const url = new URL(scripts[0]!, SOURCE);
  if (url.origin !== LIVEBENCH_ORIGIN) {
    throw new Error("LiveBench index named a bundle outside livebench.ai");
  }
  return releaseFromBundle(await fetchText(fetcher, url.href, BUNDLE_LIMIT));
}

export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV ended inside a quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.length > 0));
}

function numericRows(
  source: string,
  range: "score" | "cost",
): { headers: string[]; rows: Map<string, Record<string, number>> } {
  const csv = parseCsv(source);
  const header = csv.shift();
  if (header === undefined || header[0] !== "model" || header.length < 2) {
    throw new Error(`${range} CSV has no model header`);
  }
  const headers = header.slice(1);
  if (headers.length > 512 || new Set(headers).size !== headers.length ||
      headers.some((value) => !SAFE_METRIC.test(value))) {
    throw new Error(`${range} CSV has invalid or duplicate metric names`);
  }
  const rows = new Map<string, Record<string, number>>();
  if (csv.length > 2_000) throw new Error(`${range} CSV has too many model rows`);
  for (const values of csv) {
    if (values.length !== header.length) {
      throw new Error(`${range} CSV row has ${values.length} columns; expected ${header.length}`);
    }
    const model = values[0]!;
    if (!SAFE_MODEL_ID.test(model) || rows.has(model)) {
      throw new Error(`${range} CSV has an invalid or duplicate model id`);
    }
    const measurements: Record<string, number> = {};
    for (let index = 0; index < headers.length; index += 1) {
      const raw = values[index + 1]!;
      if (raw === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || (range === "score" && value > 100)) {
        throw new Error(`${range} CSV contains an invalid numeric measurement`);
      }
      measurements[headers[index]!] = value;
    }
    rows.set(model, measurements);
  }
  return { headers, rows };
}

function categoriesFromJson(source: string, scoreHeaders: readonly string[]) {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("LiveBench categories JSON did not parse");
  }
  const parsed = LiveBenchSnapshotSchema.shape.categories.safeParse(value);
  if (!parsed.success) throw new Error("LiveBench categories JSON has an invalid shape");
  const known = new Set(scoreHeaders);
  if (Object.values(parsed.data).flat().some((task) => !known.has(task))) {
    throw new Error("LiveBench categories name a task absent from the score table");
  }
  return parsed.data;
}

export async function fetchLiveBenchSnapshot(
  fetcher: LiveBenchFetcher = (url) => fetch(url),
  now: Date = new Date(),
): Promise<LiveBenchSnapshot> {
  const releaseDate = await discoverRelease(fetcher);
  const token = releaseDate.replaceAll("-", "_");
  const scoreSource = `${LIVEBENCH_ORIGIN}/table_${token}.csv`;
  const categoriesSource = `${LIVEBENCH_ORIGIN}/categories_${token}.json`;
  const costSource = `${LIVEBENCH_ORIGIN}/cost_${token}.csv`;
  const [scoreText, categoryText, costText] = await Promise.all([
    fetchText(fetcher, scoreSource, DATA_LIMIT),
    fetchText(fetcher, categoriesSource, DATA_LIMIT),
    fetchText(fetcher, costSource, DATA_LIMIT),
  ]);
  const scores = numericRows(scoreText, "score");
  const costs = numericRows(costText, "cost");
  const fetchedAt = now.toISOString();
  return LiveBenchSnapshotSchema.parse({
    source: SOURCE,
    releaseDate,
    fetchedAt,
    categoriesSource,
    categories: categoriesFromJson(categoryText, scores.headers),
    rows: [...scores.rows.entries()].map(([model, measurements]) => ({
      model,
      scores: measurements,
      costs: costs.rows.get(model) ?? {},
      scoreSource,
      costSource,
      releaseDate,
      fetchedAt,
    })),
  });
}

async function readCache(path: string): Promise<LiveBenchCache | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const parsed = LiveBenchCacheSchema.safeParse(await file.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

async function writeCache(path: string, cache: LiveBenchCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`);
  await rename(temporary, path);
}

export async function readLiveBench(options: LiveBenchOptions): Promise<LiveBenchRead> {
  if (options.mode === "off") {
    return { status: "off", detail: "LiveBench ingestion is off in config.toml", snapshot: null };
  }
  const now = options.now?.() ?? new Date();
  const path = options.cachePath ?? defaultCachePath();
  const cached = await readCache(path);
  if (
    cached !== null && now.getTime() - Date.parse(cached.checkedAt) < REFRESH_MS
  ) {
    return cached.snapshot === null
      ? { status: "unavailable", detail: cached.lastError ?? "LiveBench has no last-good snapshot", snapshot: null }
      : {
          status: cached.lastError === null ? "current" : "last-good",
          detail: cached.lastError ?? `LiveBench ${cached.snapshot.releaseDate} fetched ${cached.snapshot.fetchedAt}`,
          snapshot: cached.snapshot,
        };
  }
  try {
    const snapshot = await fetchLiveBenchSnapshot(options.fetcher, now);
    let detail = `LiveBench ${snapshot.releaseDate} fetched ${snapshot.fetchedAt}`;
    try {
      await writeCache(path, {
        checkedAt: now.toISOString(),
        lastError: null,
        snapshot,
      });
    } catch (error) {
      detail += `; cache write failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`;
    }
    return {
      status: "current",
      detail,
      snapshot,
    };
  } catch (error) {
    const detail = `LiveBench refresh failed: ${
      error instanceof Error ? error.message : "unknown error"
    }`;
    await writeCache(path, {
      checkedAt: now.toISOString(),
      lastError: detail,
      snapshot: cached?.snapshot ?? null,
    }).catch(() => undefined);
    return cached?.snapshot == null
      ? { status: "unavailable", detail, snapshot: null }
      : { status: "last-good", detail, snapshot: cached.snapshot };
  }
}

function acceptedRowNames(canonicalId: string, effort: string): string[] {
  return [
    `${canonicalId}-${effort}`,
    `${canonicalId}-${effort}-effort`,
    `${canonicalId}-thinking-${effort}`,
    `${canonicalId}-thinking-${effort}-effort`,
    `${canonicalId}-thinking-auto-${effort}`,
    `${canonicalId}-thinking-auto-${effort}-effort`,
  ];
}

export function liveBenchInventoryBenchmarks(
  snapshot: LiveBenchSnapshot | null,
  discovery: Record<CapabilityProvider, ProviderDiscovery>,
): Map<string, InventoryBenchmark[]> {
  const result = new Map<string, InventoryBenchmark[]>();
  if (snapshot === null) return result;
  const byName = new Map(snapshot.rows.map((row) => [row.model, row]));
  // Every vendor in the union, not a hardcoded pair: a vendor nobody iterated
  // has no benchmark evidence, and a model with no evidence is not ranked —
  // which reads exactly like a model that ranked last.
  for (const provider of CAPABILITY_PROVIDERS) {
    const found = discovery[provider];
    if (found.status !== "ok") continue;
    for (const record of found.records) {
      if (record.supportedEffortLevels.state !== "known") continue;
      const benchmarks: InventoryBenchmark[] = [];
      for (const effort of record.supportedEffortLevels.value) {
        const matches = acceptedRowNames(record.canonicalId, effort)
          .map((name) => byName.get(name))
          .filter((row): row is LiveBenchRow => row !== undefined);
        if (matches.length !== 1) continue;
        const row = matches[0]!;
        benchmarks.push({
          sourceId: "livebench",
          effort,
          scores: { ...row.scores },
          source: row.scoreSource,
          releaseDate: row.releaseDate,
          fetchedAt: row.fetchedAt,
        });
      }
      if (benchmarks.length > 0) {
        result.set(`${provider}\0${record.canonicalId}`, benchmarks);
      }
    }
  }
  return result;
}

/** A candidate adapter. It is deliberately not registered by default. */
export function liveBenchSource(
  options: Omit<LiveBenchOptions, "mode"> = {},
): BenchmarkSourceAdapter {
  return {
    sourceId: "livebench",
    async read(discovery) {
      const read = await readLiveBench({ ...options, mode: "auto" });
      return {
        sourceId: "livebench",
        status: read.status === "off" ? "unavailable" : read.status,
        detail: read.detail,
        releaseDate: read.snapshot?.releaseDate ?? null,
        fetchedAt: read.snapshot?.fetchedAt ?? null,
        models: liveBenchInventoryBenchmarks(read.snapshot, discovery),
      };
    },
  };
}
