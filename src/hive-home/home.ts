// Where Hive lives on this filesystem, and the well-known paths inside it. This is a machine fact, not a data shape, and every layer needs it: the daemon to open its database, adapters to name a credential file, usage to key a ledger by instance. It therefore sits in a directory the layer map does not own, imports nothing of Hive's, and is safe for anyone to read. THERE ARE TWO KNOBS HERE AND THEY ARE NOT THE SAME KNOB. They sit together so that is visible: HIVE_HOME the home in effect for this process. Test rigs, QA rigs and named instances point it at a throwaway dir. HIVE_DEFAULT_HOME the user-level home, ignoring any redirect above. isDefaultHiveHome compares the two, which is the whole reason both exist. Collapsing them into one lookup would silently make every isolated runtime look like the user's own install.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function getHiveHome(): string {
  return process.env.HIVE_HOME ?? join(homedir(), ".hive");
}

export function defaultHiveHome(): string {
  const explicitHome = process.env.HIVE_DEFAULT_HOME;
  if (explicitHome === undefined) return join(homedir(), ".hive");
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

export function getDatabasePath(): string {
  return join(getHiveHome(), "hive.db");
}

export function credentialDirectory(): string {
  return join(getHiveHome(), "credentials");
}

export function credentialPath(subject: string): string {
  return join(credentialDirectory(), `${subject}.cap`);
}
