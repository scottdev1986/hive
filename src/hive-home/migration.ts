// Carrying what a home owns to the home that replaced it. A variant's home has moved before and
// may move again; when it does, the state the old home held — the databases, the standing
// selections, the artifact store — is in the directory that was left and the code is looking in
// the new one. Opening the new database path with `create: true` at that moment mints an empty
// database beside surviving data and calls it a fresh install, which is how a live board gets
// replaced by nothing. An artifact store left behind fails quieter: the board arrives with its
// citations intact and every id they name resolves to nothing. This is the decision that runs
// before that open, and it has exactly three answers: carry the old home's state across, refuse
// to start because more than one home holds a database, or do nothing because there is nothing
// to carry.
//
// What is carried is not this module's list. HOME_OWNED_STATE on the variant record names every
// piece of state a home owns, and a prior home is worth looking at when it holds any of it —
// testing only for a database is how a home holding nothing but artifacts was once skipped
// entirely. The database atoms are the exception inside the set: they move under the staging and
// verification below, and two homes holding databases is a conflict, reported rather than acted
// on. Everything else is copied, never moved and never overwriting, so a carry cannot destroy
// what it was meant to preserve; artifact bytes in particular are evidence, and evidence is not
// deleted to complete a move.
//
// The database is one atom: the `.db` file, its `-wal` and `-shm` sidecars, and the identity marker
// that says which database this install established. They move together or not at all. A `-wal`
// holds committed transactions the main file has not absorbed yet and is routinely larger than the
// recent history inside the `.db`, so a move that takes the `.db` alone loses writes while looking
// like it worked. Re-keying the marker is the step a hand copy forgets, and forgetting it is worse
// than losing it: the marker is re-established from whatever arrived, so the guard that would have
// caught a swapped database is disarmed without a word.
//
// The mechanism sunsets itself. `priorHomes` is a finite list on the variant record, empty for any
// install with nothing left behind; the loop below then does nothing, and deleting the list retires
// this module.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  DATABASE_ATOM_SUFFIXES,
  HIVE_DATABASE_NAME,
  HOME_DATABASES,
  HOME_OWNED_STATE,
  type VariantConfig,
} from "./variant";

/** Where a home kept its identity marker before markers moved outside the home. A prior home is by definition a home from before that move, so this is the only spelling one can have. */
const PRIOR_MARKER_NAME = `${HIVE_DATABASE_NAME}.identity`;

/** The atom members get the staging treatment below; everything else in HOME_OWNED_STATE is a plain copy-if-absent. */
const ATOM_MEMBERS: ReadonlySet<string> = new Set(
  HOME_DATABASES.flatMap((name) =>
    DATABASE_ATOM_SUFFIXES.map((suffix) => `${name}${suffix}`),
  ),
);

/** Copies land under this name and are renamed into place only once every one of them has been verified, so a move that dies half way leaves the new home with no database rather than with part of one. */
const STAGING_SUFFIX = ".migrating";

/**
 * What the decision left behind. Either the home is settled and its database can be opened, or more
 * than one database exists — in the new home and in a home it moved off, or in two homes it moved
 * off — and only the owner can say which one is theirs. Merging them is not possible and choosing
 * between them destroys one, so the caller refuses to start and names every path it found.
 */
export type HomeMigration =
  | { readonly kind: "settled"; readonly migratedFrom?: string }
  | { readonly kind: "conflict"; readonly databases: readonly string[] };

export const HOME_MIGRATION_ANNOUNCEMENT = "home-migration.json";

/** Moves everything a prior home holds of this install's owned state into this install's home. Does nothing when no prior home holds any of it, and reports a conflict rather than acting when more than one home holds a database. */
export function migratePriorHomeState(config: VariantConfig): HomeMigration {
  const carrying = config.priorHomes.filter(homeHoldsOwnedState);
  const [carry] = carrying;
  if (carry === undefined) return { kind: "settled" };
  const holders = [config.home, ...carrying].filter(holdsDatabase);
  if (holders.length > 1) {
    return { kind: "conflict", databases: holders.map(databasePath) };
  }
  for (const prior of carrying) {
    for (const databaseName of HOME_DATABASES) {
      carryDatabaseAtom(prior, config, databaseName);
    }
    carryOwnedState(prior, config.home);
  }
  // The announcement names the newest predecessor. Any earlier one can hold no database — two
  // would be the conflict above — and its non-atom state was copied only where the newer carry
  // left the name absent.
  writeFileSync(
    join(config.home, HOME_MIGRATION_ANNOUNCEMENT),
    `${JSON.stringify({ from: carry, to: config.home })}\n`,
  );
  return { kind: "settled", migratedFrom: carry };
}

function databasePath(home: string): string {
  return join(home, HIVE_DATABASE_NAME);
}

function holdsDatabase(home: string): boolean {
  return existsSync(databasePath(home));
}

/** A prior home is worth carrying from when it holds anything this install owns — a database, a selection, or the artifact store. Exported because the installer's pre-activation guard has to find exactly the homes the migration will touch; a second copy of this test is how a home holding nothing but artifacts was once skipped. */
export function homeHoldsOwnedState(home: string): boolean {
  if (!existsSync(home)) return false;
  return HOME_OWNED_STATE.some(
    (entry) =>
      [...new Bun.Glob(entry).scanSync({ cwd: home, onlyFiles: false })]
        .length > 0,
  );
}

function carryDatabaseAtom(
  priorHome: string,
  config: VariantConfig,
  databaseName: string,
): void {
  if (!existsSync(join(priorHome, databaseName))) return;
  mkdirSync(config.home, { recursive: true });
  const members: { source: string; staged: string; target: string }[] = [];
  try {
    for (const suffix of DATABASE_ATOM_SUFFIXES) {
      const source = join(priorHome, `${databaseName}${suffix}`);
      if (!existsSync(source)) continue;
      const target = join(config.home, `${databaseName}${suffix}`);
      const staged = `${target}${STAGING_SUFFIX}`;
      members.push({ source, staged, target });
      copyFileSync(source, staged);
      verifyCopy(source, staged);
    }
    for (const member of members) renameSync(member.staged, member.target);
  } finally {
    for (const member of members) rmSync(member.staged, { force: true });
  }
  if (databaseName === HIVE_DATABASE_NAME)
    carryIdentityMarker(priorHome, config);
  for (const member of members) rmSync(member.source, { force: true });
}

/** Carries the owned state that is not a database atom: the standing selections and the artifact store. All of it is copied, never moved, and a name already present in the new home is left alone — it belongs to state established there. */
function carryOwnedState(priorHome: string, newHome: string): void {
  for (const entry of HOME_OWNED_STATE) {
    if (ATOM_MEMBERS.has(entry)) continue;
    if (entry === "artifacts") {
      carryArtifactStore(priorHome, newHome);
      continue;
    }
    if (entry.includes("*")) {
      for (const name of new Bun.Glob(entry).scanSync({
        cwd: priorHome,
        onlyFiles: true,
      })) {
        carryPath(join(priorHome, name), join(newHome, name));
      }
      continue;
    }
    carryPath(join(priorHome, entry), join(newHome, entry));
  }
}

/** The store crosses one project at a time, so a project the new home already holds is left alone in both places — two homes holding one project's store is a fact for the owner to read, not something a carry resolves by overwriting or deleting evidence — while every other project's store still arrives. */
function carryArtifactStore(priorHome: string, newHome: string): void {
  const priorStore = join(priorHome, "artifacts");
  if (!existsSync(priorStore)) return;
  for (const project of readdirSync(priorStore)) {
    carryPath(join(priorStore, project), join(newHome, "artifacts", project));
  }
}

function carryPath(source: string, target: string): void {
  if (!existsSync(source) || existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, preserveTimestamps: true });
}

/** A matching SHA-256 is already a matching byte length, so this is the whole check: every member is proven at its new path before any source is unlinked. */
function verifyCopy(source: string, copy: string): void {
  if (fileDigest(copy) !== fileDigest(source)) {
    throw new Error(
      `Hive copied ${source} to ${copy} while moving its database, but the copy does not match. ` +
        "Refusing to remove the original.",
    );
  }
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Writes the prior home's identity under the name this install reads it by.
 *
 * A marker already at the destination is left alone rather than overwritten. It belongs to some
 * other database that was established at this home, and silently replacing it would disarm the
 * check it exists for; leaving it means the identity verification that runs next compares the
 * arriving database against it and refuses if they disagree.
 */
function carryIdentityMarker(priorHome: string, config: VariantConfig): void {
  const priorMarker = join(priorHome, PRIOR_MARKER_NAME);
  if (!existsSync(priorMarker)) return;
  if (!existsSync(config.databaseIdentityPath)) {
    mkdirSync(dirname(config.databaseIdentityPath), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      config.databaseIdentityPath,
      readFileSync(priorMarker, "utf8").trim().concat("\n"),
      { mode: 0o600 },
    );
  }
  rmSync(priorMarker, { force: true });
}
