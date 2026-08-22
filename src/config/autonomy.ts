import { rename } from "node:fs/promises";
import type { HiveConfig } from "../schemas/config-schema";
import { withHiveConfigLock } from "./document-lock";
import { hiveConfigPath } from "./load";
import { errorMessage } from "../shared/error-message";
import type { JsonObject } from "../shared/json";

export type Autonomy = HiveConfig["autonomy"];

export const AUTONOMY_VALUES: readonly Autonomy[] = ["sandboxed", "dangerous"];

export function isAutonomy<T>(value: T): value is T & Autonomy {
  // SAFETY: The surrounding code already established this contract.
  return AUTONOMY_VALUES.includes(value as Autonomy);
}

/** The daemon's live autonomy state: `get` is what the next spawn or resume will actually use, `set` persists first and only then changes the live value, so disk and memory can never silently diverge. */
export interface AutonomyControl {
  get(): Autonomy;
  set(value: Autonomy): Promise<void>;
}

/** Replace the top-level `autonomy` key in TOML text, or insert one. Only lines before the first table header are candidates — an `autonomy` inside `[some.table]` is a different key. Inserting at the very top keeps the new key top-level whatever follows. Throws (writing nothing) unless the result provably parses back to the requested value. */
export function upsertAutonomy(text: string, value: Autonomy): string {
  const assignment = `autonomy = "${value}"`;
  const lines = text.split("\n");
  let replaced = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
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
  let parsed: JsonObject;
  try {
    // SAFETY: The surrounding code already established this contract.
    parsed = Bun.TOML.parse(result) as JsonObject;
  } catch (error) {
    throw new Error(
      `refusing to write config: the result does not parse as TOML (${errorMessage(
        error,
      )})`,
    );
  }
  if (parsed.autonomy !== value) {
    throw new Error(
      `refusing to write config: the result parses autonomy as ${JSON.stringify(
        parsed.autonomy,
      )}, not "${value}"`,
    );
  }
  return result;
}

let pendingPersistence: Promise<void> = Promise.resolve();

export function persistAutonomy(
  value: Autonomy,
  path = hiveConfigPath(),
): Promise<void> {
  // Concurrent HTTP requests must commit in call order; sharing the process's staging name without this queue can rename another request's contents. The queue orders autonomy writes against each other; the document lock excludes the OTHER features that rewrite this same file, whose edits this read-modify-write would otherwise render over and erase.
  const write = pendingPersistence.then(() =>
    withHiveConfigLock(path, async () => {
      const file = Bun.file(path);
      const text = (await file.exists()) ? await file.text() : "";
      const next = upsertAutonomy(text, value);
      const temp = `${path}.tmp-${process.pid}`;
      await Bun.write(temp, next);
      await rename(temp, path);
    }),
  );
  pendingPersistence = write.catch(() => undefined);
  return write;
}
