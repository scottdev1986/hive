#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { WorkspaceEventV2Schema } from "../../src/schemas/status-envelope";
import {
  buildReducerCorpus,
  buildWireCorpus,
  canonicalJson,
  emptyReducerProjection,
  encodeFrameHeader,
  parseFrameHeader,
  reduceWorkspaceEvent,
} from "./fixtures";
import { GENERATED_FILES, WIRE_SCHEMA_CATALOG } from "./generate";

type ConformanceReport = Readonly<{
  validEncodings: Readonly<Record<string, string>>;
  invalidRejected: readonly string[];
  validHeaders: readonly string[];
  ignoredHeaders: readonly string[];
  invalidHeaders: Readonly<Record<string, string>>;
  reducerPrefixes: Readonly<Record<string, readonly string[]>>;
}>;

const fromHex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function runTypeScriptConformance(): ConformanceReport {
  const corpus = buildWireCorpus();
  const validEncodings: Record<string, string> = {};
  const invalidRejected: string[] = [];
  for (const item of corpus.valid) {
    const schema = WIRE_SCHEMA_CATALOG[item.schema as keyof typeof WIRE_SCHEMA_CATALOG];
    const result = schema.safeParse(item.value);
    if (!result.success) throw new Error(`TypeScript rejected valid case ${item.name}: ${result.error.message}`);
    validEncodings[item.name] = canonicalJson(result.data);
  }
  for (const item of corpus.invalid) {
    const schema = WIRE_SCHEMA_CATALOG[item.schema as keyof typeof WIRE_SCHEMA_CATALOG];
    if (schema.safeParse(item.value).success) {
      throw new Error(`TypeScript accepted invalid case ${item.name}`);
    }
    invalidRejected.push(item.name);
  }

  const validHeaders: string[] = [];
  for (const item of corpus.frameHeaders.valid) {
    const encoded = encodeFrameHeader(item.fields);
    if (toHex(encoded) !== item.hex || canonicalJson(parseFrameHeader(encoded)) !== canonicalJson(item.fields)) {
      throw new Error(`TypeScript frame mismatch: ${item.name}`);
    }
    validHeaders.push(item.name);
  }
  const ignoredHeaders: string[] = [];
  for (const item of corpus.frameHeaders.ignored) {
    if (parseFrameHeader(fromHex(item.hex)) !== null) {
      throw new Error(`TypeScript did not ignore optional frame: ${item.name}`);
    }
    ignoredHeaders.push(item.name);
  }
  const invalidHeaders: Record<string, string> = {};
  for (const item of corpus.frameHeaders.invalid) {
    try {
      parseFrameHeader(fromHex(item.hex));
      throw new Error(`TypeScript accepted invalid frame: ${item.name}`);
    } catch (error) {
      const actual = error instanceof Error ? error.message : String(error);
      if (actual !== item.error) throw error;
      invalidHeaders[item.name] = actual;
    }
  }

  const reducerPrefixes: Record<string, string[]> = {};
  for (const scenario of buildReducerCorpus().scenarios) {
    let state = emptyReducerProjection();
    const prefixes: string[] = [];
    scenario.events.forEach((event, index) => {
      const parsed = WorkspaceEventV2Schema.parse(event);
      state = reduceWorkspaceEvent(state, parsed);
      const actual = canonicalJson(state);
      const expected = canonicalJson(scenario.prefixes[index]);
      if (actual !== expected) {
        throw new Error(`TypeScript reducer mismatch: ${scenario.name} prefix ${index + 1}`);
      }
      prefixes.push(actual);
    });
    reducerPrefixes[scenario.name] = prefixes;
  }

  return { validEncodings, invalidRejected, validHeaders, ignoredHeaders, invalidHeaders, reducerPrefixes };
}

export async function runSwiftConformance(): Promise<ConformanceReport> {
  const process = Bun.spawn([
    "swift",
    GENERATED_FILES.swift,
    GENERATED_FILES.schema,
    GENERATED_FILES.corpus,
    GENERATED_FILES.reducer,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Swift conformance exited ${exitCode}: ${stderr || stdout}`);
  }
  return JSON.parse(stdout) as ConformanceReport;
}

export async function runConformance() {
  const typescript = runTypeScriptConformance();
  const swift = await runSwiftConformance();
  const typescriptJson = canonicalJson(typescript);
  const swiftJson = canonicalJson(swift);
  if (typescriptJson !== swiftJson) {
    throw new Error("Swift and TypeScript conformance reports differ");
  }
  return {
    validCases: Object.keys(typescript.validEncodings).length,
    invalidCases: typescript.invalidRejected.length,
    validHeaders: typescript.validHeaders.length,
    ignoredHeaders: typescript.ignoredHeaders.length,
    invalidHeaders: Object.keys(typescript.invalidHeaders).length,
    reducerScenarios: Object.keys(typescript.reducerPrefixes).length,
    reducerPrefixes: Object.values(typescript.reducerPrefixes).reduce(
      (total, prefixes) => total + prefixes.length,
      0,
    ),
    zig: "generated-uncompiled-wp1",
  } as const;
}

if (import.meta.main) {
  // Ensure the runner consumes the checked-in fixtures, not only in-memory data.
  await Promise.all(Object.values(GENERATED_FILES).map((path) => readFile(path)));
  console.log(JSON.stringify(await runConformance(), null, 2));
}
