import { withFileLock } from "../adapters/file-lock";

/** The one critical section for the Hive config document. Several unrelated features write this file — autonomy, memory retention — and each one is a read-modify-write of the WHOLE document, because a TOML edit has to preserve every table it does not own. Two such writers that serialize only against themselves lose edits in both directions: each reads the document, each renders its own change over the text it read, and whichever renames last erases the other's key while reporting success. Guarding one writer is not enough and neither is a private lock per writer. Every writer of this path has to take THIS lock, keyed on the path itself, so the exclusion holds between features and across processes. */
export function withHiveConfigLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileLock(`${path}.hive.lock`, operation);
}
