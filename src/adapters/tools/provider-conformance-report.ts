import {
  PROVIDER_SURFACE_IDS,
  ProviderConformanceReportSchema,
  READINESS_EVIDENCE_KINDS,
  TERMINAL_RECEIPT_LEVELS,
  type ConformanceLevelStatus,
  type ProviderConformanceReport,
  type ProviderSurfaceId,
  type ReadinessEvidenceKind,
  type TerminalReceiptLevel,
} from "../../schemas/provider-manifest";
import { classifyProviderObservation } from "./provider-evidence";
import { CONFORMANCE_PROBES } from "./__fixtures__/tg4/corpus";

/**
 * TG4 conformance report derived FROM collector outputs.
 * A "provable-today" row exists only when some probe makes the collector emit
 * that readiness kind or receipt level. No hand-authored contradictions.
 */

function deriveSurface(surface: ProviderSurfaceId): ProviderConformanceReport["surfaces"][number] {
  const probes = CONFORMANCE_PROBES.filter((p) => p.surface === surface);
  const results = probes.map((probe) => ({
    label: probe.label,
    evidence: classifyProviderObservation(
      probe.surface,
      probe.observation,
      probe.attempt,
    ),
  }));

  const readiness = READINESS_EVIDENCE_KINDS.map((kind) => {
    const hit = results.find((r) => r.evidence.readiness === kind);
    if (hit !== undefined) {
      return {
        kind,
        status: "provable-today" as ConformanceLevelStatus,
        evidence: `collector emitted ${kind} via probe "${hit.label}" (${hit.evidence.observedPath})`,
        collectorPath: hit.evidence.observedPath,
      };
    }
    return {
      kind,
      status: "unavailable" as ConformanceLevelStatus,
      evidence: `no collector probe for ${surface} emits readiness=${kind}`,
      collectorPath: null,
    };
  });

  const receipt = TERMINAL_RECEIPT_LEVELS.map((level: TerminalReceiptLevel) => {
    const hit = results.find((r) => r.evidence.receipt === level);
    if (hit !== undefined) {
      return {
        level,
        status: "provable-today" as ConformanceLevelStatus,
        evidence: `collector emitted ${level} via probe "${hit.label}" (${hit.evidence.observedPath})`,
        collectorPath: hit.evidence.observedPath,
      };
    }
    return {
      level,
      status: "unavailable" as ConformanceLevelStatus,
      evidence:
        level === "transport-written"
          ? "collector never emits transport-written (sessiond/native commit is WP4 host proof, not adapter observation classification)"
          : `no collector probe for ${surface} emits receipt=${level}`,
      collectorPath: null,
    };
  });

  return { surface, readiness, receipt };
}

export function buildProviderConformanceReport(): ProviderConformanceReport {
  return ProviderConformanceReportSchema.parse({
    schemaVersion: 1,
    generatedFor: "WP8-early-slice-TG4",
    designRefs: [
      "docs/design/terminal-stack-transition.html §25",
      "docs/design/terminal-stack-transition.html §17 TG4",
      "docs/design/terminal-stack-transition.html §07 turnState sources",
      "docs/design/terminal-stack-transition.html §28 WP8",
      "src/schemas/message-envelope.ts TERMINAL_DELIVERY_EVIDENCE",
      "src/adapters/tools/provider-evidence.ts",
    ],
    derivedFrom:
      "classifyProviderObservation over CONFORMANCE_PROBES (provider-evidence.ts)",
    surfaces: PROVIDER_SURFACE_IDS.map(deriveSurface),
  });
}

/** Lazily built so it always matches live collector behavior. */
export const PROVIDER_CONFORMANCE_REPORT: ProviderConformanceReport =
  buildProviderConformanceReport();

/** Convenience: which readiness kinds a surface can prove today. */
export function provableReadiness(
  surface: ProviderSurfaceId,
): ReadinessEvidenceKind[] {
  const row = PROVIDER_CONFORMANCE_REPORT.surfaces.find((s) => s.surface === surface);
  if (row === undefined) return [];
  return row.readiness
    .filter((r) => r.status === "provable-today")
    .map((r) => r.kind);
}
