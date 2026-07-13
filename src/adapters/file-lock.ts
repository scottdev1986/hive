import { open, readFile, unlink } from "node:fs/promises";

interface FileLockOwner {
  readonly pid: number;
  readonly token: string;
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
    try {
      const current = JSON.parse(await readFile(path, "utf8")) as Partial<FileLockOwner>;
      if (!Number.isSafeInteger(current.pid) || !isAlive(current.pid!)) {
        await unlink(path).catch(() => undefined);
        continue;
      }
    } catch {
      await unlink(path).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${path}`);
    await Bun.sleep(20);
  }

  try {
    return await operation();
  } finally {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current === encoded) await unlink(path).catch(() => undefined);
  }
}
