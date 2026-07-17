import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  ADAPTER_EVIDENCE_SURFACE_FILES,
  hasRequiredEvidenceGrounding,
  type AdapterEvidenceSurface,
  type EvidenceGrounding,
  type EmittableProbe,
} from "./__fixtures__/tg4/corpus";

/**
 * TG4 conformance report derived from grounded adapter and host probes run
 * through classifyProviderObservation.
 *
 * Adapter-origin probes additionally name a provider surface that is checked
 * against the cited adapter module. Host/schema evidence remains a distinct
 * origin and cannot be reported as adapter emission.
 */

const claudeHook = (hook: string, kind: string) => (source: string): boolean =>
  new RegExp(`${hook}:\\s*hook\\(eventCommand\\("${kind}"\\)\\)`).test(source);

const codexHook = (hook: string, kind: string) => (source: string): boolean =>
  new RegExp(
    'hookOverride\\("' + hook + '",\\s*`\\$\\{notifyPath\\} ' + kind + '`\\)',
  ).test(source);

const summaryReader = (source: string): boolean =>
  /interface GrokSummaryLocation\s*{[\s\S]*?mtimeMs:\s*number;/.test(source) &&
  /parsed\s*=\s*JSON\.parse\(await readFile\(summaryPath,\s*"utf8"\)\)/.test(source) &&
  /mtimeMs\s*=\s*\(await stat\(summaryPath\)\)\.mtimeMs/.test(source);

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const ADAPTER_SURFACE_VALIDATORS: Record<
  AdapterEvidenceSurface,
  (source: string) => boolean
> = {
  "claude:Stop": claudeHook("Stop", "turn-end"),
  "claude:UserPromptSubmit": claudeHook("UserPromptSubmit", "turn-start"),
  "claude:PostToolUse": claudeHook("PostToolUse", "tool-boundary"),
  "claude:Notification": claudeHook("Notification", "notification"),
  "codex:Stop": codexHook("Stop", "turn-end"),
  "codex:UserPromptSubmit": codexHook("UserPromptSubmit", "turn-start"),
  "codex:PostToolUse": codexHook("PostToolUse", "tool-boundary"),
  "codex:registered-hooks": (source) => {
    const registered = new Set(
      [...source.matchAll(/hookOverride\(\s*"([^"]+)"/g)].map((match) => match[1]),
    );
    return ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].every(
      (hook) => registered.has(hook),
    ) && !registered.has("Notification") && !registered.has("Approval");
  },
  "codex-app-server:turn/completed": (source) =>
    /if \(message\.method === "turn\/completed"\) \{[\s\S]{0,400}?const completedTurnId = stringField\(turn, "id"\)[\s\S]{0,1200}?kind:\s*"turn-end"/.test(
      source,
    ),
  "codex-app-server:turn/started": (source) =>
    /if \(message\.method === "turn\/started"\) \{[\s\S]{0,300}?session\.activeTurnId = stringField\(turn, "id"\)[\s\S]{0,300}?kind:\s*"turn-start"/.test(
      source,
    ),
  "codex-app-server:requestApproval": (source) =>
    /method === "item\/commandExecution\/requestApproval"/.test(source) &&
    /this\.options\.queueApproval\(\{ agentName, description \}\)/.test(source),
  "codex-app-server:unsupported-request": (source) =>
    /if \(description === null\) \{[\s\S]{0,300}?throw new Error\(`Unsupported Codex app-server request: \$\{method\}`\)/.test(
      source,
    ),
  "grok:summary-reader": summaryReader,
  "grok:no-turn-stream": (source) => {
    const code = withoutComments(source);
    return summaryReader(source) &&
      !/readFile\([^)]*(?:updates\.jsonl|turn_completed)/.test(code);
  },
  "grok:hooks-disabled": (source) =>
    /GROK_CLAUDE_HOOKS_ENABLED:\s*"false"/.test(source) &&
    /GROK_CURSOR_HOOKS_ENABLED:\s*"false"/.test(source),
};

export function adapterEvidenceIsStructurallyGrounded(
  probe: EvidenceGrounding,
): boolean {
  if (!probe.evidenceOrigins.includes("adapter")) return true;
  if (!hasRequiredEvidenceGrounding(probe) || probe.adapterSurface === undefined) {
    return false;
  }
  const expectedFile = ADAPTER_EVIDENCE_SURFACE_FILES[probe.adapterSurface];
  const hasExactFileCitation = probe.sourceCitations.some((citation) =>
    new RegExp(`^${expectedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d`).test(
      citation,
    )
  );
  if (!hasExactFileCitation) return false;
  const sourcePath = join(
    import.meta.dir,
    expectedFile.slice("src/adapters/tools/".length),
  );
  try {
    return ADAPTER_SURFACE_VALIDATORS[probe.adapterSurface](
      readFileSync(sourcePath, "utf8"),
    );
  } catch {
    return false;
  }
}

function assertEmittable(probe: EmittableProbe): void {
  if (!hasRequiredEvidenceGrounding(probe)) {
    throw new Error(
      `probe ${probe.surface}/${probe.label} is not emittable: invalid origin or citation metadata`,
    );
  }
  if (!adapterEvidenceIsStructurallyGrounded(probe)) {
    throw new Error(
      `probe ${probe.surface}/${probe.label} does not validate its named adapter surface`,
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
    evidenceOrigins: probe.evidenceOrigins,
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
          `emittable probe "${hit.label}" (origins ${hit.evidenceOrigins.join("+")}; adapter source structurally validated when claimed; cited ${hit.citations.join("; ")}) → readiness=${kind}`,
        collectorPath: hit.evidence.observedPath,
        evidenceOrigins: [...hit.evidenceOrigins],
      };
    }
    return {
      kind,
      status: "unavailable" as ConformanceLevelStatus,
      evidence: `no grounded adapter/host probe for ${surface} yields readiness=${kind}`,
      collectorPath: null,
      evidenceOrigins: [],
    };
  });

  const receipt = TERMINAL_RECEIPT_LEVELS.map((level: TerminalReceiptLevel) => {
    const hit = results.find((r) => r.evidence.receipt === level);
    if (hit !== undefined) {
      return {
        level,
        status: "provable-today" as ConformanceLevelStatus,
        evidence:
          `emittable probe "${hit.label}" (origins ${hit.evidenceOrigins.join("+")}; adapter source structurally validated when claimed; cited ${hit.citations.join("; ")}) → receipt=${level}`,
        collectorPath: hit.evidence.observedPath,
        evidenceOrigins: [...hit.evidenceOrigins],
      };
    }
    return {
      level,
      status: "unavailable" as ConformanceLevelStatus,
      evidence:
        level === "transport-written"
          ? "no emittable probe yields transport-written (sessiond/native commit is WP4 host proof)"
          : `no grounded adapter/host probe for ${surface} yields receipt=${level}`,
      collectorPath: null,
      evidenceOrigins: [],
    };
  });

  return { surface, readiness, receipt };
}

export function buildProviderConformanceReport(): ProviderConformanceReport {
  // Gate: CONFORMANCE_PROBES must equal the citation-filtered emittable set.
  if (
    CONFORMANCE_PROBES.length !==
      EMITTABLE_PROBES.filter(hasRequiredEvidenceGrounding).length
  ) {
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
      "classifyProviderObservation over CONFORMANCE_PROBES (emittable grounded shapes with explicit adapter/host origins)",
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
