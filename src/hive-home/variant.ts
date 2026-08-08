// Which install this process is, as one record. Two installs are the same install when their homes resolve to the same path, so every name below is a function of the resolved home and the compiled-in variant and nothing else. That is what lets a worktree, a daemon and a vendor adapter agree on an identity without consulting one another. The same ten hex characters used to be spelled out separately in the TypeScript that derives them and in the shell that deletes what they name, and the only thing holding the copies together was a test that noticed after they had already drifted. One record removes the copies rather than policing them.
//
// The variant is inlined at build time by `bun build --compile --define 'process.env.HIVE_BUILD_VARIANT="dev"' ...`, the same mechanism src/shared/version.ts uses for the version strings. A `--define` rewrites the member expression into a string literal before the bundle is written, so a compiled binary cannot be relabelled by exporting HIVE_BUILD_VARIANT at it. Unset means `prod`: prod's paths are the ones an unlabelled build has always resolved to, so a checkout and a pre-variant release keep landing exactly where they landed before this module existed.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { IS_RELEASE_BUILD } from "../shared/version";
import {
  defaultHiveHome,
  getHiveHome,
  machineHiveHome,
  resolveHiveHome,
} from "./home";

export type HiveVariant = "prod" | "dev" | "qa";

const VARIANTS: readonly HiveVariant[] = ["prod", "dev", "qa"];

const INSTANCE_HASH_LENGTH = 10;

/** The only dev-home entries that may point at the user's own home. They are symlinks, created by scripts/dev/dev-memory-setup.ts, so dev testing reuses live lessons instead of starting from an empty wiki. Runtime state (daemon.port, credentials, logs/, hive.db, quota.db, instances/, tools/) is deliberately absent and must stay absent — it has to stay isolated per home. artifacts/ is absent too and must stay absent: `artifactsRoot` already resolves through `machineHiveHome`, so an instance home reaches the install's real artifact store without a link, and a link would give one directory a second name that `artifactReadRoots` then scans twice. qa's list is empty on purpose — a QA result that inherited one developer's episodic store is not reproducible on another machine — and prod's is empty by construction, because prod *is* the user's home. Exported because the script that creates these links and the uninstaller that must not follow them have to agree on the same four names. */
export const DEV_SHARED_WITH_DEFAULT_HOME: readonly string[] = [
  "memory",
  "projects",
  "project-registry.json",
  "models",
];

/** The two databases a home holds: the board's and the quota ledger's. Each is one atom with its `-wal`/`-shm` sidecars, because a database kept or carried without its log comes back missing its most recent writes. Exported because the migration that carries the atoms and the retention lists that keep them have to agree on their names. */
export const HIVE_DATABASE_NAME = "hive.db";
export const QUOTA_DATABASE_NAME = "quota.db";
export const HOME_DATABASES: readonly string[] = [
  HIVE_DATABASE_NAME,
  QUOTA_DATABASE_NAME,
];
export const DATABASE_ATOM_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * What a home owns that is its owner's state rather than runtime scaffolding, as top-level entry
 * names; an entry containing `*` is a glob. This is the one enumeration, and it exists because the
 * alternative already failed once: the migration carried the database atom plus a hand-written
 * selections list, the uninstaller kept its own hand-written retention list, and the artifact
 * store was in neither — so a home move delivered the board and lost the evidence the board
 * cites. The migration carries exactly this set, and a variant's retention is a named subset of
 * it. Anything new a home grows joins this list before any caller learns of it; a caller keeping
 * its own copy is how the store was lost. Runtime paths (logs, sessiond state, instances, the
 * socket and tool trees) are deliberately absent: they are expendable per-home state that a move
 * must not carry and an uninstall must not keep. The user's own stores shared into a dev home as
 * links are absent too: their bytes were never this home's, and carrying one would copy the
 * user's store into an instance home.
 */
export const HOME_OWNED_STATE: readonly string[] = [
  ...HOME_DATABASES.flatMap((name) =>
    DATABASE_ATOM_SUFFIXES.map((suffix) => `${name}${suffix}`),
  ),
  "config.toml",
  "quota.toml",
  "credentials",
  "billing-*.json",
  "artifacts",
];

/** What survives `hive-dev uninstall`, as names relative to the home being cleared; an entry containing `*` is a glob. Only dev retains beyond the artifact store: it keeps the database atoms, the user's standing selections, and the four shared names above, which are symlinks whose bytes belong to the user's home either way. `credentials` is the one owned name filtered out — capability tokens are bound to sessions that die with the daemon, so they cost nothing to regenerate and leaving provider tokens on disk through an uninstall buys nothing. The identity marker belongs to the atom too, but it lives outside the home and is named by `databaseIdentityPath` instead. */
const DEV_RETENTION: readonly string[] = [
  ...HOME_OWNED_STATE.filter((name) => name !== "credentials"),
  ...DEV_SHARED_WITH_DEFAULT_HOME,
];

/** What every uninstall keeps regardless of variant: the artifact store. Artifacts are work products the board cites as permanent evidence, written to be readable with no Hive at all — an uninstall removes the install, not the evidence. A `--purge` overrides this like any other retention, and says so in the plan before consent. */
const EVIDENCE_RETENTION: readonly string[] = ["artifacts"];

export interface VariantConfig {
  readonly variant: HiveVariant;
  /** The home in effect, canonical. Every other name here that is keyed on an install is keyed on this. */
  readonly home: string;
  /** The user-level home, ignoring any redirect. Compare it against `home` to tell an isolated runtime from the user's own install. */
  readonly defaultHome: string;
  /** The home that owns machine-wide state. A named instance resolves back to the install behind it, so state that outlives one instance directory has somewhere to live. */
  readonly machineHome: string;
  /** The ten hex characters that name this install in every rendezvous: socket root, identity marker, worktree ownership ref, orchestrator session key. */
  readonly instanceSuffix: string;
  readonly installRoot: string;
  readonly binLink: string;
  /** The command this variant answers to. A variant is a link name and a set of roots, not a code surface: prod, dev and qa compile the same program. */
  readonly binName: string;
  /** Where sessiond binds its AF_UNIX sockets, and the only path in this record measured against macOS's 103-byte `sun_path`. It holds nothing but bound rendezvous nodes — every durable byte lives under `sessiondStateRoot` — so losing this tree at reboot is correct, and it stays short because a bind address has to fit where a filename does not. It sits under the machine home rather than the instance home so that one install keeps one socket tree no matter how many instances it has, and under the home at all rather than `/tmp` so that no Hive path of any kind lives on a volume the OS sweeps. `host-launcher` hands the resolved value to each host through HIVE_SESSIOND_ROOT so a host never re-derives it. */
  readonly socketRoot: string;
  /** Where sessiond keeps the state that must outlive the socket it was reached through — `record.json`, `journal.bin`, `checkpoint-*.bin`, `final.json`, `adopt.cap` under the host subtree, `control.cap` and `registry.lock` under the neutral one. These are files, so they belong in the home, where no `sun_path` limit reaches them and the uninstaller sweeps them like every other runtime path; only `socketRoot` is byte-constrained, because only a bind address has to fit in `sun_path`. Two roots because there are genuinely two lifetimes. Top-level rather than under `runtime/`, which is a shared root four unrelated callers already compose into by hand and which an owned root would inherit every future collision from. No instance suffix: the home is already per-instance, and a suffix under it would be one more site deriving the identity this record exists to hold. */
  readonly sessiondStateRoot: string;
  /** The marker proving which database this install established, kept outside the home it guards so it can still be read once that home is gone — which is the only state it exists to detect. */
  readonly databaseIdentityPath: string;
  readonly retention: readonly string[];
  readonly sharedWithDefaultHome: readonly string[];
  /** Homes this variant used to live in, newest spelling first. An explicit finite list, never a search: a search that guesses at old homes is a mechanism nobody can reason about. Empty when there is nothing left to migrate, and the migration retires itself when every entry is gone. */
  readonly priorHomes: readonly string[];
  /** Whether HIVE_EMBEDDINGS_SOURCE may point the embedding provisioner at an arbitrary local node_modules, from which it loads a native runtime. The one capability that is genuinely absent from prod rather than merely configured differently, because a capability that can be re-enabled by exporting a variable is not absent. Three cases, and the middle one is the reason this is not simply `variant !== "prod"`: a published prod binary refuses, which is the security intent; a dev or qa binary accepts even though it went through the same release pipeline, because being compiled says nothing about being production; and a source checkout accepts, because a tree you can already edit gains nothing from refusing. Keyed on the build being a release rather than on `hive.db` or a flag, so nothing at runtime can talk a shipped binary out of it. */
  readonly allowsLocalEmbeddingsSource: boolean;
}

/** Which variant a string names, absent meaning prod. The release build parses its `--variant` argument here and this module reads its own compiled-in value here, so the set of legal names and the meaning of an absent one are decided once. A name outside the set throws rather than falling back: a mistyped `--define` that quietly became prod would ship a dev binary believing it was production, and that belief decides whether it will load code from a local tree. */
export function parseVariant(value: string | undefined): HiveVariant {
  if (value === undefined || value.length === 0) return "prod";
  const known = VARIANTS.find((candidate) => candidate === value);
  if (known === undefined) {
    throw new Error(
      `Unknown Hive build variant "${value}": expected ${VARIANTS.join(", ")}`,
    );
  }
  return known;
}

/** The variant this binary was built as. `bun build --compile --define 'process.env.HIVE_BUILD_VARIANT="dev"'` rewrites the member expression below into a string literal before the bundle is written, so a compiled binary has no environment read left to intercept. A source checkout keeps the read, which is how a developer switches variants without a build. */
function buildVariant(): HiveVariant {
  return parseVariant(process.env.HIVE_BUILD_VARIANT);
}

/** The dev home moved from `/tmp/hv-<tag>` to `<instances>/dev-<tag>` keeping the same tag, so a dev instance can name its own predecessor without being told. `machineHome` differs from `home` exactly when the home sits under the instances root, which is what makes this a named dev instance rather than an arbitrary directory someone pointed HIVE_HOME at. */
function priorHomes(
  variant: HiveVariant,
  home: string,
  machineHome: string,
): readonly string[] {
  if (variant !== "dev" || machineHome === home) return [];
  const name = basename(home);
  if (!name.startsWith("dev-")) return [];
  return [`/tmp/hv-${name.slice("dev-".length)}`];
}

export function resolveVariant(
  hiveHome = getHiveHome(),
  isReleaseBuild = IS_RELEASE_BUILD,
): VariantConfig {
  const variant = buildVariant();
  const home = resolveHiveHome(hiveHome);
  const machineHome = machineHiveHome(home);
  const instanceSuffix = createHash("sha256")
    .update(home)
    .digest("hex")
    .slice(0, INSTANCE_HASH_LENGTH);
  const binName = variant === "prod" ? "hive" : `hive-${variant}`;
  return {
    variant,
    home,
    defaultHome: resolveHiveHome(defaultHiveHome()),
    machineHome,
    instanceSuffix,
    installRoot:
      process.env.HIVE_INSTALL_ROOT ??
      join(homedir(), ".local", "share", binName),
    binLink:
      process.env.HIVE_BIN_LINK ?? join(homedir(), ".local", "bin", binName),
    binName,
    socketRoot:
      process.env.HIVE_SESSIOND_ROOT ??
      join(machineHome, "run", instanceSuffix),
    sessiondStateRoot: join(home, "sessiond-state"),
    databaseIdentityPath: join(machineHome, "db-identity", instanceSuffix),
    retention: variant === "dev" ? DEV_RETENTION : EVIDENCE_RETENTION,
    sharedWithDefaultHome:
      variant === "dev" ? DEV_SHARED_WITH_DEFAULT_HOME : [],
    priorHomes: priorHomes(variant, home, machineHome),
    allowsLocalEmbeddingsSource: variant !== "prod" || !isReleaseBuild,
  };
}
