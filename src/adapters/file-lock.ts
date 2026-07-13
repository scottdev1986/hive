import { open, readFile, unlink } from "node:fs/promises";

interface FileLockOwner {
  readonly pid: number;
  readonly token: string;
}

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error &&
  error.code === "ENOENT";

function parseLockOwner(source: string, path: string): FileLockOwner | null {
  if (source.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
  ) throw new Error(`Invalid lock owner in ${path}`);
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "pid" && key !== "token") ||
    !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 ||
    typeof record.token !== "string" || record.token.length === 0
  ) throw new Error(`Invalid lock owner in ${path}`);
  return { pid: Number(record.pid), token: record.token };
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const owner: FileLockOwner = { pid: process.pid, token: crypto.randomUUID() };
  const encoded = `${JSON.stringify(owner)}\n`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(encoded);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    const current = parseLockOwner(source, path);
    if (current !== null && !isAlive(current.pid)) {
      const unchanged = await readFile(path, "utf8").catch(() => null);
      if (unchanged === source) {
        await unlink(path).catch(() => undefined);
        const after = await readFile(path, "utf8").catch(() => null);
        if (after === null) continue;
      }
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${path}`);
    await Bun.sleep(20);
  }

  try {
    return await operation();
  } finally {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current === encoded) {
      await unlink(path).catch(() => undefined);
      if (await readFile(path, "utf8").catch(() => null) === encoded) {
        throw new Error(`Failed to release lock ${path}`);
      }
    }
  }
}
