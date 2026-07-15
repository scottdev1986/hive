import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { HiveDatabase, getHiveHome } from "./db";
import { defaultHiveHome, ORDINARY_WORKSPACE_RUNTIME } from "./instances";
import {
  readRoutingPolicyDatabase,
  RoutingPolicyStore,
} from "./routing-policy-store";
import { SelectionPreferenceStore } from "./selection-preferences";

export interface InstanceSettingsInheritanceOptions {
  readonly currentHome?: string;
  readonly sourceHome?: string;
  readonly now?: Date;
  readonly warn?: (message: string) => void;
}

export interface OrdinarySelectionInheritanceOptions {
  readonly ordinaryWorkspace?: boolean;
  readonly preferences?: Pick<SelectionPreferenceStore, "read">;
  readonly now?: Date;
  readonly warn?: (message: string) => void;
}

/**
 * Copy user-authored Model Control preferences into a named instance only
 * while its policy is empty or still Hive's untouched provisional baseline.
 * This reads the default daemon's live WAL through SQLite, never by copying a
 * database file, and never makes the two instances share a writer.
 */
export function inheritDefaultModelControlSettings(
  target: RoutingPolicyStore,
  options: InstanceSettingsInheritanceOptions = {},
): boolean {
  const currentHome = resolve(options.currentHome ?? getHiveHome());
  const sourceHome = resolve(options.sourceHome ?? defaultHiveHome());
  if (currentHome === sourceHome) return false;
  const path = join(sourceHome, "hive.db");
  if (!existsSync(path)) return false;

  let source: HiveDatabase | null = null;
  try {
    source = HiveDatabase.openReadonly(path);
    const policy = readRoutingPolicyDatabase(source, options.now);
    return target.importDefaultPolicy(policy, options.now).imported;
  } catch (error) {
    (options.warn ?? console.error)(
      `Could not inherit Model Control settings from the default Hive instance: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  } finally {
    source?.close();
  }
}

/**
 * Fresh ordinary Workspaces overlay the machine selection after their normal
 * default-policy copy and provisional seed. Named/default homes never call
 * this path, so their later edits remain local.
 */
export function inheritOrdinaryWorkspaceSelection(
  target: RoutingPolicyStore,
  options: OrdinarySelectionInheritanceOptions = {},
): boolean {
  const ordinary = options.ordinaryWorkspace ??
    process.env[ORDINARY_WORKSPACE_RUNTIME] === "1";
  if (!ordinary) return false;
  try {
    const selection = (options.preferences ?? new SelectionPreferenceStore()).read();
    if (selection === null) return false;
    return target.importSelectionPreference(selection, options.now).imported;
  } catch (error) {
    (options.warn ?? console.error)(
      `Could not inherit the ordinary Workspace model selection: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
