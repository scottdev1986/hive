// Where Hive lives on this filesystem, and the well-known paths inside it. This is a machine fact, not a data shape, and every layer needs it: the daemon to open its database, adapters to name a credential file, usage to key a ledger by instance. It therefore sits in a directory the layer map does not own, imports nothing of Hive's, and is safe for anyone to read. THERE ARE TWO KNOBS HERE AND THEY ARE NOT THE SAME KNOB. They sit together so that is visible: HIVE_HOME the home in effect for this process. Test rigs, QA rigs and named instances point it at a throwaway dir. HIVE_DEFAULT_HOME the user-level home, ignoring any redirect above. isDefaultHiveHome compares the two, which is the whole reason both exist. Collapsing them into one lookup would silently make every isolated runtime look like the user's own install.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const INSTANCE_HASH_LENGTH = 10;

/** The user's own Hive home on this machine, ignoring HIVE_HOME and HIVE_DEFAULT_HOME. Isolated runtimes pin those two knobs at a throwaway dir; this path is what they isolate from. */
export function userHiveHome(): string {
  return join(homedir(), ".hive");
}

export function getHiveHome(): string {
  return process.env.HIVE_HOME ?? userHiveHome();
}

export function defaultHiveHome(): string {
  const explicitHome = process.env.HIVE_DEFAULT_HOME;
  if (explicitHome === undefined) return userHiveHome();
  if (explicitHome.length === 0 || !isAbsolute(explicitHome)) {
    throw new Error("HIVE_DEFAULT_HOME must be a non-empty absolute path");
  }
  return explicitHome;
}

export function instancesRoot(): string {
  return join(defaultHiveHome(), "instances");
}

/** The canonical spelling of a home. Two installs are the same install when their homes resolve here to the same path, so this is the form every name derived from a home is derived from. */
export function resolveHiveHome(hiveHome = getHiveHome()): string {
  return resolve(hiveHome);
}

/** The machine-level home behind a possibly-named instance. A named instance lives under the default home's `instances` directory, and machine-wide state belongs to the install rather than to that instance, so a home pointing inside `instances` resolves back to the default home. */
export function machineHiveHome(hiveHome = getHiveHome()): string {
  const resolved = resolveHiveHome(hiveHome);
  const namedRoot = `${resolve(instancesRoot())}/`;
  return resolved.startsWith(namedRoot) ? resolve(defaultHiveHome()) : resolved;
}

/** A stable, short name for one canonical Hive home. Every cross-process rendezvous uses this value so independently started components agree without coordination. */
export function hiveInstanceSuffix(hiveHome = getHiveHome()): string {
  return createHash("sha256")
    .update(resolveHiveHome(hiveHome))
    .digest("hex")
    .slice(0, INSTANCE_HASH_LENGTH);
}

/** Whether the home in effect is the user-level one rather than a redirect. */
export function isDefaultHiveHome(hiveHome = getHiveHome()): boolean {
  return resolveHiveHome(hiveHome) === resolveHiveHome(defaultHiveHome());
}

export function orchestratorSessionKey(hiveHome = getHiveHome()): string {
  return `hive-orchestrator-${hiveInstanceSuffix(hiveHome)}`;
}

/** The short root for AF_UNIX sockets. Durable session state lives separately because only socket addresses have macOS's `sun_path` limit. */
export function sessiondRuntimeRoot(hiveHome = getHiveHome()): string {
  return (
    process.env.HIVE_SESSIOND_ROOT ??
    join(machineHiveHome(hiveHome), "run", hiveInstanceSuffix(hiveHome))
  );
}

/** Session records, journals, and checkpoints live under the instance home so they survive their sockets and are swept with that instance. */
export function sessiondStateRoot(hiveHome = getHiveHome()): string {
  return join(resolveHiveHome(hiveHome), "sessiond-state");
}

/** The marker that binds an instance to its database is keyed outside named-instance homes so it can still detect a missing home. */
export function databaseIdentityPath(hiveHome = getHiveHome()): string {
  return join(
    machineHiveHome(hiveHome),
    "db-identity",
    hiveInstanceSuffix(hiveHome),
  );
}

export function getDatabasePath(): string {
  return join(getHiveHome(), "hive.db");
}

export function credentialDirectory(): string {
  return join(getHiveHome(), "credentials");
}

export function credentialPath(subject: string): string {
  return join(credentialDirectory(), `${subject}.cap`);
}
