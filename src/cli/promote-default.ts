import { join, resolve } from "node:path";

import { HiveDatabase } from "../daemon/database/hive-database";
import { getHiveHome } from "../hive-home/home";
import { hiveInstanceSuffix } from "../hive-home/instance-identity";
import { defaultHiveHome } from "../hive-home/home";
import { daemonInstanceLiveness } from "../daemon/lifecycle/daemon-lifecycle";
import {
  RoutingPolicyStore,
  readRoutingPolicyDatabase,
} from "../daemon/routing-policy-store";
import type { RoutingPolicy } from "../schemas/routing-policy";

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

export async function promoteDefaultModelControl(
  options: PromoteDefaultModelControlOptions = {},
): Promise<PromoteDefaultModelControlResult> {
  const currentHome = resolve(options.currentHome ?? getHiveHome());
  const targetHome = resolve(options.defaultHome ?? defaultHiveHome());
  if (currentHome === targetHome) {
    throw new Error(
      "Refusing to promote Model Control: this Hive home is already the machine default; nothing to promote.",
    );
  }
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
  // Mirror RoutingPolicyStore.promote's source-quality guard before opening either target store, so a refused promotion cannot change either target.
  if (source.revision === 0) {
    throw new Error(
      "Refusing to promote Model Control: the source has no user-authored policy yet (revision 0).",
    );
  }
  if (source.provisional) {
    throw new Error(
      "Refusing to promote Model Control: the source still has Hive's provisional baseline; edit Model Control before promoting.",
    );
  }

  const targetDb = new HiveDatabase(join(targetHome, "hive.db"));
  try {
    const target = new RoutingPolicyStore(targetDb);
    const targetRevision = target.read(now).revision;
    const next = target.promote(source, targetRevision, PROMOTE_ACTOR, now);
    return { sourceRevision: source.revision, targetRevision: next.revision };
  } finally {
    targetDb.close();
  }
}
