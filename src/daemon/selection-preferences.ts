import { readFileSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { withFileLock } from "../adapters/file-lock";
import {
  SelectionPolicySchema,
  type RoutingPolicyMutation,
  type SelectionPolicy,
} from "../schemas";
import { machineHiveHome } from "./instances";

type SelectionMutation = Extract<RoutingPolicyMutation, { op: "set-selection" }>;

const StoredSelectionPreferenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  selection: SelectionPolicySchema,
});

export interface SelectionPreferenceControl {
  apply(
    mutation: SelectionMutation,
    fallback: SelectionPolicy,
  ): Promise<SelectionPolicy>;
}

export function selectionPreferencePath(): string {
  return join(machineHiveHome(), "routing-selection.json");
}

async function readSelectionPreferenceAsync(
  path: string,
): Promise<SelectionPolicy | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return StoredSelectionPreferenceSchema.parse(JSON.parse(source)).selection;
}

async function writeSelectionPreference(
  path: string,
  selection: SelectionPolicy,
): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await Bun.write(
    temp,
    `${JSON.stringify({ schemaVersion: 1, selection }, null, 2)}\n`,
  );
  await rename(temp, path);
}

function applySelectionMutation(
  selection: SelectionPolicy,
  mutation: SelectionMutation,
): SelectionPolicy {
  if (mutation.category === undefined) {
    return SelectionPolicySchema.parse({
      ...selection,
      global: mutation.mode,
    });
  }
  const categories = { ...selection.categories };
  if (mutation.mode === "unset") delete categories[mutation.category];
  else categories[mutation.category] = mutation.mode;
  return SelectionPolicySchema.parse({ ...selection, categories });
}

/** Machine preference used only by ordinary fresh Workspace runtimes. */
export class SelectionPreferenceStore implements SelectionPreferenceControl {
  constructor(readonly path = selectionPreferencePath()) {}

  read(): SelectionPolicy | null {
    try {
      const source = readFileSync(this.path, "utf8");
      return StoredSelectionPreferenceSchema.parse(JSON.parse(source)).selection;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async apply(
    mutation: SelectionMutation,
    fallback: SelectionPolicy,
  ): Promise<SelectionPolicy> {
    await mkdir(dirname(this.path), { recursive: true });
    return withFileLock(`${this.path}.lock`, async () => {
      const current = await readSelectionPreferenceAsync(this.path);
      const next = current === null
        ? SelectionPolicySchema.parse(fallback)
        : applySelectionMutation(current, mutation);
      await writeSelectionPreference(this.path, next);
      return next;
    });
  }

  /** Replace the machine preference as one locked, atomic document write. */
  async replace(selection: SelectionPolicy): Promise<SelectionPolicy> {
    const next = SelectionPolicySchema.parse(selection);
    await mkdir(dirname(this.path), { recursive: true });
    return withFileLock(`${this.path}.lock`, async () => {
      // Keep the same corrupt-file boundary as apply(): a bad existing
      // preference must be surfaced, not silently replaced.
      await readSelectionPreferenceAsync(this.path);
      await writeSelectionPreference(this.path, next);
      return next;
    });
  }
}
