import { describe, expect, test } from "bun:test";
import {
  digestWorkManifest,
  type WorkManifest,
  WorkManifestJournalEntrySchema,
  WorkManifestSchema,
} from "../../src/schemas/work-manifest";

const manifest: WorkManifest = {
  agentId: "agent-maya",
  agentName: "maya",
  runId: null,
  nodeId: null,
  branch: "hive/maya-server",
  worktreePath: "/tmp/hive-maya",
  dirtyFiles: ["src/server.ts"],
  unmergedCommits: 2,
  lastStatus: "working",
  classification: "stranded",
  classificationReason: "2 unmerged commit(s) and 1 dirty file(s) not on main",
};

describe("WorkManifest", () => {
  test("round-trips through JSON against the real schema", () => {
    const parsed = WorkManifestSchema.parse(manifest);
    expect(
      WorkManifestSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });

  test("rejects an out-of-enum classification and undeclared keys", () => {
    expect(
      WorkManifestSchema.safeParse({ ...manifest, classification: "lost" })
        .success,
    ).toBe(false);
    expect(
      WorkManifestSchema.safeParse({ ...manifest, note: "free-form" }).success,
    ).toBe(false);
  });

  test("the digest binds exact content, not the construction path", () => {
    const digest = digestWorkManifest(manifest);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // JSON re-parse shuffles nothing here, but a differently-built object
    // with the same content must hash identically — the digest names the
    // content, never the code path that produced it.
    const rebuilt = WorkManifestSchema.parse(
      JSON.parse(JSON.stringify(manifest)),
    );
    expect(digestWorkManifest(rebuilt)).toBe(digest);
    expect(digestWorkManifest({ ...manifest, unmergedCommits: 3 })).not.toBe(
      digest,
    );
  });
});

describe("WorkManifestJournalEntry", () => {
  const entry = {
    agentId: manifest.agentId,
    revision: "1",
    digest: digestWorkManifest(manifest),
    recordedAt: "2026-07-31T00:00:00.000Z",
    manifest,
  };

  test("round-trips through JSON against the real schema", () => {
    const parsed = WorkManifestJournalEntrySchema.parse(entry);
    expect(
      WorkManifestJournalEntrySchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });

  test("rejects a malformed digest and a non-uint64 revision", () => {
    expect(
      WorkManifestJournalEntrySchema.safeParse({ ...entry, digest: "deadbeef" })
        .success,
    ).toBe(false);
    expect(
      WorkManifestJournalEntrySchema.safeParse({ ...entry, revision: "-1" })
        .success,
    ).toBe(false);
  });
});
