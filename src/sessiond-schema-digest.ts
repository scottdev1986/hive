import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SESSION_PROTOCOL_SCHEMA_RELATIVE =
  "workspace/Tests/WorkspaceCoreTests/Fixtures/session-protocol.schema.json";

export const SESSIOND_SCHEMA_EMPTY_TREE =
  "sessiond schema check refused: tree session-protocol.schema.json is empty";

export const SESSIOND_SCHEMA_DIGEST_MISMATCH =
  "sessiond schema digest mismatch";

/** Stable token inside the production schema (and any fixture that wants
 * to be extractable). Used only to locate the embed; the digest is of the
 * whole JSON object, not of this token. */
const EMBED_LOCATOR = Buffer.from('"generatedFrom"');

export function schemaDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function jsonObjectEnd(buf: Buffer, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < buf.length; i += 1) {
    const c = buf[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === 0x5c) {
        escaped = true;
        continue;
      }
      if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) {
      inString = true;
      continue;
    }
    if (c === 0x7b) depth += 1;
    else if (c === 0x7d) {
      depth -= 1;
      if (depth === 0) {
        const after = i + 1;
        return buf[after] === 0x0a ? after + 1 : after;
      }
    }
  }
  return null;
}

/** Raw `@embedFile` bytes of session-protocol.schema.json inside a staged
 * hive-sessiond, or null when that JSON object is not in the binary. */
export function extractEmbeddedSessionProtocolSchema(
  binary: Uint8Array,
): Buffer | null {
  const buf = asBuffer(binary);
  const locator = buf.indexOf(EMBED_LOCATOR);
  if (locator < 0) return null;
  let start = locator;
  while (start > 0 && buf[start] !== 0x7b) start -= 1;
  if (buf[start] !== 0x7b) return null;
  const end = jsonObjectEnd(buf, start);
  if (end === null) return null;
  return buf.subarray(start, end);
}

export function stagedEmbeddedSchemaDigest(binary: Uint8Array): string | null {
  const embedded = extractEmbeddedSessionProtocolSchema(binary);
  return embedded === null ? null : schemaDigest(embedded);
}

export function assertSessiondSchemaDigest(
  binary: Uint8Array,
  treeSchema: Uint8Array,
) {
  if (treeSchema.byteLength === 0) {
    throw new Error(SESSIOND_SCHEMA_EMPTY_TREE);
  }
  const treeDigest = schemaDigest(treeSchema);
  const stagedDigest = stagedEmbeddedSchemaDigest(binary);
  if (stagedDigest === null || stagedDigest !== treeDigest) {
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
