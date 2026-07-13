#!/usr/bin/env bun
/** Regenerate with `bun run scripts/test-fixtures/model-control-snapshot.ts`. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CapabilityDiscoveryResult } from "../../src/daemon/capability-discovery";
import type { AccountBilling } from "../../src/daemon/usage-credits";
import {
  buildModelControlSnapshot,
  type ModelControlSnapshot,
  type ModelControlSnapshotDependencies,
} from "../../src/cli/model-control";
import {
  known,
  unknown,
  type CapabilityProvider,
  type CapabilityRecord,
} from "../../src/schemas/capability";
import type { QuotaStatus } from "../../src/schemas";

const OBSERVED_AT = "2026-07-12T22:00:00.000Z";

export const MODEL_CONTROL_SNAPSHOT_FIXTURE = resolve(
  import.meta.dir,
  "../../test/fixtures/model-control-snapshot.json",
);

const record = (overrides: Partial<CapabilityRecord>): CapabilityRecord => ({
  provider: "claude",
  accountFingerprint: "abc123",
  cliVersion: "2.1.207",
  canonicalId: "claude-opus-4-8",
  variant: null,
  launchToken: "claude-opus-4-8",
  aliases: [],
  displayName: "Opus 4.8",
  entitled: known(true, "claude.initialize", OBSERVED_AT),
  hidden: unknown("surface-silent", "claude.initialize", OBSERVED_AT),
  supportsEffort: known(true, "claude.initialize", OBSERVED_AT),
  supportedEffortLevels: known(
    ["low", "medium", "high"],
    "claude.initialize",
    OBSERVED_AT,
  ),
  defaultEffort: unknown("field-absent", "claude.initialize", OBSERVED_AT),
  observedAt: OBSERVED_AT,
  ...overrides,
});

const discovery: Record<CapabilityProvider, CapabilityDiscoveryResult> = {
  claude: {
    status: "ok",
    records: [record({})],
    effectiveDefault: {
      provider: "claude",
      model: known("claude-opus-4-8", "claude.initialize", OBSERVED_AT),
      effort: unknown("surface-silent", "claude.initialize", OBSERVED_AT),
    },
  },
  codex: { status: "unavailable", reason: "codex CLI not signed in" },
  grok: {
    status: "ok",
    records: [record({
      provider: "grok",
      accountFingerprint: "grok123",
      cliVersion: "0.2.99",
      canonicalId: "grok-composer-2.5-fast",
      launchToken: "grok-composer-2.5-fast",
      displayName: null,
      entitled: known(true, "grok.models", OBSERVED_AT),
      hidden: known(false, "grok.models_cache", OBSERVED_AT),
      supportsEffort: known(false, "grok.models_cache", OBSERVED_AT),
      supportedEffortLevels: unknown(
        "field-absent",
        "grok.models_cache",
        OBSERVED_AT,
      ),
      defaultEffort: unknown("field-absent", "grok.models_cache", OBSERVED_AT),
    })],
    effectiveDefault: {
      provider: "grok",
      model: known("grok-4.5", "grok.models", OBSERVED_AT),
      effort: unknown("surface-silent", "grok.models", OBSERVED_AT),
    },
  },
};

const billing: Record<CapabilityProvider, AccountBilling | null> = {
  claude: {
    creditsEnabled: known(false, "claude.get_usage", OBSERVED_AT),
    disabledReason: null,
    generalUtilization: known(63, "claude.get_usage", OBSERVED_AT),
    modelUtilization: {},
    overflowUncertainty: null,
  },
  codex: null,
  grok: null,
};

const quota: QuotaStatus[] = [{
  provider: "claude",
  account: "default",
  pool: "plan",
  origin: "discovered",
  overridesDiscovered: false,
  models: ["*"],
  label: null,
  routable: true,
  confidence: "reported",
  freshness: "fresh",
  source: "provider",
  fiveHour: {
    availability: "available",
    unit: "percent",
    allowance: 100,
    used: 63,
    reserved: 0,
    reservedIsEstimate: true,
    remaining: 37,
    remainingPct: 0.37,
    resetsAt: OBSERVED_AT,
    confidence: "reported",
    source: "provider",
    observedAt: OBSERVED_AT,
    windowMinutes: 300,
  },
  weekly: {
    availability: "unknown",
    unit: "percent",
    allowance: null,
    used: null,
    reserved: 0,
    reservedIsEstimate: true,
    remaining: null,
    remainingPct: null,
    resetsAt: null,
    confidence: "missing",
    source: "none",
    observedAt: null,
    windowMinutes: null,
  },
}];

export const modelControlSnapshotFixtureDependencies = (
  overrides: ModelControlSnapshotDependencies = {},
): ModelControlSnapshotDependencies => ({
  discover: (provider) => Promise.resolve(discovery[provider]),
  readBilling: (provider) => Promise.resolve(billing[provider]),
  daemonPort: () => 4483,
  quota: async () => quota,
  tokenUsage: async () => ({
    generatedAt: OBSERVED_AT,
    currentSessionId: null,
    sessions: [],
    attribution: "control-lower-bound",
  }),
  now: () => new Date(OBSERVED_AT),
  ...overrides,
});

export const buildModelControlSnapshotFixture = (): Promise<ModelControlSnapshot> =>
  buildModelControlSnapshot(modelControlSnapshotFixtureDependencies());

export const renderModelControlSnapshotFixture = async (): Promise<string> =>
  `${JSON.stringify(await buildModelControlSnapshotFixture(), null, 2)}\n`;

if (import.meta.main) {
  await mkdir(dirname(MODEL_CONTROL_SNAPSHOT_FIXTURE), { recursive: true });
  await writeFile(
    MODEL_CONTROL_SNAPSHOT_FIXTURE,
    await renderModelControlSnapshotFixture(),
  );
  console.log(MODEL_CONTROL_SNAPSHOT_FIXTURE);
}
