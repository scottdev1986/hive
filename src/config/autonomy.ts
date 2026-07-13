/**
 * Runtime autonomy control: the one writer `~/.hive/config.toml` has.
 *
 * The user flips writer autonomy from the Workspace's Agents menu (which runs
 * `hive autonomy <mode>`), so the change has to outlive the daemon that
 * received it. The persistence is a surgical text edit, not a re-serialize:
 * the file is the user's, and comments or keys this build does not know must
 * survive the write. The edit is proven before it is written — the new text
 * must parse back to the requested value, or nothing touches disk.
 */
import { homedir } from "node:os";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { HiveConfig } from "../schemas";

export type Autonomy = HiveConfig["autonomy"];

export const AUTONOMY_VALUES: readonly Autonomy[] = ["sandboxed", "dangerous"];

export function isAutonomy(value: unknown): value is Autonomy {
  return AUTONOMY_VALUES.includes(value as Autonomy);
}

/** The daemon's live autonomy state: `get` is what the next spawn or resume
 * will actually use, `set` persists first and only then changes the live
 * value, so disk and memory can never silently diverge. */
export interface AutonomyControl {
  get(): Autonomy;
  set(value: Autonomy): Promise<void>;
}

/** Replace the top-level `autonomy` key in TOML text, or insert one. Only
 * lines before the first table header are candidates — an `autonomy` inside
 * `[some.table]` is a different key. Inserting at the very top keeps the new
 * key top-level whatever follows. Throws (writing nothing) unless the result
 * provably parses back to the requested value. */
export function upsertAutonomy(text: string, value: Autonomy): string {
  const assignment = `autonomy = "${value}"`;
  const lines = text.split("\n");
  let replaced = false;
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith("[")) break;
    if (/^autonomy\s*=/.test(trimmed)) {
      lines[index] = assignment;
      replaced = true;
      break;
    }
  }
  const result = replaced
    ? lines.join("\n")
    : text === ""
      ? `${assignment}\n`
      : `${assignment}\n${text}`;
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(result) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `refusing to write config: the result does not parse as TOML (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (parsed.autonomy !== value) {
    throw new Error(
      `refusing to write config: the result parses autonomy as ${
        JSON.stringify(parsed.autonomy)
      }, not "${value}"`,
    );
  }
  return result;
}

export function defaultConfigPath(): string {
  return join(Bun.env.HIVE_HOME ?? join(homedir(), ".hive"), "config.toml");
}

let pendingPersistence: Promise<void> = Promise.resolve();

/** Write the autonomy key into the user's config file, atomically: the new
 * text lands under a temp name and a rename makes it the file, so no reader
 * ever sees a half-written config. */
export function persistAutonomy(
  value: Autonomy,
  path = defaultConfigPath(),
): Promise<void> {
  // Concurrent HTTP requests must commit in call order; sharing the process's
  // staging name without this queue can rename another request's contents.
  const write = pendingPersistence.then(async () => {
    const file = Bun.file(path);
    const text = (await file.exists()) ? await file.text() : "";
    const next = upsertAutonomy(text, value);
    const temp = `${path}.tmp-${process.pid}`;
    await Bun.write(temp, next);
    await rename(temp, path);
  });
  pendingPersistence = write.catch(() => undefined);
  return write;
}
