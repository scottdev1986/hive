import { readFile } from "node:fs/promises";
import { isErrnoCode } from "../../../shared/error-message";
import { isRecord } from "../../../shared/is-record";
import { type JsonObject, safeJsonParse } from "../../../shared/json";

export { isRecord };

/** Read a vendor's project config file so Hive can rewrite it without taking the user's own settings with it. Hive owns a few keys in these files and nothing else — an MCP server entry, an agent definition — while the rest belongs to whoever set it. So the write path is always read, replace Hive's keys, write back, and this is the read. Missing, unparseable, and "parsed but not an object" all return an empty record rather than throwing. A config Hive cannot read is one it cannot preserve, and the alternative to overwriting it is refusing to spawn — which is a worse answer for a file the agent may not even need. Callers that must not lose data to a malformed file check for it themselves. */
export async function readProjectConfig(path: string): Promise<JsonObject> {
  const source = await readFile(path, "utf8").catch((error) => {
    if (isErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (source === null) return {};
  const parsed = safeJsonParse(source);
  return isRecord(parsed) ? parsed : {};
}
