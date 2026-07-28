import { readFile } from "node:fs/promises";

/**
 * Read a vendor's project config file so Hive can rewrite it without taking
 * the user's own settings with it.
 *
 * Hive owns a few keys in these files and nothing else — an MCP server entry,
 * an agent definition — while the rest belongs to whoever set it. So the write
 * path is always read, replace Hive's keys, write back, and this is the read.
 *
 * Missing, unparseable, and "parsed but not an object" all return an empty
 * record rather than throwing. A config Hive cannot read is one it cannot
 * preserve, and the alternative to overwriting it is refusing to spawn — which
 * is a worse answer for a file the agent may not even need. Callers that must
 * not lose data to a malformed file check for it themselves.
 */
export async function readProjectConfig(
  path: string,
): Promise<Record<string, unknown>> {
  const source = await readFile(path, "utf8").catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  });
  if (source === null) return {};
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
