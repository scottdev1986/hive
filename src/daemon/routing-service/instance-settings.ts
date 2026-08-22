import { join, resolve } from "node:path";

import { HiveDatabase } from "../database/hive-database";
import { defaultHiveHome } from "../../hive-home/home";

/** Model Control is MACHINE-WIDE state, and this is where that is decided. The policy document is the user's standing authorization to spend, exactly like the quota ledger — and like quota.db, it lives in the machine default home no matter which HIVE_HOME the process runs under. A per-run home is a cache that gets recreated; consent is not, and a user who configures routing once must not have to configure it again because a home was rebuilt. Instances therefore SHARE one policy rather than diverging from a copy. Isolation is still available and still explicit: a process that sets HIVE_DEFAULT_HOME (how test and QA rigs isolate) resolves to that home and can neither read nor write the real one. When this process already runs on the machine default, the daemon's own connection is the policy connection; `opened` says whether the caller owns a second connection it must close. */
export function machineModelControlDatabase(
  db: HiveDatabase,
  options: { readonly?: boolean } = {},
) {
  const machinePath = join(defaultHiveHome(), "hive.db");
  if (resolve(db.path) === resolve(machinePath)) {
    return { database: db, opened: false };
  }
  return {
    database:
      options.readonly === true
        ? HiveDatabase.openReadonly(machinePath)
        : new HiveDatabase(machinePath),
    opened: true,
  };
}
