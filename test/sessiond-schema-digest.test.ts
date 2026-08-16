import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertSessiondSchemaDigest,
  assertStagedSessiondSchemaDigest,
  extractEmbeddedSessionProtocolSchema,
  SESSIOND_SCHEMA_DIGEST_MISMATCH,
  SESSIOND_SCHEMA_EMPTY_TREE,
  schemaDigest,
  stagedEmbeddedSchemaDigest,
} from "../src/sessiond-schema-digest";
import { OUTSIDE_REPO_TMPDIR } from "./outside-repo-tmpdir";

const STAGED = Buffer.from(
  '{"schemaVersion":1,"generatedFrom":["src/schemas/session-protocol.ts"]}',
);
const STAGED_DIGEST = schemaDigest(STAGED);
const TREE = Buffer.from(
  '{"schemaVersion":999,"generatedFrom":["src/schemas/session-protocol.ts"]}',
);
const TREE_DIGEST = schemaDigest(TREE);

test("agreement is green when the binary embed digest equals the tree digest", () => {
  const match = assertSessiondSchemaDigest(
    Buffer.concat([Buffer.from("hdr"), STAGED, Buffer.from("tlr")]),
    STAGED,
  );
  expect(match.treeDigest).toBe(STAGED_DIGEST);
  expect(match.stagedDigest).toBe(STAGED_DIGEST);
});

test("a stale present binary is refused naming both real digests, not absent", () => {
  const binary = Buffer.concat([
    Buffer.from("hdr"),
    STAGED,
    Buffer.from("tlr"),
  ]);
  expect(stagedEmbeddedSchemaDigest(binary)).toBe(STAGED_DIGEST);
  expect(TREE_DIGEST).not.toBe(STAGED_DIGEST);
  expect(() => assertSessiondSchemaDigest(binary, TREE)).toThrow(
    `${SESSIOND_SCHEMA_DIGEST_MISMATCH}: staged=${STAGED_DIGEST} tree=${TREE_DIGEST}`,
  );
});

test("an unrelated staged binary is a named digest mismatch", () => {
  expect(() =>
    assertSessiondSchemaDigest(Buffer.from("unrelated binary"), TREE),
  ).toThrow(
    `${SESSIOND_SCHEMA_DIGEST_MISMATCH}: staged=absent tree=${TREE_DIGEST}`,
  );
});

test("an empty tree schema is refused by name", () => {
  expect(() =>
    assertSessiondSchemaDigest(Buffer.from("hdr"), Buffer.from("")),
  ).toThrow(SESSIOND_SCHEMA_EMPTY_TREE);
});

test("extract reads the embed from the binary without consulting the tree", () => {
  const binary = Buffer.concat([Buffer.from("xx"), STAGED, Buffer.from("yy")]);
  expect(extractEmbeddedSessionProtocolSchema(binary)?.equals(STAGED)).toBe(
    true,
  );
  expect(extractEmbeddedSessionProtocolSchema(Buffer.from("nope"))).toBeNull();
});

test("path check: mutating the on-disk tree names both digests, then the unmutated file passes", () => {
  const fixture = mkdtempSync(
    join(OUTSIDE_REPO_TMPDIR, "hive-sessiond-schema-digest-"),
  );
  try {
    mkdirSync(fixture, { recursive: true });
    const binaryPath = join(fixture, "hive-sessiond");
    const schemaPath = join(fixture, "session-protocol.schema.json");
    writeFileSync(binaryPath, Buffer.concat([Buffer.from("bin"), STAGED]));
    writeFileSync(schemaPath, TREE);
    expect(() =>
      assertStagedSessiondSchemaDigest(binaryPath, schemaPath),
    ).toThrow(
      `${SESSIOND_SCHEMA_DIGEST_MISMATCH}: staged=${STAGED_DIGEST} tree=${TREE_DIGEST}`,
    );
    writeFileSync(schemaPath, STAGED);
    const match = assertStagedSessiondSchemaDigest(binaryPath, schemaPath);
    expect(match.treeDigest).toBe(STAGED_DIGEST);
    expect(match.stagedDigest).toBe(STAGED_DIGEST);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
