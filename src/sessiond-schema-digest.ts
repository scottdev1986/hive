/** Staged hive-sessiond embeds session-protocol.schema.json at compile time
 * (`@embedFile`). A binary staged before a wire-schema change is present and
 * still wrong. This check compares digests, not existence. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SESSION_PROTOCOL_SCHEMA_RELATIVE =
  "workspace/Tests/WorkspaceCoreTests/Fixtures/session-protocol.schema.json";

export const SESSIOND_SCHEMA_EMPTY_TREE =
  "sessiond schema check refused: tree session-protocol.schema.json is empty";

export const SESSIOND_SCHEMA_DIGEST_MISMATCH =
  "sessiond schema digest mismatch";

export function schemaDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** SHA-256 of the schema bytes `@embedFile`d into the binary, or null when
 * those exact bytes are not present. Absence of the tree bytes is a digest
 * mismatch, not a missing-file pass. */
export function stagedEmbeddedSchemaDigest(
  binary: Uint8Array,
  treeSchema: Uint8Array,
): string | null {
  if (treeSchema.byteLength === 0) return null;
  return asBuffer(binary).includes(asBuffer(treeSchema))
    ? schemaDigest(treeSchema)
    : null;
}

export function assertSessiondSchemaDigest(
  binary: Uint8Array,
  treeSchema: Uint8Array,
): { treeDigest: string; stagedDigest: string } {
  if (treeSchema.byteLength === 0) {
    throw new Error(SESSIOND_SCHEMA_EMPTY_TREE);
  }
  const treeDigest = schemaDigest(treeSchema);
  const stagedDigest = stagedEmbeddedSchemaDigest(binary, treeSchema);
  if (stagedDigest !== treeDigest) {
    throw new Error(
      `${SESSIOND_SCHEMA_DIGEST_MISMATCH}: staged=${stagedDigest ?? "absent"} tree=${treeDigest}`,
    );
  }
  return { treeDigest, stagedDigest };
}

export function assertStagedSessiondSchemaDigest(
  binaryPath: string,
  treeSchemaPath: string,
): { treeDigest: string; stagedDigest: string } {
  let treeSchema: Buffer;
  try {
    treeSchema = readFileSync(treeSchemaPath);
  } catch {
    throw new Error(
      `sessiond schema check refused: tree session-protocol.schema.json is absent at ${treeSchemaPath}`,
    );
  }
  let binary: Buffer;
  try {
    binary = readFileSync(binaryPath);
  } catch {
    throw new Error(
      `sessiond schema check refused: staged hive-sessiond is absent at ${binaryPath}`,
    );
  }
  return assertSessiondSchemaDigest(binary, treeSchema);
}

if (import.meta.main) {
  const binaryPath = process.argv[2];
  const treeSchemaPath = process.argv[3];
  if (binaryPath === undefined || treeSchemaPath === undefined) {
    console.error(
      "usage: sessiond-schema-digest <staged-hive-sessiond> <session-protocol.schema.json>",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = assertStagedSessiondSchemaDigest(
        binaryPath,
        treeSchemaPath,
      );
      console.log(
        `sessiond schema digest match tree=${result.treeDigest} staged=${result.stagedDigest}`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
