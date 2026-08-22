import { homedir } from "node:os";
import { join } from "node:path";
import { IS_RELEASE_BUILD } from "../shared/version";
import {
  databaseIdentityPath,
  getHiveHome,
  resolveHiveHome,
  sessiondRuntimeRoot,
  sessiondStateRoot,
} from "./home";

export type HiveVariant = "prod" | "dev" | "qa";

const VARIANTS: readonly HiveVariant[] = ["prod", "dev", "qa"];

/** Dev may link these user-owned stores into its isolated home. Runtime state and artifacts stay unlinked: runtime must remain isolated, while artifacts already resolve through the machine home. */
export const DEV_SHARED_WITH_DEFAULT_HOME: readonly string[] = [
  "memory",
  "projects",
  "project-registry.json",
  "models",
];

const HOME_DATABASES = ["hive.db", "quota.db"] as const;
const DATABASE_ATOM_SUFFIXES = ["", "-wal", "-shm"] as const;

/** Dev uninstall keeps user state and shared links, but drops credentials and expendable runtime state. Databases stay with their WAL/SHM sidecars so retained writes remain complete. */
const DEV_RETENTION: readonly string[] = [
  ...HOME_DATABASES.flatMap((name) =>
    DATABASE_ATOM_SUFFIXES.map((suffix) => `${name}${suffix}`),
  ),
  "config.toml",
  "quota.toml",
  "billing-*.json",
  "artifacts",
  ...DEV_SHARED_WITH_DEFAULT_HOME,
];

/** What every uninstall keeps regardless of variant: the artifact store. Artifacts are work products the board cites as permanent evidence, written to be readable with no Hive at all — an uninstall removes the install, not the evidence. A `--purge` overrides this like any other retention, and says so in the plan before consent. */
const EVIDENCE_RETENTION: readonly string[] = ["artifacts"];

export interface VariantConfig {
  readonly variant: HiveVariant;
  readonly home: string;
  readonly installRoot: string;
  readonly binLink: string;
  readonly binName: string;
  readonly socketRoot: string;
  readonly sessiondStateRoot: string;
  readonly databaseIdentityPath: string;
  readonly retention: readonly string[];
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

export function resolveVariant(
  hiveHome = getHiveHome(),
  isReleaseBuild = IS_RELEASE_BUILD,
): VariantConfig {
  const variant = buildVariant();
  const home = resolveHiveHome(hiveHome);
  const binName = variant === "prod" ? "hive" : `hive-${variant}`;
  return {
    variant,
    home,
    installRoot:
      process.env.HIVE_INSTALL_ROOT ??
      join(homedir(), ".local", "share", binName),
    binLink:
      process.env.HIVE_BIN_LINK ?? join(homedir(), ".local", "bin", binName),
    binName,
    socketRoot: sessiondRuntimeRoot(home),
    sessiondStateRoot: sessiondStateRoot(home),
    databaseIdentityPath: databaseIdentityPath(home),
    retention: variant === "dev" ? DEV_RETENTION : EVIDENCE_RETENTION,
    allowsLocalEmbeddingsSource: variant !== "prod" || !isReleaseBuild,
  };
}
