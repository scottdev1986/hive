import { join } from "node:path";
import {
  EMBEDDINGS_RUNTIME_BUNDLE,
  embeddingsRuntimeDir,
  memoryModelsDir,
  probeExternalRuntime,
} from "../memory-service/embeddings";
import {
  defaultReleaseInstallDeps,
  type EmbeddingsInstallOutcome,
  installEmbeddingsFromRelease,
} from "../embeddings-runtime/install";
import {
  findSourceNodeModules,
  stageEmbeddingRuntime,
} from "../embeddings-runtime/runtime";
import { resolveVariant } from "../hive-home/variant";
import { HIVE_EMBEDDINGS_DIGEST } from "../shared/version";
import { definedFields } from "../shared/defined-fields";
import { errorMessage } from "../shared/error-message";

export type { EmbeddingsInstallOutcome } from "../embeddings-runtime/install";
export {
  collectFastembedClosure,
  findSourceNodeModules,
  stageEmbeddingRuntime,
} from "../embeddings-runtime/runtime";

const PROBE_MODEL = "bge-small-en-v1.5" as const;

/** The strict check every install path ends in: load the bundle at the runtime dir — never the node_modules fallback — and embed a probe string at the model's width. A failed probe is a failed install, whatever the bytes looked like. Injectable so `bun test` never downloads a model. */
export type EmbeddingsProbe = (
  runtimeDir: string,
) => Promise<{ model: string; dimensions: number }>;

const defaultProbe: EmbeddingsProbe = (runtimeDir) =>
  probeExternalRuntime(runtimeDir, PROBE_MODEL, memoryModelsDir());

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
      reason: errorMessage(error),
    };
  }
}

async function installFromRelease(
  runtimeDir: string,
  probe: EmbeddingsProbe,
  version?: string,
): Promise<EmbeddingsInstallOutcome> {
  return installEmbeddingsFromRelease(
    defaultReleaseInstallDeps({
      runtimeDir,
      probe,
      ...definedFields({ version }),
    }),
  );
}

export const EMBEDDINGS_SOURCE_ENV = "HIVE_EMBEDDINGS_SOURCE";

export interface EmbeddingsProvisionDeps {
  runtimeDir: string;
  cwd: string;
  /** True when this build carries the pinned runtime digest, which its loader then treats as the only runtime it will import. Staging a local tree into such a build produces bytes the loader refuses, so there is nothing to gain by trying. This is a fact about what the loader can load, not about which variant is running — the two are independent and this field must never be read as either one standing in for the other. */
  loaderPinsRuntime: boolean;
  /** Whether this build is permitted to load embeddings from a local tree at all, from `resolveVariant().allowsLocalEmbeddingsSource`. False for a published prod binary, whose whole point is that it must not be talked into importing arbitrary local code. Independent of `loaderPinsRuntime`: an unkeyed prod release could load a staged tree perfectly well and still must not be allowed to. */
  allowsLocalEmbeddingsSource: boolean;
  installFromCheckout: (
    sourceNodeModules: string,
    runtimeDir: string,
  ) => Promise<EmbeddingsInstallOutcome>;
  installFromRelease: (runtimeDir: string) => Promise<EmbeddingsInstallOutcome>;
}

export interface EmbeddingsReleaseProvisionDeps {
  runtimeDir: string;
  probe: EmbeddingsProbe;
  install: (
    version: string,
    runtimeDir: string,
    probe: EmbeddingsProbe,
  ) => Promise<EmbeddingsInstallOutcome>;
}

/** Why a local embeddings tree may not be used here, or null when it may. Two independent facts, so two messages: a reader who cannot tell "this build is not allowed to" from "this build could not load it anyway" will file the wrong bug. The policy fact is reported first because it is the higher-order one — a prod binary is refused whether or not its loader could have coped. */
function localSourceRefusal(
  deps: Pick<
    EmbeddingsProvisionDeps,
    "allowsLocalEmbeddingsSource" | "loaderPinsRuntime"
  >,
): string | null {
  if (!deps.allowsLocalEmbeddingsSource) {
    return (
      `${EMBEDDINGS_SOURCE_ENV} is not permitted in a production build, ` +
      "which must never load embeddings from a local tree — unset it, or " +
      "use a dev or qa build"
    );
  }
  if (deps.loaderPinsRuntime) {
    return (
      `${EMBEDDINGS_SOURCE_ENV} cannot be honoured by this build: its ` +
      "loader accepts only the runtime digest its own release shipped, so a " +
      "locally staged tree would be refused at import — unset it"
    );
  }
  return null;
}

/** The one provisioning flow. A release build always downloads its own pinned runtime: its loader refuses anything else, so a nearby checkout — a developer detail — must never divert a user's install onto a path that can only end in the digest refusal. A dev build stages a checkout copy when one is in reach and downloads otherwise. An explicit `from` — HIVE_EMBEDDINGS_SOURCE, which a dev run sets — is a promise: when it names no fastembed source that is a loud failure, never a silent fallback to the network. */
export async function provisionEmbeddingsRuntime(
  options: { from?: string },
  deps: EmbeddingsProvisionDeps,
): Promise<EmbeddingsInstallOutcome> {
  const refusal = localSourceRefusal(deps);
  if (refusal !== null) {
    // The refusal covers the cwd walk too, not only an explicit `from`. Gating the environment
    // variable alone would leave a protection that a `cd` into a checkout defeats.
    if (options.from !== undefined) return { ok: false, reason: refusal };
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
    loaderPinsRuntime: HIVE_EMBEDDINGS_DIGEST !== null,
    allowsLocalEmbeddingsSource: resolveVariant().allowsLocalEmbeddingsSource,
    installFromCheckout: (source, runtimeDir) =>
      installFromCheckout(source, runtimeDir, probe),
    installFromRelease: (runtimeDir) => installFromRelease(runtimeDir, probe),
  };
}

/** Init's auto-provisioning: a runtime that is already on disk and probes healthy is kept (a re-init never re-downloads); anything else gets the full provisioning flow. The outcome is reported, never thrown — init degrades to a loud "not installed" error rather than failing. The probe is injectable so `bun test` never downloads a model. */
export async function ensureEmbeddingsRuntime(
  probe: EmbeddingsProbe = defaultProbe,
): Promise<EmbeddingsInstallOutcome> {
  const deps = defaultProvisionDeps(probe);
  const existing = await probeExisting(deps.runtimeDir, probe);
  if (existing !== null) return existing;
  const source = Bun.env[EMBEDDINGS_SOURCE_ENV];
  return provisionEmbeddingsRuntime(
    definedFields({
      from: source === undefined || source === "" ? undefined : source,
    }),
    deps,
  );
}

function defaultReleaseProvisionDeps(): EmbeddingsReleaseProvisionDeps {
  return {
    runtimeDir: embeddingsRuntimeDir(),
    probe: defaultProbe,
    install: (version, runtimeDir, probe) =>
      installFromRelease(runtimeDir, probe, version),
  };
}

/** Provision the runtime pinned to an update's activated release. The updater already verified that release's binary and manifest; passing its version here keeps the runtime on the same release instead of using the version compiled into the predecessor process. */
export async function ensureEmbeddingsRuntimeForRelease(
  version: string,
  deps: EmbeddingsReleaseProvisionDeps = defaultReleaseProvisionDeps(),
): Promise<EmbeddingsInstallOutcome> {
  const existing = await probeExisting(deps.runtimeDir, deps.probe);
  if (existing !== null) return existing;
  return deps.install(version, deps.runtimeDir, deps.probe);
}
