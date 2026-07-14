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

/** Reclaim a lock whose owner is provably dead, without ever unlinking the
 * lock's name.
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
 * This is only ever called for a lock whose owner pid is dead, so there is no
 * live original owner to strand. What it narrows, versus the old unconditional
 * unlink, is the case where the dead owner's slot was reused by a live one
 * between our inspection and our rename.
 *
 * TWO RESIDUALS REMAIN, and neither is closable with the primitives a POSIX
 * filesystem exposes; both belong to whoever owns full cross-process lock
 * hardening, not to this slice:
 *  - If this process crashes between the rename and the restore, a live owner
 *    that had republished into `path` is left with its lock moved aside — it is
 *    stranded until a human clears the `.stale.` file.
 *  - If a third contender publishes into `path` in the instant between the
 *    rename and the restore, the restore takes the EEXIST branch and the moved
 *    owner's file is gone while another process holds the name.
 * Closing either needs a lock the kernel releases on process death (`flock` /
 * `O_EXLOCK`), which no portable Node/Bun API offers. What is here is strictly
 * safer than the unconditional unlink it replaces; it is not airtight, and it
 * does not pretend to be. */
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
  if (moved === source) {
    // The corpse we inspected, now ours alone. Drop it.
    await unlink(staged).catch(() => undefined);
    return;
  }
  // Not the corpse: a live owner published into `path` between our read and our
  // rename, and we have moved their lock aside. Put it back.
  try {
    await link(staged, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      // The restore failed and `path` is, as far as we know, still free.
      // Deleting `staged` now would destroy a live owner's only lock file and
      // admit a second holder — exactly the fault this function exists to avoid.
      // Leave it on disk (it sits at a private name and blocks nothing at
      // `path`) and surface the fault instead of papering over it by unlinking.
      throw error;
    }
    // EEXIST: a newer lock already holds `path`; our staged copy is redundant.
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
    // An unreadable lock (no legible owner) is NEVER reclaimed. It is one of two
    // things and no amount of waiting can tell them apart: the corpse of a
    // process that died before writing its record, or a live one still writing
    // it. A clock cannot discriminate them — a paused writer and a corpse look
    // identical for any grace you pick — and stealing a lock a live writer is
    // about to hold puts two processes in one critical section, which is the one
    // outcome a lock may never produce. So we wait, and if it never clears we
    // time out: a lock unowned until a human clears it is a liveness failure,
    // strictly safer than a mutual-exclusion failure. This protocol's own
    // `publish` never creates an unreadable lock (the name and its contents
    // appear together), so this can only be an artifact of an older build.
    if (current !== null && !isAlive(current.pid)) {
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
