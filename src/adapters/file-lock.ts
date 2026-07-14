import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";

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

/** How long a lock whose owner record cannot be read is given to become
 * readable before it is treated as a corpse. Generous: writing the record is a
 * single write of a few dozen bytes, and the cost of being wrong in the other
 * direction is two processes in one critical section. */
const UNREADABLE_LOCK_GRACE_MS = 1_000;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Publish the lock, or fail because someone else holds it.
 *
 * The owner is written to a private staging file and only then given the lock's
 * name, because `link` fails rather than replaces. Creating the lock and then
 * writing into it — which is what this used to do — leaves a window in which the
 * lock file exists and is empty, and a process that dies inside that window
 * leaves an empty lock behind: no owner to check for liveness, so nothing ever
 * reclaims it, so the lock is held by nobody until a human deletes it. Here the
 * name and the complete contents appear in the same instant. */
async function publish(
  path: string,
  encoded: string,
  token: string,
): Promise<boolean> {
  const staging = `${path}.staging.${token}`;
  await writeFile(staging, encoded, { mode: 0o600 });
  try {
    await link(staging, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}

/** Reclaim a lock whose owner is gone, without ever unlinking the lock's name.
 *
 * The old code compared the file's contents to what it had read and then called
 * `unlink(path)` — but the comparison and the unlink are two steps, and a live
 * owner can publish in between. The contender would then delete a lock that
 * somebody was holding, and two processes would be inside the same critical
 * section believing they were alone.
 *
 * `rename` is the only compare-and-swap the filesystem offers: exactly one
 * contender can move a given directory entry, so exactly one contender does the
 * removal, and it removes a file it has already taken exclusive possession of
 * rather than a name that may have been reused. If what it moved turns out not
 * to be the dead lock it inspected — a live owner published in the window
 * between the read and the rename — it puts it back with `link`, which refuses
 * to overwrite whatever may now be there.
 *
 * The residual: if a *third* contender publishes in the instant between the
 * rename and the restore, the restore fails and the live owner's file is gone
 * while another process holds the name. Both would then be inside the section.
 * Closing that last window needs a lock the kernel releases on death (`flock` /
 * `O_EXLOCK`), which no Node/Bun API exposes portably; this is strictly narrower
 * than what it replaces, and it is the honest limit of an advisory file lock. */
async function reclaim(
  path: string,
  source: string,
  token: string,
): Promise<void> {
  const staged = `${path}.stale.${token}`;
  try {
    await rename(path, staged);
  } catch (error) {
    if (isMissingFileError(error)) return; // another contender got there first
    throw error;
  }
  const moved = await readFile(staged, "utf8").catch(() => null);
  if (moved !== source) {
    // Not the corpse we inspected. Restore it; `link` will not clobber a lock
    // that has appeared in the meantime.
    await link(staged, path).catch(() => undefined);
  }
  await unlink(staged).catch(() => undefined);
}

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const owner: FileLockOwner = { pid: process.pid, token: crypto.randomUUID() };
  const encoded = `${JSON.stringify(owner)}\n`;
  const deadline = Date.now() + 10_000;
  let unreadableSince: number | null = null;
  while (true) {
    // Checked on every path through the loop, not just the one that sleeps: a
    // contender that keeps losing races would otherwise spin past its deadline.
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for lock ${path}`);
    }
    if (await publish(path, encoded, owner.token)) break;
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    const current = parseLockOwner(source, path);
    if (current === null) {
      // A lock with no legible owner is one of two things, and they look
      // identical: an owner still writing its record — which this protocol no
      // longer does, but a process running an older build still might — or the
      // corpse of one that died inside that window, which nothing would ever
      // reclaim. Time tells them apart. Writing the record takes microseconds; a
      // corpse stays unreadable forever. So wait, and reclaim only what is still
      // unreadable long after any writer would have finished.
      const now = Date.now();
      unreadableSince ??= now;
      if (now - unreadableSince >= UNREADABLE_LOCK_GRACE_MS) {
        await reclaim(path, source, owner.token);
        unreadableSince = null;
      } else {
        await Bun.sleep(20);
      }
      continue;
    }
    unreadableSince = null;
    if (!isAlive(current.pid)) {
      await reclaim(path, source, owner.token);
      continue;
    }
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
