import { describe, expect, test } from "bun:test";
import {
  MemoryFactSchema,
  MemorySearchResultSchema,
  MemoryWriteResultSchema,
  type MemoryFact,
} from "./memory";

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
    expect(() => MemoryFactSchema.parse({
      ...withoutVerified,
      verfied: "2026-07-13",
    })).toThrow();
  });

  test("verification status and date cannot contradict each other", () => {
    expect(() => MemoryFactSchema.parse({
      ...verifiedFact,
      status: "unverified",
    })).toThrow();
    expect(() => MemoryFactSchema.parse({
      ...verifiedFact,
      status: "stale",
      verified: undefined,
    })).toThrow();
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
    expect(() => MemoryWriteResultSchema.parse({ ...result, raw_path: result.rawPath }))
      .toThrow();
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
    expect(() => MemorySearchResultSchema.parse({ ...result, date: "last Tuesday" }))
      .toThrow();
  });
});
