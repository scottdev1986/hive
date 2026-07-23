// `hive embeddings install` — provision the external embedding runtime the
// compiled daemon loads (defect D1; see the header of
// src/daemon/memory-embeddings.ts for why a single-file binary cannot carry
// fastembed's native graph).
//
// A runtime already on disk that probe-verifies is kept: install is a no-op
// with the probe's detail, because re-staging (or re-downloading) over a
// healthy install buys nothing. Anything else provisions, trying in order:
//   1. DEV: copy fastembed and its full dependency closure from a checkout's
//      node_modules (--from, or walking up from the cwd) into
//      ~/.hive/tools/embeddings (HIVE_EMBEDDINGS_HOME override) and bundle it
//      with `bun build`. The staging pipeline itself lives in
//      src/release/embeddings-runtime.ts, shared with the release build so
//      the shipped artifact is byte-for-byte the dev layout.
//   2. PROD: a released binary with no checkout in reach downloads the pinned
//      `embeddings-runtime.tar.gz` from its own release — the pin is the
//      running binary's version, and the bytes are verified against the
//      Ed25519-signed release manifest before anything is unpacked
//      (src/release/embeddings-install.ts).
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
  installEmbeddingsFromRelease,
  type EmbeddingsInstallOutcome,
} from "../release/embeddings-install";
import {
  findSourceNodeModules,
  stageEmbeddingRuntime,
} from "../release/embeddings-runtime";
import { HIVE_VERSION } from "../version";

// The bundling pipeline moved to src/release/embeddings-runtime.ts (shared
// with the release build); these re-exports keep the existing import sites
// and unit tests working against one implementation.
export {
  collectFastembedClosure,
  findSourceNodeModules,
  stageEmbeddingRuntime,
} from "../release/embeddings-runtime";
export type { EmbeddingsInstallOutcome } from "../release/embeddings-install";

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
    const bundlePath = await stageEmbeddingRuntime(sourceNodeModules, runtimeDir);
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

export interface EmbeddingsProvisionDeps {
  runtimeDir: string;
  /** Where the dev flow looks for a checkout's node_modules. */
  cwd: string;
  installFromCheckout: (
    sourceNodeModules: string,
    runtimeDir: string,
  ) => Promise<EmbeddingsInstallOutcome>;
  installFromRelease: (runtimeDir: string) => Promise<EmbeddingsInstallOutcome>;
}

/**
 * The one provisioning flow both `hive embeddings install` and `hive init`
 * use: a checkout copy when a checkout is in reach (dev), the release
 * download when there is none (prod). An explicit `--from` is a promise —
 * when it names no fastembed source that is a loud failure, never a silent
 * fallback to the network.
 */
export async function provisionEmbeddingsRuntime(
  options: { from?: string },
  deps: EmbeddingsProvisionDeps,
): Promise<EmbeddingsInstallOutcome> {
  const source = await findSourceNodeModules(options.from ?? deps.cwd);
  if (source !== null) {
    return deps.installFromCheckout(source, deps.runtimeDir);
  }
  if (options.from !== undefined) {
    return {
      ok: false,
      reason:
        `no node_modules containing fastembed found from ${options.from} — ` +
        "run this from a Hive checkout (or fix the --from path)",
    };
  }
  return deps.installFromRelease(deps.runtimeDir);
}

function defaultProvisionDeps(probe: EmbeddingsProbe): EmbeddingsProvisionDeps {
  return {
    runtimeDir: embeddingsRuntimeDir(),
    cwd: process.cwd(),
    installFromCheckout: (source, runtimeDir) =>
      installFromCheckout(source, runtimeDir, probe),
    installFromRelease: (runtimeDir) => installFromRelease(runtimeDir, probe),
  };
}

export async function runEmbeddingsInstall(options: {
  from?: string;
  /** Injectable probe; `bun test` never downloads a model. */
  probe?: EmbeddingsProbe;
}): Promise<0 | 1> {
  const probe = options.probe ?? defaultProbe;
  const deps = defaultProvisionDeps(probe);
  console.log(`runtime dir: ${deps.runtimeDir}`);

  // A healthy install is left exactly as it is; a broken one is reinstalled
  // over, and an absent one is provisioned.
  const existing = await probeExisting(deps.runtimeDir, probe);
  if (existing !== null) {
    console.log(existing.detail);
    return 0;
  }

  const outcome = await provisionEmbeddingsRuntime(options, deps);
  if (!outcome.ok) {
    console.error(`hive embeddings install failed: ${outcome.reason}`);
    return 1;
  }
  console.log(outcome.detail);
  console.log("embedding runtime installed and probe-verified");
  return 0;
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
  return provisionEmbeddingsRuntime({}, deps);
}

export interface EnsureForReleaseDeps {
  /** Injectable probe; `bun test` never downloads a model. */
  probe?: EmbeddingsProbe;
  /** The version-pinned release install; injectable so tests never touch the
   * network. */
  installFromRelease?: (
    runtimeDir: string,
    version: string,
  ) => Promise<EmbeddingsInstallOutcome>;
}

/**
 * `hive update`'s step, keyed to the version it just activated. Embeddings
 * are a required component (user ruling 2026-07-22), so an update that moves
 * the binary re-provisions the runtime from that version's release — the
 * runtime on disk was pinned to the old one. Updating *to* the version this
 * binary already is means the runtime pin did not move either, so the healthy
 * probe-verified install skips fast, exactly like init.
 */
export async function ensureEmbeddingsRuntimeForRelease(
  version: string,
  deps: EnsureForReleaseDeps = {},
): Promise<EmbeddingsInstallOutcome> {
  const probe = deps.probe ?? defaultProbe;
  if (version === HIVE_VERSION) return ensureEmbeddingsRuntime(probe);
  const install = deps.installFromRelease ??
    ((runtimeDir: string, pinned: string) =>
      installEmbeddingsFromRelease(
        defaultReleaseInstallDeps({ runtimeDir, probe, version: pinned }),
      ));
  return install(embeddingsRuntimeDir(), version);
}
