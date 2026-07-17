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
import {
  CONFORMANCE_PROBES,
  EMITTABLE_PROBES,
  type EmittableProbe,
} from "./__fixtures__/tg4/corpus";

/**
 * TG4 conformance report derived only from emittable probes (adapter-cited
 * observation shapes) run through classifyProviderObservation.
 *
 * A probe is emittable only when it carries non-empty sourceCitations into
 * adapter/schema source — not because the collector returned a path.
 */

function assertEmittable(probe: EmittableProbe): void {
  if (
    probe.sourceCitations.length === 0 ||
    probe.sourceCitations.some((c) => c.length === 0)
  ) {
    throw new Error(
      `probe ${probe.surface}/${probe.label} is not emittable: missing sourceCitations`,
    );
  }
}

function deriveSurface(
  surface: ProviderSurfaceId,
): ProviderConformanceReport["surfaces"][number] {
  const probes = CONFORMANCE_PROBES.filter((p) => p.surface === surface);
  for (const probe of probes) assertEmittable(probe);

  const results = probes.map((probe) => ({
    label: probe.label,
    citations: probe.sourceCitations,
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
        evidence:
          `emittable probe "${hit.label}" (cited ${hit.citations.join("; ")}) → readiness=${kind}`,
        collectorPath: hit.evidence.observedPath,
      };
    }
    return {
      kind,
      status: "unavailable" as ConformanceLevelStatus,
      evidence: `no emittable adapter-cited probe for ${surface} yields readiness=${kind}`,
      collectorPath: null,
    };
  });

  const receipt = TERMINAL_RECEIPT_LEVELS.map((level: TerminalReceiptLevel) => {
    const hit = results.find((r) => r.evidence.receipt === level);
    if (hit !== undefined) {
      return {
        level,
        status: "provable-today" as ConformanceLevelStatus,
        evidence:
          `emittable probe "${hit.label}" (cited ${hit.citations.join("; ")}) → receipt=${level}`,
        collectorPath: hit.evidence.observedPath,
      };
    }
    return {
      level,
      status: "unavailable" as ConformanceLevelStatus,
      evidence:
        level === "transport-written"
          ? "no emittable probe yields transport-written (sessiond/native commit is WP4 host proof)"
          : `no emittable adapter-cited probe for ${surface} yields receipt=${level}`,
      collectorPath: null,
    };
  });

  return { surface, readiness, receipt };
}

export function buildProviderConformanceReport(): ProviderConformanceReport {
  // Gate: CONFORMANCE_PROBES must equal the citation-filtered emittable set.
  if (CONFORMANCE_PROBES.length !== EMITTABLE_PROBES.filter(
    (p) => p.sourceCitations.length > 0 && p.sourceCitations.every((c) => c.length > 0),
  ).length) {
    throw new Error("CONFORMANCE_PROBES diverged from emittable citation filter");
  }

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
      "classifyProviderObservation over CONFORMANCE_PROBES (emittable, adapter-cited shapes only)",
    surfaces: PROVIDER_SURFACE_IDS.map(deriveSurface),
  });
}

export const PROVIDER_CONFORMANCE_REPORT: ProviderConformanceReport =
  buildProviderConformanceReport();

export function provableReadiness(
  surface: ProviderSurfaceId,
): ReadinessEvidenceKind[] {
  const row = PROVIDER_CONFORMANCE_REPORT.surfaces.find((s) => s.surface === surface);
  if (row === undefined) return [];
  return row.readiness
    .filter((r) => r.status === "provable-today")
    .map((r) => r.kind);
}
