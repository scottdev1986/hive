import type { CapabilityProvider } from "../../schemas/capability";
import type {
  QuotaPoolStatus,
  QuotaStatus,
  QuotaWindowStatus,
} from "../../schemas/quota";
import { QuotaStatusSchema } from "../../schemas/quota";
import { z } from "zod";
import { PaneDaemonClient } from "./pane-daemon-client";

export const QUOTA_WARNING_REMAINING_PCT = 0.25;
export const QUOTA_CRITICAL_REMAINING_PCT = 0.1;

export type QuotaWarningLevel = "warning" | "critical" | "exhausted";

export interface QuotaWarningNotice {
  readonly key: string;
  readonly level: QuotaWarningLevel;
  readonly resetsAt: string | null;
  readonly message: string;
}

interface QuotaWindowReading {
  readonly key: string;
  readonly provider: CapabilityProvider;
  readonly pool: string;
  readonly poolLabel: string | null;
  readonly windowLabel: "5-hour" | "weekly";
  readonly freshness: QuotaPoolStatus["freshness"];
  readonly value: QuotaWindowStatus;
}

type ObservedLevel = "normal" | QuotaWarningLevel;

interface ObservedState {
  readonly level: ObservedLevel;
  readonly resetsAt: string | null;
}

const LEVEL_RANK: Readonly<Record<ObservedLevel, number>> = {
  normal: 0,
  warning: 1,
  critical: 2,
  exhausted: 3,
};

function appliesToModel(
  status: QuotaPoolStatus,
  model: string | null,
): boolean {
  if (!status.routable) return false;
  if (status.models.includes("*")) return true;
  return model !== null && status.models.includes(model);
}

function warningLevel(remainingPct: number): ObservedLevel {
  if (remainingPct <= 0) return "exhausted";
  if (remainingPct <= QUOTA_CRITICAL_REMAINING_PCT) return "critical";
  if (remainingPct <= QUOTA_WARNING_REMAINING_PCT) return "warning";
  return "normal";
}

function warningReadings(
  statuses: readonly QuotaStatus[],
  provider: CapabilityProvider,
  model: string | null,
): readonly QuotaWindowReading[] {
  const readings: QuotaWindowReading[] = [];
  for (const status of statuses) {
    if (
      status.provider !== provider ||
      "configured" in status ||
      !appliesToModel(status, model)
    ) {
      continue;
    }
    for (const [window, windowLabel] of [
      ["fiveHour", "5-hour"],
      ["weekly", "weekly"],
    ] as const) {
      const value = status[window];
      if (value.availability !== "available" || value.remainingPct === null) {
        continue;
      }
      readings.push({
        key: `${status.provider}\0${status.account}\0${status.pool}\0${window}`,
        provider: status.provider,
        pool: status.pool,
        poolLabel: status.label,
        windowLabel,
        freshness: status.freshness,
        value,
      });
    }
  }
  return readings;
}

function resetLabel(resetsAt: string | null): string {
  if (resetsAt === null) return "reset time unknown";
  const reset = new Date(resetsAt);
  if (!Number.isFinite(reset.getTime())) return `resets ${resetsAt}`;
  return `resets ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(reset)}`;
}

function noticeFor(
  reading: QuotaWindowReading,
  level: QuotaWarningLevel,
  vendorName: string,
): QuotaWarningNotice {
  const remaining = Math.max(
    0,
    Math.round((reading.value.remainingPct ?? 0) * 100),
  );
  const pool = reading.poolLabel ?? reading.pool;
  const provenance =
    reading.freshness === "stale" || reading.value.confidence === "stale"
      ? " (stale reading)"
      : reading.value.confidence === "estimated"
        ? " (includes Hive estimates)"
        : "";
  const consequence =
    level === "exhausted"
      ? " New turns may fail until capacity resets."
      : level === "critical"
        ? " New turns are at risk."
        : "";
  return {
    key: reading.key,
    level,
    resetsAt: reading.value.resetsAt,
    message:
      `Hive reports ${vendorName} quota ${level} — ${reading.windowLabel} ${pool} pool has ` +
      `${remaining}% remaining${provenance}; ${resetLabel(reading.value.resetsAt)}.` +
      consequence,
  };
}

/** Emits once per threshold crossing, then rearms only after the window recovers above warning or its reset boundary changes. */
export class QuotaWarningMonitor {
  private readonly observed = new Map<string, ObservedState>();

  constructor(
    private readonly provider: CapabilityProvider,
    private readonly vendorName: string,
  ) {}

  evaluate(
    statuses: readonly QuotaStatus[],
    model: string | null,
  ): readonly QuotaWarningNotice[] {
    const notices: QuotaWarningNotice[] = [];
    for (const reading of warningReadings(statuses, this.provider, model)) {
      const level = warningLevel(reading.value.remainingPct ?? 1);
      const prior = this.observed.get(reading.key);
      if (level === "normal") {
        this.observed.set(reading.key, {
          level,
          resetsAt: reading.value.resetsAt,
        });
        continue;
      }
      const boundaryChanged =
        prior !== undefined && prior.resetsAt !== reading.value.resetsAt;
      if (
        prior === undefined ||
        prior.level === "normal" ||
        boundaryChanged ||
        LEVEL_RANK[level] > LEVEL_RANK[prior.level]
      ) {
        notices.push(noticeFor(reading, level, this.vendorName));
      }
      this.observed.set(reading.key, {
        level:
          prior !== undefined &&
          !boundaryChanged &&
          LEVEL_RANK[prior.level] > LEVEL_RANK[level]
            ? prior.level
            : level,
        resetsAt: reading.value.resetsAt,
      });
    }
    return notices;
  }
}

export interface QuotaWarningClientOptions {
  readonly port: number;
  readonly subject: string;
  readonly provider: CapabilityProvider;
  readonly vendorName: string;
  readonly readStatuses?: () => Promise<readonly QuotaStatus[]>;
}

export class QuotaWarningClient {
  private readonly monitor: QuotaWarningMonitor;
  private readonly readStatuses: () => Promise<readonly QuotaStatus[]>;

  constructor(options: QuotaWarningClientOptions) {
    this.monitor = new QuotaWarningMonitor(
      options.provider,
      options.vendorName,
    );
    const daemon = new PaneDaemonClient({
      port: options.port,
      subject: options.subject,
    });
    this.readStatuses =
      options.readStatuses ??
      (async () => {
        const response = await daemon.request("/agent-ui/quota");
        if (!response.ok) {
          throw new Error(
            `quota status poll failed: ${response.status} ${await daemon.errorDetail(response)}`,
          );
        }
        return z
          .strictObject({ quotas: z.array(QuotaStatusSchema) })
          .parse(await response.json()).quotas;
      });
  }

  async poll(model: string | null): Promise<readonly QuotaWarningNotice[]> {
    return this.monitor.evaluate(await this.readStatuses(), model);
  }
}
