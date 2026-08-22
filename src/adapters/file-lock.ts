import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { safeJsonParse, type JsonObject, type JsonValue } from "../shared/json";
import { type ProcessLiveness, probeProcessLiveness } from "./process-liveness";
import { isErrnoCode } from "../shared/error-message";
import { isRecord, isString } from "../shared/is-record";

interface FileLockOwner {
  readonly pid: number;
  readonly token: string;
}

const isMissingFileError = <T>(error: T): error is T & { code: string } =>
  isErrnoCode(error, "ENOENT");

function parseLockOwner(source: string, path: string): FileLockOwner | null {
  if (source.trim() === "") return null;
  const parsed = safeJsonParse(source);
  if (parsed === undefined) return null;
  if (!isRecord(parsed)) throw new Error(`Invalid lock owner in ${path}`);
  // SAFETY: The surrounding code already established this contract.
  const record = parsed as JsonObject;
  if (
    Object.keys(record).some((key) => key !== "pid" && key !== "token") ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    !isString(record.token) ||
    record.token.length === 0
  )
    throw new Error(`Invalid lock owner in ${path}`);
  return { pid: Number(record.pid), token: record.token };
}

/** Publish the lock, or fail because someone else holds it. The owner is written to a private staging file and only then given the lock's name, because `link` fails rather than replaces. Creating the lock and then writing into it leaves a window in which the lock file exists and is empty. A process that dies inside that window leaves an empty lock behind: no owner to check for liveness, so nothing ever reclaims it, so the lock is held by nobody until a user deletes it. Here the name and the complete contents appear in the same instant. */
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
    // SAFETY: The surrounding code already established this contract.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}

/** Reclaim a lock whose owner is provably dead, without ever unlinking the lock's name. Do not compare the file's contents and then call `unlink(path)`: the comparison and unlink are two steps, and a live owner can publish in between. The contender would then delete a lock that somebody was holding, and two processes would be inside the same critical section believing they were alone. `rename` is the only compare-and-swap the filesystem offers: exactly one contender can move a given directory entry, so exactly one contender does the removal, and it removes a file it has already taken exclusive possession of rather than a name that may have been reused. If what it moved turns out not to be the dead lock it inspected — a live owner published in the window between the read and the rename — it puts it back with `link`, which refuses to overwrite whatever may now be there. This is only ever called for a lock whose owner pid is dead, so there is no live original owner to strand. It narrows the case where the dead owner's slot is reused by a live owner between our inspection and our rename. THREE RESIDUALS REMAIN, and none is closable with the primitives a POSIX filesystem exposes; all belong to whoever owns full cross-process lock hardening, not to this slice. Each requires the dead owner's slot to have been reused by a live one between our inspection and our rename (`moved !== source`) — already narrow — and then one further mishap: - If this process crashes between the rename and the restore, the live owner is left with its lock moved aside — stranded until a user clears the `.stale.` file. - If a third contender publishes into `path` in the instant between the rename and the restore, the restore takes the EEXIST branch and the moved owner's file is dropped while another process holds the name. - If the restore link() fails for any reason other than EEXIST, the error is surfaced rather than papered over (we do not unlink a lock we do not own) — but `path` is left free while the moved owner is still in its critical section, so a later contender can publish into `path` and overlap with it. Surfacing the fault beats destroying the lock; it does not restore exclusion. Closing any of these needs a lock the kernel releases on process death (`flock` / `O_EXLOCK`), which no portable Node/Bun API offers. What is here is strictly safer than the unconditional unlink it replaces; it is not airtight, and it does not pretend to be. */
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
    await unlink(staged).catch(() => undefined);
    return;
  }
  try {
    await link(staged, path);
  } catch (error) {
    // SAFETY: The surrounding code already established this contract.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  await unlink(staged).catch(() => undefined);
}

export interface WithFileLockOptions {
  readonly probe?: (pid: number) => ProcessLiveness;
  /** How long a contender waits for the holder before giving up — also the window after which a foreign-uid lock is treated as stale. */
  readonly deadlineMs?: number;
}

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: WithFileLockOptions = {},
): Promise<T> {
  const probe = options.probe ?? probeProcessLiveness;
  const owner: FileLockOwner = { pid: process.pid, token: crypto.randomUUID() };
  const encoded = `${JSON.stringify(owner)}\n`;
  const deadline = Date.now() + (options.deadlineMs ?? 10_000);
  while (true) {
    if (await publish(path, encoded, owner.token)) break;
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    const current = parseLockOwner(source, path);
    const expired = Date.now() >= deadline;
    // An unreadable lock (no legible owner) is NEVER reclaimed. It is one of two things and no amount of waiting can tell them apart: the corpse of a process that died before writing its record, or a live one still writing it. A clock cannot discriminate them — a paused writer and a corpse look identical for any grace you pick — and stealing a lock a live writer is about to hold puts two processes in one critical section, which is the one outcome a lock may never produce. So we wait, and if it never clears we time out: a lock unowned until a user clears it is a liveness failure, strictly safer than a mutual-exclusion failure. This protocol's own `publish` never creates an unreadable lock (the name and its contents appear together), so treat this as an invalid persisted state.
    if (current !== null) {
      const liveness = probe(current.pid);
      if (liveness === "dead") {
        await reclaim(path, source, owner.token);
        continue;
      }
      if (expired && liveness === "other-uid") {
        // EPERM proves only that SOME process holds this pid, owned by another uid: a live foreign holder, or a stale lock whose pid was reused. Reading it as alive forever made that second lock unbreakable — every local operation timed out until a user deleted the file. A lock that survives the whole wait window unchanged is treated as the stale case and broken, exactly like a dead owner's.
        await reclaim(path, source, owner.token);
        continue;
      }
    }
    // Checked on every path through the loop, not just the one that sleeps: a contender that keeps losing races would otherwise spin past its deadline.
    if (expired) {
      throw new Error(`Timed out waiting for lock ${path}`);
    }
    await Bun.sleep(20);
  }

  const outcome = await operation().then(
    (value) => ({ ok: true as const, value }),
    (error: JsonValue) => ({ ok: false as const, error }),
  );
  const current = await readFile(path, "utf8").catch(() => "");
  if (current === encoded) {
    await unlink(path).catch(() => undefined);
    if ((await readFile(path, "utf8").catch(() => null)) === encoded) {
      throw new Error(`Failed to release lock ${path}`);
    }
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
