import { describe, expect, test } from "bun:test";
import {
  type MemoryFact,
  MemoryFactSchema,
  MemorySearchResultSchema,
  MemoryWriteResultSchema,
} from "../../src/schemas/memory";
import {
  MemoryJobReceiptSchema,
  MemoryMutationRequestSchema,
} from "../../src/schemas/memory-projections";

const timestamp = "2026-07-13T12:00:00.000Z";

const verifiedFact: MemoryFact = {
  id: "delivery-boundary",
  scope: "repo",
  topic: "delivery",
  title: "Delivery needs an observed boundary",
  body: "A paste is not proof that the model received a message.",
  tags: ["delivery"],
  date: "2026-07-13",
  path: "/repo/.hive/memory/wiki/delivery/delivery-boundary.md",
  source: "agent",
  evidence: "Measured against a live recipient",
  status: "verified",
  kind: "article",
  supersedes: [],
  raw: ["../../raw/delivery/2026-07-13-delivery-boundary.md"],
  verified: "2026-07-13",
};

describe("persisted memory contracts", () => {
  test("accepts and preserves a complete verified fact", () => {
    expect(MemoryFactSchema.parse(verifiedFact)).toEqual(verifiedFact);
  });

  test("a misspelled verification date cannot become a verified fact", () => {
    const { verified: _, ...withoutVerified } = verifiedFact;
    expect(() =>
      MemoryFactSchema.parse({
        ...withoutVerified,
        verfied: "2026-07-13",
      }),
    ).toThrow();
  });

  test("verification status and date cannot contradict each other", () => {
    expect(() =>
      MemoryFactSchema.parse({
        ...verifiedFact,
        status: "unverified",
      }),
    ).toThrow();
    expect(() =>
      MemoryFactSchema.parse({
        ...verifiedFact,
        status: "stale",
        verified: undefined,
      }),
    ).toThrow();
    expect(() =>
      MemoryFactSchema.parse({
        ...verifiedFact,
        date: "2026-02-31",
      }),
    ).toThrow();
  });

  test("conflict status does not depend on magic words in prose", () => {
    expect(
      MemoryFactSchema.parse({
        ...verifiedFact,
        status: "conflicted",
        verified: undefined,
        body: "Two independently sourced claims reach different conclusions.",
      }).status,
    ).toBe("conflicted");
  });

  test("write results reject unknown keys and preserve their positive fields", () => {
    const result = {
      id: verifiedFact.id,
      scope: verifiedFact.scope,
      topic: verifiedFact.topic,
      title: verifiedFact.title,
      path: verifiedFact.path,
      rawPath: "/repo/.hive/memory/raw/delivery/observation.md",
      source: verifiedFact.source,
      status: verifiedFact.status,
      verified: verifiedFact.verified,
    };
    expect(MemoryWriteResultSchema.parse(result)).toEqual(result);
    expect(() =>
      MemoryWriteResultSchema.parse({ ...result, raw_path: result.rawPath }),
    ).toThrow();
  });

  test("search-result dates use the same date contract as facts", () => {
    const result = {
      id: verifiedFact.id,
      scope: verifiedFact.scope,
      topic: verifiedFact.topic,
      title: verifiedFact.title,
      snippet: verifiedFact.body,
      date: verifiedFact.date,
      status: verifiedFact.status,
      tags: verifiedFact.tags,
      path: verifiedFact.path,
    };
    expect(MemorySearchResultSchema.parse(result)).toEqual(result);
    expect(() =>
      MemorySearchResultSchema.parse({ ...result, date: "last Tuesday" }),
    ).toThrow();
    expect(() =>
      MemorySearchResultSchema.parse({ ...result, date: "2026-02-31" }),
    ).toThrow();
  });
});

describe("memory mutation contracts", () => {
  const write = {
    scope: "repo" as const,
    topic: "delivery",
    title: "Delivery boundary",
    body: "The receiver must acknowledge delivery.",
    source: "agent" as const,
    evidence: "Observed in a live run",
    status: "unverified" as const,
    supersedes: [],
  };

  test("validates create input at the request boundary", () => {
    expect(
      MemoryMutationRequestSchema.parse({ action: "create", input: write }),
    ).toMatchObject({ action: "create", input: { kind: "article" } });
    expect(
      MemoryMutationRequestSchema.safeParse({ action: "create", input: {} })
        .success,
    ).toBe(false);
  });

  test("an update takes identity only from its fence", () => {
    const { scope: _, ...input } = write;
    const request = {
      action: "update",
      input,
      scope: "repo",
      id: "delivery-boundary",
      expectedRevision: "sha256:revision",
    };
    expect(MemoryMutationRequestSchema.safeParse(request).success).toBe(true);
    expect(
      MemoryMutationRequestSchema.safeParse({
        ...request,
        input: { ...input, scope: "global" },
      }).success,
    ).toBe(false);
  });
});

describe("MemoryJobReceiptSchema", () => {
  const running = {
    id: "00000001-reindex",
    kind: "reindex",
    state: "running",
    requestedBy: "queen",
    startedAt: timestamp,
    finishedAt: null,
    progress: { step: "starting", done: 0, total: null },
    summary: "",
    error: null,
    readback: null,
  };

  test("rejects state-dependent contradictions", () => {
    expect(MemoryJobReceiptSchema.safeParse(running).success).toBe(true);
    expect(
      MemoryJobReceiptSchema.safeParse({
        ...running,
        finishedAt: timestamp,
      }).success,
    ).toBe(false);
    expect(
      MemoryJobReceiptSchema.safeParse({
        ...running,
        state: "failed",
        finishedAt: timestamp,
      }).success,
    ).toBe(false);
  });

  test("rejects progress beyond its total", () => {
    expect(
      MemoryJobReceiptSchema.safeParse({
        ...running,
        progress: { step: "indexing", done: 2, total: 1 },
      }).success,
    ).toBe(false);
  });
});
