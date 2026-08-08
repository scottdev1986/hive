import type { Database } from "bun:sqlite";
import { resolveWorkingClaudeExecutable } from "../../adapters/providers/claude-cli";
import { resolveWorkingCodexExecutable } from "../../adapters/providers/codex-cli";
import { resolveWorkingGrokExecutable } from "../../adapters/providers/grok-cli";
import { resolveWorkingKimiExecutable } from "../../adapters/providers/kimi-cli";
import { resolveWorkingOpencodeExecutable } from "../../adapters/providers/opencode-cli";
import type { ProviderCapabilitySnapshot } from "../../adapters/providers/protocol/types";
import { getProviderRuntimeAdapter } from "../../adapters/providers/provider-registry";
import type {
  CapabilityProvider,
  CapabilityRecord,
  Discovered,
} from "../../schemas/capability";
import { systemClock } from "../../shared/clock";
import { QuotaDatabase } from "../../usage-service/quota-ledger";
import {
  CapabilitySnapshotStore,
  snapshotValue,
} from "../capability-snapshot-store";
export {
  CapabilitySnapshotStore,
  ProviderCapabilitySnapshotSchema,
} from "../capability-snapshot-store";

type SnapshotProbe = (
  provider: CapabilityProvider,
) => Promise<ProviderCapabilitySnapshot>;

function preferKnown<T>(
  probe: Discovered<T>,
  session: Discovered<T>,
): Discovered<T> {
  if (session.state === "known") return session;
  return probe.state === "known" ? probe : session;
}

function mergeRecord(
  probe: CapabilityRecord,
  session: CapabilityRecord,
): CapabilityRecord {
  return {
    ...probe,
    ...session,
    entitled: preferKnown(probe.entitled, session.entitled),
    hidden: preferKnown(probe.hidden, session.hidden),
    supportsEffort: preferKnown(probe.supportsEffort, session.supportsEffort),
    supportedEffortLevels: preferKnown(
      probe.supportedEffortLevels,
      session.supportedEffortLevels,
    ),
    defaultEffort: preferKnown(probe.defaultEffort, session.defaultEffort),
  };
}

function recordIdentity(record: CapabilityRecord): string {
  return `${record.canonicalId}\0${record.variant ?? ""}`;
}

function overlayMeasurements(
  probe: ProviderCapabilitySnapshot["measurements"],
  session: ProviderCapabilitySnapshot["measurements"],
): ProviderCapabilitySnapshot["measurements"] {
  const measuredBySession = Object.fromEntries(
    Object.entries(session).filter(([, support]) => support !== "unknown"),
  );
  return { ...session, ...probe, ...measuredBySession };
}

function sharesCatalogContext(
  probe: readonly CapabilityRecord[],
  session: readonly CapabilityRecord[],
): boolean {
  return session.some((connected) =>
    probe.some(
      (cached) =>
        cached.accountFingerprint === connected.accountFingerprint &&
        cached.cliVersion === connected.cliVersion,
    ),
  );
}

function overlay(
  probe: ProviderCapabilitySnapshot | null,
  session: ProviderCapabilitySnapshot,
): ProviderCapabilitySnapshot {
  if (probe === null || probe.catalog.status !== "ok") return session;
  if (session.catalog.status !== "ok") {
    return {
      ...session,
      catalog: probe.catalog,
      measurements: overlayMeasurements(
        probe.measurements,
        session.measurements,
      ),
      absences: { ...probe.absences, ...session.absences },
      commands:
        session.measurements.commandCatalog === "supported"
          ? session.commands
          : probe.commands,
    };
  }
  if (!sharesCatalogContext(probe.catalog.records, session.catalog.records)) {
    return session;
  }

  const sessionRecords = new Map(
    session.catalog.records.map((record) => [recordIdentity(record), record]),
  );
  const records = probe.catalog.records.map((record) => {
    const connected = sessionRecords.get(recordIdentity(record));
    if (connected === undefined) return record;
    sessionRecords.delete(recordIdentity(record));
    return mergeRecord(record, connected);
  });
  records.push(...sessionRecords.values());
  return {
    ...session,
    catalog: {
      status: "ok",
      records,
      effectiveDefault: {
        provider: session.provider,
        model: preferKnown(
          probe.catalog.effectiveDefault.model,
          session.catalog.effectiveDefault.model,
        ),
        effort: preferKnown(
          probe.catalog.effectiveDefault.effort,
          session.catalog.effectiveDefault.effort,
        ),
      },
    },
    measurements: overlayMeasurements(probe.measurements, session.measurements),
    absences: { ...probe.absences, ...session.absences },
    commands:
      session.measurements.commandCatalog === "supported"
        ? session.commands
        : probe.commands,
  };
}

export class CapabilitySnapshotAuthority {
  private readonly connected = new Map<string, ProviderCapabilitySnapshot>();
  private readonly pending = new Map<
    string,
    Promise<ProviderCapabilitySnapshot>
  >();

  constructor(
    private readonly store: CapabilitySnapshotStore,
    private readonly probe: SnapshotProbe,
    private readonly now: () => Date = systemClock,
    private readonly maxAgeMs = 60_000,
    private readonly probeTimeoutMs = 10_000,
  ) {}

  recordConnected(
    sessionId: string,
    snapshot: ProviderCapabilitySnapshot,
  ): void {
    const value = snapshotValue(snapshot);
    if (value.source !== "session") {
      throw new Error("a connected snapshot must identify its session source");
    }
    this.connected.set(sessionId, value);
  }

  removeConnected(sessionId: string): void {
    this.connected.delete(sessionId);
  }

  current(provider: CapabilityProvider): ProviderCapabilitySnapshot | null {
    const cached = this.store.read(provider);
    const connected = [...this.connected.values()]
      .filter((snapshot) => snapshot.provider === provider)
      .sort((left, right) =>
        right.observedAt.localeCompare(left.observedAt),
      )[0];
    return connected === undefined ? cached : overlay(cached, connected);
  }

  /** A stale snapshot is served, never waited out. The probe behind a refresh boots an entire vendor CLI, and this method sits on the spawn admission path — every launch consults it, several times. Blocking here made spawn latency proportional to vendor CLI startup and once stalled the daemon long enough (measured: 4–8s per spawn wave) that launching panes gave up and died before their first instruction. A model catalog changes on the order of CLI updates, not seconds, so the cached answer is the right one to act on while a background refresh replaces it for the next reader. Only a provider with no snapshot at all — first contact — waits on the probe, because there is nothing older to serve. */
  async snapshot(
    provider: CapabilityProvider,
  ): Promise<ProviderCapabilitySnapshot> {
    const current = this.current(provider);
    if (current?.source === "session") return current;
    if (current === null) return this.refresh(provider);

    const observedAt = Date.parse(current.observedAt);
    if (
      !Number.isFinite(observedAt) ||
      this.now().getTime() - observedAt >= this.maxAgeMs
    ) {
      this.refresh(provider).catch(() => undefined);
    }
    return current;
  }

  private refresh(
    provider: CapabilityProvider,
  ): Promise<ProviderCapabilitySnapshot> {
    const existing = this.pending.get(provider);
    if (existing !== undefined) return existing;
    const pending = this.probeWithinDeadline(provider)
      .then((snapshot) => {
        const value = snapshotValue(snapshot);
        if (value.provider !== provider || value.source !== "probe") {
          throw new Error(
            `probe returned a mismatched ${value.provider} snapshot`,
          );
        }
        this.store.write(value);
        return value;
      })
      .finally(() => {
        this.pending.delete(provider);
      });
    this.pending.set(provider, pending);
    return pending;
  }

  private async probeWithinDeadline(
    provider: CapabilityProvider,
  ): Promise<ProviderCapabilitySnapshot> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.probe(provider),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `${provider} capability probe timed out after ${this.probeTimeoutMs}ms`,
                ),
              ),
            this.probeTimeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async discover(provider: CapabilityProvider) {
    return (await this.snapshot(provider)).catalog;
  }
}

export type CapabilityExecutables = Record<CapabilityProvider, string>;

export function createCapabilitySnapshotAuthority(
  database: Database,
  executables: CapabilityExecutables,
): CapabilitySnapshotAuthority {
  return new CapabilitySnapshotAuthority(
    new CapabilitySnapshotStore(database),
    (provider) =>
      getProviderRuntimeAdapter(provider).probe(executables[provider]),
  );
}

let defaultAuthority: CapabilitySnapshotAuthority | null = null;

export function discoverRuntimeCapabilities(provider: CapabilityProvider) {
  if (defaultAuthority === null) {
    const quota = new QuotaDatabase();
    defaultAuthority = createCapabilitySnapshotAuthority(quota.database, {
      claude: resolveWorkingClaudeExecutable().path,
      codex: resolveWorkingCodexExecutable()?.path ?? "codex",
      grok: resolveWorkingGrokExecutable()?.path ?? "grok",
      kimi: resolveWorkingKimiExecutable()?.path ?? "kimi",
      opencode: resolveWorkingOpencodeExecutable()?.path ?? "opencode",
    });
  }
  return defaultAuthority.discover(provider);
}
