import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
} from "../../schemas/capability";
import { ORCHESTRATOR_NAME } from "../../schemas/agent";
import {
  type QueenProviderProjection,
  QueenProviderProjectionSchema,
} from "../../schemas/queen-provider";
import { resolveWorkingClaudeExecutable } from "../../adapters/providers/claude-cli";
import { resolveWorkingCodexExecutable } from "../../adapters/providers/codex-cli";
import { resolveWorkingGrokExecutable } from "../../adapters/providers/grok-cli";
import { resolveWorkingKimiExecutable } from "../../adapters/providers/kimi-cli";
import { resolveWorkingOpencodeExecutable } from "../../adapters/providers/opencode-cli";
import { systemNow } from "../../shared/clock";
import {
  deriveOrchestratorStatus,
  type OrchestratorSignalKind,
} from "../status-service/status-service";
export {
  QueenProviderConflictError,
  QueenProviderControlStore,
} from "../queen-provider-store";

/** Daemon-owned control over which vendor runs the live Queen. The mechanism behind an accepted change is deliberately NOT here: the store records what was asked and what has been observed, while the replacement itself rides the existing root-replacement flow — the daemon terminates the running root, and the Workspace supervisor's relaunch loop asks `launchTool()` which vendor to bring up. A future succession mechanism can replace that flow without this store or the wire schema changing shape. Observation drives every transition out of `pending`. The store never flips to `idle` because a launch was requested — only because `reconcileObserved` saw the requested provider actually running. */

/** Which termination verdicts fail a provider change: only positive evidence of survival. sessiond reports "unknown" (incomplete-after-root-reap) for an immediate root kill it could not fully verify even when the whole tree is dead — proven live, where it failed the very first swap — and "terminated" needs no handling at all: either way the observation loop, not this verdict, resolves the change. A root that really survived just stays the observed live provider. */
export function terminationFailureDetail(
  terminated: Readonly<{
    state: "terminated" | "survivors" | "unknown";
    survivors: readonly unknown[];
  }>,
): string | null {
  return terminated.state === "survivors"
    ? `the running root survived termination with ` +
        `${terminated.survivors.length} survivor process(es)`
    : null;
}

/** The same gates `launchOrchestrator` applies before it will launch each vendor, so `available: true` means "asking for this queen can work", not "a binary exists somewhere". Probing spawns `--version` per vendor, so results are held briefly rather than re-probed by every poll. */
const AVAILABILITY_TTL_MS = 60_000;

function probeVendorAvailability(): Record<
  CapabilityProvider,
  { available: boolean }
> {
  const claude = resolveWorkingClaudeExecutable();
  return {
    claude: {
      available: !(claude.path === "claude" && claude.version === null),
    },
    codex: { available: resolveWorkingCodexExecutable() !== null },
    grok: { available: resolveWorkingGrokExecutable() !== null },
    kimi: { available: resolveWorkingKimiExecutable() !== null },
    opencode: { available: resolveWorkingOpencodeExecutable() !== null },
  };
}

export function vendorAvailabilityReader(
  probe: () => Record<
    CapabilityProvider,
    { available: boolean }
  > = probeVendorAvailability,
  now: () => number = systemNow,
): () => Record<CapabilityProvider, { available: boolean }> {
  let cached: Record<CapabilityProvider, { available: boolean }> | null = null;
  let cachedAt = 0;
  return () => {
    if (cached === null || now() - cachedAt > AVAILABILITY_TTL_MS) {
      cached = probe();
      cachedAt = now();
    }
    return cached;
  };
}

export interface QueenProviderProjectionInputs {
  instanceId: string;
  signals: readonly OrchestratorSignalKind[];
  observedLiveProvider: CapabilityProvider | null;
  vendors: Record<CapabilityProvider, { available: boolean }>;
  change: {
    state: "idle" | "pending" | "failed";
    revision: string;
    failure: string | null;
  };
  now: Date;
}

export function buildQueenProviderProjection(
  inputs: QueenProviderProjectionInputs,
): QueenProviderProjection {
  const [newest, previous] = inputs.signals;
  return QueenProviderProjectionSchema.parse({
    schemaVersion: 1,
    root: { name: ORCHESTRATOR_NAME, instanceId: inputs.instanceId },
    liveProvider: inputs.observedLiveProvider,
    health: deriveOrchestratorStatus(inputs.signals),
    contradicted: newest === "turn-end" && previous !== "turn-start",
    vendors: Object.fromEntries(
      CAPABILITY_PROVIDERS.map((provider) => [
        provider,
        inputs.vendors[provider] ?? { available: false },
      ]),
    ),
    change: {
      state: inputs.change.state,
      revision: inputs.change.revision,
      failure: inputs.change.failure,
    },
    observedAt: inputs.now.toISOString(),
  });
}
