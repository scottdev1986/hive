import { join, resolve } from "node:path";

import { HiveDatabase, getHiveHome } from "../daemon/db";
import { defaultHiveHome } from "../daemon/instances";
import { daemonInstanceLiveness } from "../daemon/lifecycle";
import {
  readRoutingPolicyDatabase,
  RoutingPolicyStore,
} from "../daemon/routing-policy-store";
import { SelectionPreferenceStore } from "../daemon/selection-preferences";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";
import type { RoutingPolicy } from "../schemas";

const PROMOTE_ACTOR = "hive-cli-promote-default";

export interface PromoteDefaultModelControlOptions {
  readonly currentHome?: string;
  readonly defaultHome?: string;
  readonly now?: Date;
}

export interface PromoteDefaultModelControlResult {
  readonly sourceRevision: number;
  readonly targetRevision: number;
}

/**
 * Promote this instance's explicit Model Control document to the machine
 * default. A live (or unprovably dead) default daemon owns its database, so
 * this command writes only after its lock has been proved dead.
 */
export async function promoteDefaultModelControl(
  options: PromoteDefaultModelControlOptions = {},
): Promise<PromoteDefaultModelControlResult> {
  const currentHome = resolve(options.currentHome ?? getHiveHome());
  const targetHome = resolve(options.defaultHome ?? defaultHiveHome());
  const liveness = await daemonInstanceLiveness(
    targetHome,
    hiveInstanceSuffix(targetHome),
  );
  if (liveness === "live") {
    throw new Error(
      "Refusing to promote Model Control while the default Hive daemon is live; " +
        "stop it before changing ~/.hive/hive.db.",
    );
  }
  if (liveness === "unknown") {
    throw new Error(
      "Refusing to promote Model Control because default daemon lock ownership " +
        "cannot be proved dead; inspect ~/.hive/daemon.lock first.",
    );
  }

  const now = options.now ?? new Date();
  const sourceDb = HiveDatabase.openReadonly(join(currentHome, "hive.db"));
  let source: RoutingPolicy;
  try {
    source = readRoutingPolicyDatabase(sourceDb, now);
  } finally {
    sourceDb.close();
  }

  const targetDb = new HiveDatabase(join(targetHome, "hive.db"));
  try {
    const target = new RoutingPolicyStore(targetDb);
    const preferences = new SelectionPreferenceStore(
      join(targetHome, "routing-selection.json"),
    );
    // Preserve a malformed existing preference rather than overwriting it as
    // an incidental side effect of the database promotion.
    preferences.read();
    const next = target.promote(
      source,
      target.read(now).revision,
      PROMOTE_ACTOR,
      now,
    );
    await preferences.replace(source.selection);
    return { sourceRevision: source.revision, targetRevision: next.revision };
  } finally {
    targetDb.close();
  }
}
