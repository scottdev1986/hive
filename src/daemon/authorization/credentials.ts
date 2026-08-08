// Credential delivery. A token never travels in an environment variable and never in argv: env is inherited by every descendant of an agent process, and argv is world-readable through `ps`. It travels in a 0600 file inside a 0700 directory outside every worktree, read with O_CLOEXEC so the descriptor does not survive an exec. This does not stop a same-UID process that knows the path from reading the file — nothing at this layer can. What it does is guarantee that a process which merely *descends* from a credential holder inherits nothing usable.
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { credentialDirectory, credentialPath } from "../../hive-home/home";

// Bun does not re-export O_CLOEXEC through fs.constants, but the platform values are stable ABI. Falling back to 0 is safe rather than silently wrong: every credential read closes its descriptor before the process can exec.
const O_CLOEXEC =
  (constants as Record<string, number | undefined>).O_CLOEXEC ??
  (process.platform === "darwin"
    ? 0x1000000
    : process.platform === "linux"
      ? 0o2000000
      : 0);

export const USER_SUBJECT = "user";
/** Pre-rename subject for the same credential; still readable so an install that has not reminted keeps working. */
const LEGACY_USER_SUBJECT = "operator";

export function writeCredential(subject: string, token: string): string {
  const directory = credentialDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = credentialPath(subject);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return path;
}

/** Reads a credential with a close-on-exec descriptor that is closed before this process can spawn anything. Returns null when no credential exists. When the subject is the user role, also tries the legacy `operator.cap` filename. */
export function readCredential(subject: string): string | null {
  const token = readCredentialFile(subject);
  if (token !== null) return token;
  if (subject === USER_SUBJECT) return readCredentialFile(LEGACY_USER_SUBJECT);
  return null;
}

function readCredentialFile(subject: string): string | null {
  let fd: number;
  try {
    fd = openSync(credentialPath(subject), constants.O_RDONLY | O_CLOEXEC);
  } catch (error) {
    // Absence is the common, silent case; anything else (EPERM, EIO) is a real fault that would otherwise masquerade as "no credential" and demote a legitimate holder to unauthenticated with no trace.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `Hive could not open the credential file for ${subject}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    return null;
  }
  try {
    const buffer = Buffer.alloc(512);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, read).toString("utf8").trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    console.error(
      `Hive could not read the credential file for ${subject}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return null;
  } finally {
    closeSync(fd);
  }
}

export function removeCredential(subject: string): void {
  rmSync(credentialPath(subject), { force: true });
}
