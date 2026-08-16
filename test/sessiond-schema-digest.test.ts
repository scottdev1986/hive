import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertSessiondSchemaDigest,
  assertStagedSessiondSchemaDigest,
  SESSIOND_SCHEMA_DIGEST_MISMATCH,
  SESSIOND_SCHEMA_EMPTY_TREE,
  schemaDigest,
} from "../src/sessiond-schema-digest";
import { OUTSIDE_REPO_TMPDIR } from "./outside-repo-tmpdir";

const TREE = Buffer.from('{"schemaVersion":1,"title":"session-protocol"}');
const TREE_DIGEST = schemaDigest(TREE);

test("agreement is green only when the staged binary embeds the tree schema bytes", () => {
  const match = assertSessiondSchemaDigest(
    Buffer.concat([Buffer.from("hdr"), TREE, Buffer.from("tlr")]),
    TREE,
  );
  expect(match.treeDigest).toBe(TREE_DIGEST);
  expect(match.stagedDigest).toBe(TREE_DIGEST);
});

test("a mutated tree schema is refused by the digest-mismatch name", () => {
  const binary = Buffer.concat([Buffer.from("hdr"), TREE, Buffer.from("tlr")]);
  const mutated = Buffer.from('{"schemaVersion":1,"title":"MUTATED"}');
  const mutatedDigest = schemaDigest(mutated);
  expect(mutatedDigest).not.toBe(TREE_DIGEST);
  expect(() => assertSessiondSchemaDigest(binary, mutated)).toThrow(
    `${SESSIOND_SCHEMA_DIGEST_MISMATCH}: staged=absent tree=${mutatedDigest}`,
  );
});

test("an unrelated staged binary is a named digest mismatch, not a generic error", () => {
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

test("path check: mutating the on-disk schema file fires the named refusal, then the unmutated file passes", () => {
  const fixture = mkdtempSync(
    join(OUTSIDE_REPO_TMPDIR, "hive-sessiond-schema-digest-"),
  );
  try {
    mkdirSync(fixture, { recursive: true });
    const binaryPath = join(fixture, "hive-sessiond");
    const schemaPath = join(fixture, "session-protocol.schema.json");
    writeFileSync(binaryPath, Buffer.concat([Buffer.from("bin"), TREE]));
    writeFileSync(
      schemaPath,
      Buffer.from('{"schemaVersion":1,"title":"MUTATED"}'),
    );
    expect(() =>
      assertStagedSessiondSchemaDigest(binaryPath, schemaPath),
    ).toThrow(SESSIOND_SCHEMA_DIGEST_MISMATCH);
    writeFileSync(schemaPath, TREE);
    const match = assertStagedSessiondSchemaDigest(binaryPath, schemaPath);
    expect(match.treeDigest).toBe(TREE_DIGEST);
    expect(match.stagedDigest).toBe(TREE_DIGEST);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
