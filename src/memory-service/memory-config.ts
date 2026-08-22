import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withHiveConfigLock } from "../config/document-lock";
import { hiveConfigPath } from "../config/load";
import { HiveConfigSchema } from "../schemas/config-schema";
import {
  type MemoryConfigCasResult,
  MemoryConfigCasResultSchema,
  type MemoryConfigPatch,
  type MemoryConfigProjection,
  MemoryConfigProjectionSchema,
} from "../schemas/memory-projections";
import { definedFields } from "../shared/defined-fields";
import { revisionOf } from "./projections";

async function readDocument(path: string): Promise<string> {
  return await readFile(path, "utf8").catch(() => "");
}

function projectionOf(document: string): MemoryConfigProjection {
  const config = HiveConfigSchema.parse(Bun.TOML.parse(document));
  return MemoryConfigProjectionSchema.parse({
    revision: revisionOf(document),
    eventsHotDays: config.memory.retention.events_hot_days,
    staleAfterDays: config.memory.retention.stale_after_days,
    sweepIntervalHours: config.memory.retention.sweep_interval_hours,
    wakeBudgetTokens: config.memory.wake_budget_tokens,
    embeddingProvider: config.memory.embedding_provider,
    embeddingModel: config.memory.embedding_model,
  });
}

export async function readMemoryConfig(
  path: string = hiveConfigPath(),
): Promise<MemoryConfigProjection> {
  return projectionOf(await readDocument(path));
}

function withoutMemoryTables(document: string): string {
  const kept: string[] = [];
  let inMemoryTable = false;
  for (const line of document.split("\n")) {
    if (/^\s*\[/.test(line)) {
      inMemoryTable = /^\s*\[memory(\.|])/.test(line);
    }
    if (!inMemoryTable) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}$/, "\n");
}

function renderMemoryTables(config: MemoryConfigProjection): string {
  return [
    "[memory]",
    `wake_budget_tokens = ${config.wakeBudgetTokens}`,
    `embedding_provider = "${config.embeddingProvider}"`,
    `embedding_model = "${config.embeddingModel}"`,
    "",
    "[memory.retention]",
    `events_hot_days = ${config.eventsHotDays}`,
    `stale_after_days = ${config.staleAfterDays}`,
    `sweep_interval_hours = ${config.sweepIntervalHours}`,
    "",
  ].join("\n");
}

/** Replace the file in one step. A reader must never observe a half-written config: `writeFile` truncates first, so a concurrent `readMemoryConfig` during a plain write can read an empty or partial document and compute a revision for a state that never existed. */
async function writeAtomically(path: string, content: string): Promise<void> {
  const staged = `${path}.hive-${process.pid}-${crypto.randomUUID()}.tmp`;
  await writeFile(staged, content);
  await rename(staged, path);
}

/** Apply a patch to the `[memory]` tables if the document still reads as the revision the caller last saw. Read, fence, write and read-back all happen INSIDE one lock. Splitting them does not merely narrow a race, it produces a lost update that reports success: two callers read the same revision, both fences pass, both write, and the second silently discards the first's edit while telling it "applied". A concurrent probe of five writers loses edits and hands back revisions that match no state the file was ever in. */
export async function casWriteMemoryConfig(
  request: { expectedRevision: string; patch: MemoryConfigPatch },
  path: string = hiveConfigPath(),
): Promise<MemoryConfigCasResult> {
  await mkdir(dirname(path), { recursive: true });
  return await withHiveConfigLock(path, async () => {
    // Read inside the lock. A document read before acquiring it is a revision that may already be stale by the time the fence consults it.
    const document = await readDocument(path);
    const current = projectionOf(document);
    if (current.revision !== request.expectedRevision) {
      return MemoryConfigCasResultSchema.parse({
        state: "conflict",
        currentRevision: current.revision,
        detail:
          `the configuration changed since revision ${request.expectedRevision}` +
          " — re-read it and reapply the edit",
      });
    }

    const next: MemoryConfigProjection = {
      ...current,
      ...definedFields({
        eventsHotDays: request.patch.eventsHotDays,
        staleAfterDays: request.patch.staleAfterDays,
        sweepIntervalHours: request.patch.sweepIntervalHours,
        wakeBudgetTokens: request.patch.wakeBudgetTokens,
      }),
    };
    const rewritten =
      `${withoutMemoryTables(document).trimEnd()}\n\n${renderMemoryTables(next)}`.trimStart();
    await writeAtomically(path, rewritten);

    // Final readback from DISK, not from the string we meant to write. The revision handed back has to be one a later fence will actually compute from the file; returning a revision of the intended content names a state no reader can ever reproduce.
    const persisted = await readDocument(path);
    try {
      return MemoryConfigCasResultSchema.parse({
        state: "applied",
        config: projectionOf(persisted),
      });
    } catch (error) {
      await writeAtomically(path, document);
      return MemoryConfigCasResultSchema.parse({
        state: "rejected",
        detail: `the edited configuration did not load and was reverted: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      });
    }
  });
}
