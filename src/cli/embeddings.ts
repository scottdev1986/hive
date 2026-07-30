// Provision the external embedding runtime the compiled daemon loads (defect
// D1; see the header of src/daemon/memory-embeddings.ts for why a single-file
// binary cannot carry fastembed's native graph).
//
// There is no user-facing install command: installing Hive installs the
// runtime (install.sh unpacks it from the release), updating Hive updates it
// (`hive update`), and `hive init` provisions and load-verifies it. A dev run
// points HIVE_EMBEDDINGS_SOURCE at a checkout so the same init step stages
// from node_modules instead of downloading.
//
// A runtime already on disk that probe-verifies is kept, because re-staging
// (or re-downloading) over a healthy install buys nothing. Anything else
// provisions, by build kind:
//   - RELEASE (this build carries the pinned runtime digest): always download
//     the pinned `embeddings-runtime.tar.gz` from this binary's own release,
//     verified against the Ed25519-signed release manifest before anything is
//     unpacked (src/release/embeddings-install.ts). A checkout in reach is a
//     developer detail this path must never notice: the release loader only
//     accepts the digest its release shipped, so a locally staged tree could
//     only ever be refused.
//   - DEV: copy fastembed and its full dependency closure from a checkout's
//     node_modules (HIVE_EMBEDDINGS_SOURCE, or walking up from the cwd) into
//     ~/.hive/tools/embeddings (HIVE_EMBEDDINGS_HOME override) and bundle it
//     with `bun build`. The staging pipeline itself lives in
//     src/release/embeddings-runtime.ts, shared with the release build so
//     the shipped artifact is byte-for-byte the dev layout.
//
// Either way, install is only "done" when the strict probe passes: load the
// installed bundle — never the node_modules fallback — and embed a probe
// string at the model's width (dimensions=384).
import { join } from "node:path";
import {
  EMBEDDINGS_RUNTIME_BUNDLE,
  embeddingsRuntimeDir,
  memoryModelsDir,
  probeExternalRuntime,
} from "../daemon/memory-embeddings";
import {
  defaultReleaseInstallDeps,
  type EmbeddingsInstallOutcome,
  installEmbeddingsFromRelease,
} from "../release/embeddings-install";
import {
  findSourceNodeModules,
  stageEmbeddingRuntime,
} from "../release/embeddings-runtime";
import { HIVE_EMBEDDINGS_DIGEST } from "../version";

export type { EmbeddingsInstallOutcome } from "../release/embeddings-install";
// The bundling pipeline moved to src/release/embeddings-runtime.ts (shared
// with the release build); these re-exports keep the existing import sites
// and unit tests working against one implementation.
export {
  collectFastembedClosure,
  findSourceNodeModules,
  stageEmbeddingRuntime,
} from "../release/embeddings-runtime";

const PROBE_MODEL = "bge-small-en-v1.5" as const;

/** The strict check every install path ends in: load the bundle at the
 * runtime dir — never the node_modules fallback — and embed a probe string
 * at the model's width. A failed probe is a failed install, whatever the
 * bytes looked like. Injectable so `bun test` never downloads a model. */
export type EmbeddingsProbe = (
  runtimeDir: string,
) => Promise<{ model: string; dimensions: number }>;

const defaultProbe: EmbeddingsProbe = (runtimeDir) =>
  probeExternalRuntime(runtimeDir, PROBE_MODEL, memoryModelsDir());

/** A bundle on disk that probe-verifies is a completed install; a bundle
 * that fails the probe is a broken one and falls through to a fresh install
 * over it. Returns null in both "not done" cases. */
async function probeExisting(
  runtimeDir: string,
  probe: EmbeddingsProbe,
): Promise<{ ok: true; detail: string } | null> {
  if (!(await Bun.file(join(runtimeDir, EMBEDDINGS_RUNTIME_BUNDLE)).exists())) {
    return null;
  }
  try {
    const result = await probe(runtimeDir);
    return {
      ok: true,
      detail:
        `embedding runtime already installed at ${runtimeDir} and ` +
        `probe-verified (${result.model}, dimensions=${result.dimensions})`,
    };
  } catch {
    return null;
  }
}

/** The dev path: stage from a checkout's node_modules and probe. */
async function installFromCheckout(
  sourceNodeModules: string,
  runtimeDir: string,
  probe: EmbeddingsProbe,
): Promise<EmbeddingsInstallOutcome> {
  try {
    const bundlePath = await stageEmbeddingRuntime(
      sourceNodeModules,
      runtimeDir,
    );
    const result = await probe(runtimeDir);
    return {
      ok: true,
      detail:
        `embedding runtime staged from ${sourceNodeModules} (${bundlePath}) ` +
        `and probe-verified (${result.model}, dimensions=${result.dimensions})`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The prod path: download the pinned runtime from this binary's own release,
 * verify it against the signed manifest, and probe. */
async function installFromRelease(
  runtimeDir: string,
  probe: EmbeddingsProbe,
): Promise<EmbeddingsInstallOutcome> {
  return installEmbeddingsFromRelease(
    defaultReleaseInstallDeps({ runtimeDir, probe }),
  );
}

/** The env var a dev run sets to the checkout whose node_modules the runtime is
 * staged from, so provisioning does not depend on where the CLI was invoked.
 * When it is set and holds no fastembed, provisioning fails loudly instead of
 * quietly downloading a release the dev build is not pinned to. */
export const EMBEDDINGS_SOURCE_ENV = "HIVE_EMBEDDINGS_SOURCE";

export interface EmbeddingsProvisionDeps {
  runtimeDir: string;
  /** Where the dev flow looks for a checkout's node_modules. */
  cwd: string;
  /** True when this build carries the pinned runtime digest (a release).
   * A release build's loader accepts only the runtime its own release
   * shipped, so checkout staging can never satisfy it. */
  releaseBuild: boolean;
  installFromCheckout: (
    sourceNodeModules: string,
    runtimeDir: string,
  ) => Promise<EmbeddingsInstallOutcome>;
  installFromRelease: (runtimeDir: string) => Promise<EmbeddingsInstallOutcome>;
}

/**
 * The one provisioning flow. A release build always downloads its own pinned
 * runtime: its loader refuses anything else, so a nearby checkout — a
 * developer detail — must never divert a user's install onto a path that can
 * only end in the digest refusal. A dev build stages a checkout copy when one
 * is in reach and downloads otherwise. An explicit `from` —
 * HIVE_EMBEDDINGS_SOURCE, which a dev run sets — is a promise: when it names
 * no fastembed source that is a loud failure, never a silent fallback to the
 * network.
 */
export async function provisionEmbeddingsRuntime(
  options: { from?: string },
  deps: EmbeddingsProvisionDeps,
): Promise<EmbeddingsInstallOutcome> {
  if (deps.releaseBuild) {
    if (options.from !== undefined) {
      return {
        ok: false,
        reason:
          `${EMBEDDINGS_SOURCE_ENV} is a dev-build control; this release ` +
          "build loads only the runtime its own release shipped and would " +
          "refuse a locally staged one — unset it",
      };
    }
    return deps.installFromRelease(deps.runtimeDir);
  }
  const source = await findSourceNodeModules(options.from ?? deps.cwd);
  if (source !== null) {
    return deps.installFromCheckout(source, deps.runtimeDir);
  }
  if (options.from !== undefined) {
    return {
      ok: false,
      reason:
        `no node_modules containing fastembed found from ${options.from} — ` +
        `point ${EMBEDDINGS_SOURCE_ENV} at a Hive checkout with ` +
        "`bun install` already run, or unset it to download the runtime",
    };
  }
  return deps.installFromRelease(deps.runtimeDir);
}

function defaultProvisionDeps(probe: EmbeddingsProbe): EmbeddingsProvisionDeps {
  return {
    runtimeDir: embeddingsRuntimeDir(),
    cwd: process.cwd(),
    releaseBuild: HIVE_EMBEDDINGS_DIGEST !== null,
    installFromCheckout: (source, runtimeDir) =>
      installFromCheckout(source, runtimeDir, probe),
    installFromRelease: (runtimeDir) => installFromRelease(runtimeDir, probe),
  };
}

/**
 * Init's auto-provisioning: a runtime that is already on disk and probes
 * healthy is kept (a re-init never re-downloads); anything else gets the full
 * provisioning flow. The outcome is reported, never thrown — init degrades to
 * a loud "not installed" error rather than failing. The probe is injectable
 * so `bun test` never downloads a model.
 */
export async function ensureEmbeddingsRuntime(
  probe: EmbeddingsProbe = defaultProbe,
): Promise<EmbeddingsInstallOutcome> {
  const deps = defaultProvisionDeps(probe);
  const existing = await probeExisting(deps.runtimeDir, probe);
  if (existing !== null) return existing;
  const source = Bun.env[EMBEDDINGS_SOURCE_ENV];
  return provisionEmbeddingsRuntime(
    source === undefined || source === "" ? {} : { from: source },
    deps,
  );
}
