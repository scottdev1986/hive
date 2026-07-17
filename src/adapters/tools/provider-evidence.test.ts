import { describe, expect, test } from "bun:test";
import {
  PROVIDER_SURFACE_IDS,
  ProviderManifestSchema,
  ProviderConformanceReportSchema,
  TG4_SCENARIOS,
  TERMINAL_RECEIPT_LEVELS,
} from "../../schemas/provider-manifest";
import {
  allProviderManifests,
  PROVIDER_MANIFESTS,
} from "./provider-manifests";
import {
  classifyProviderObservation,
  CLAUDE_PERMISSION_PROMPT_TYPE,
} from "./provider-evidence";
import { PROVIDER_CONFORMANCE_REPORT } from "./provider-conformance-report";
import {
  ABSENT_FIELD_CONTROLS,
  GROK_HOOK_ABSENCE_PROBES,
  TG4_SCENARIO_FIXTURES,
} from "./__fixtures__/tg4/corpus";

describe("WP8 provider manifests", () => {
  test("every terminal provider surface has a schema-valid manifest", () => {
    expect(Object.keys(PROVIDER_MANIFESTS).sort()).toEqual(
      [...PROVIDER_SURFACE_IDS].sort(),
    );
    for (const manifest of allProviderManifests()) {
      const parsed = ProviderManifestSchema.parse(manifest);
      expect(parsed.surface).toBe(manifest.surface);
      expect(parsed.unknownModalBlocksDelivery).toBe(true);
      expect(parsed.fixtureSet.startsWith("tg4-")).toBe(true);
      expect(parsed.versionRange.measured.length).toBeGreaterThan(0);
      expect(parsed.launchArgv.sourceCitations.length).toBeGreaterThan(0);
      expect(parsed.laterSeams.length).toBeGreaterThan(0);
    }
  });

  test("manifests record honest capability absences for grok hooks", () => {
    const grok = PROVIDER_MANIFESTS["grok-tui"];
    expect(grok.capabilityAbsences.some((item) => item.includes("SessionStart")))
      .toBe(true);
    expect(grok.eventSchemas.filter((e) => e.role === "session-start")[0]?.available)
      .toBe(false);
    expect(grok.nativeEndpoint.available).toBe(false);
  });

  test("codex-app-server is the only native-endpoint surface among the four", () => {
    const available = allProviderManifests().filter((m) => m.nativeEndpoint.available);
    expect(available.map((m) => m.surface)).toEqual(["codex-app-server"]);
    expect(PROVIDER_MANIFESTS["codex-app-server"].nativeEndpoint.endpoints)
      .toContain("turn/start");
  });

  test("claude and codex TUI manifests pin measured versions from existing tests", () => {
    expect(PROVIDER_MANIFESTS["claude-tui"].versionRange.measured).toContain("2.1.206");
    expect(PROVIDER_MANIFESTS["codex-tui"].versionRange.measured).toContain("0.144.1");
  });
});

describe("WP8 readiness/receipt evidence collection", () => {
  test("TG4 corpus covers every surface × scenario exactly once", () => {
    const keys = TG4_SCENARIO_FIXTURES.map((f) => `${f.surface}:${f.scenario}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const surface of PROVIDER_SURFACE_IDS) {
      for (const scenario of TG4_SCENARIOS) {
        expect(keys).toContain(`${surface}:${scenario}`);
      }
    }
    expect(keys.length).toBe(PROVIDER_SURFACE_IDS.length * TG4_SCENARIOS.length);
  });

  test("structure-asserting scenario fixtures classify as expected", () => {
    for (const fixture of TG4_SCENARIO_FIXTURES) {
      const evidence = classifyProviderObservation(
        fixture.surface,
        fixture.observation,
      );
      expect(evidence.surface).toBe(fixture.surface);
      expect(evidence.readiness).toBe(fixture.expectedReadiness);
      expect(evidence.receipt).toBe(fixture.expectedReceipt);
      // Never invent ready from unknown modal path.
      if (fixture.scenario === "modal") {
        expect(evidence.readiness).toBe("blocked-unknown");
        expect(evidence.readiness).not.toBe("ready");
      }
    }
  });

  test("positive controls: misspelled keys are evidence-absent; correct keys classify", () => {
    for (const control of ABSENT_FIELD_CONTROLS) {
      const miss = classifyProviderObservation(control.surface, control.misspelled);
      expect(miss.readiness).toBe("evidence-absent");
      expect(miss.receipt).toBe("evidence-absent");

      const hit = classifyProviderObservation(
        control.surface,
        control.correctlySpelled,
      );
      expect(hit.readiness).toBe(control.expectedCorrectReadiness);
      expect(hit.readiness).not.toBe("evidence-absent");
    }
  });

  test("unknown Claude notification types never map to ready", () => {
    const evidence = classifyProviderObservation("claude-tui", {
      kind: "notification",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:00.000Z",
      notificationType: "brand_new_unclassified",
    });
    expect(evidence.readiness).toBe("blocked-unknown");
    expect(evidence.readiness).not.toBe("ready");
  });

  test("permission_prompt is awaiting-approval, not ready", () => {
    const evidence = classifyProviderObservation("claude-tui", {
      kind: "notification",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:00.000Z",
      notificationType: CLAUDE_PERMISSION_PROMPT_TYPE,
    });
    expect(evidence.readiness).toBe("awaiting-approval");
  });

  test("Grok hook probes are capability-absent (never fabricated)", () => {
    for (const probe of GROK_HOOK_ABSENCE_PROBES) {
      const evidence = classifyProviderObservation("grok-tui", {
        capabilityProbe: probe,
      });
      expect(evidence.readiness).toBe("capability-absent");
      expect(evidence.receipt).toBe("capability-absent");
    }
  });

  test("tool-boundary is turn-boundary, not idle ready", () => {
    const evidence = classifyProviderObservation("claude-tui", {
      kind: "tool-boundary",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:00.000Z",
    });
    expect(evidence.readiness).toBe("turn-boundary");
    expect(evidence.readiness).not.toBe("ready");
  });
});

describe("WP8 TG4 conformance report", () => {
  test("report is schema-valid and covers all surfaces and receipt levels", () => {
    const report = ProviderConformanceReportSchema.parse(PROVIDER_CONFORMANCE_REPORT);
    expect(report.surfaces.map((s) => s.surface).sort()).toEqual(
      [...PROVIDER_SURFACE_IDS].sort(),
    );
    for (const surface of report.surfaces) {
      const levels = surface.receipt.map((r) => r.level).sort();
      expect(levels).toEqual([...TERMINAL_RECEIPT_LEVELS].sort());
      for (const row of surface.receipt) {
        expect(["provable-today", "unavailable"]).toContain(row.status);
        expect(row.evidence.length).toBeGreaterThan(0);
      }
    }
  });

  test("Grok reports hook turn-boundary and structured approval as unavailable", () => {
    const grok = PROVIDER_CONFORMANCE_REPORT.surfaces.find(
      (s) => s.surface === "grok-tui",
    )!;
    expect(
      grok.readiness.find((r) => r.kind === "turn-boundary")?.status,
    ).toBe("unavailable");
    expect(
      grok.readiness.find((r) => r.kind === "awaiting-approval")?.status,
    ).toBe("unavailable");
    expect(
      grok.receipt.find((r) => r.level === "provider-observed")?.status,
    ).toBe("provable-today");
  });

  test("transport-written is unavailable on TUI surfaces (sessiond concern)", () => {
    for (const surface of ["claude-tui", "codex-tui", "grok-tui"] as const) {
      const row = PROVIDER_CONFORMANCE_REPORT.surfaces
        .find((s) => s.surface === surface)!
        .receipt.find((r) => r.level === "transport-written")!;
      expect(row.status).toBe("unavailable");
    }
    const app = PROVIDER_CONFORMANCE_REPORT.surfaces
      .find((s) => s.surface === "codex-app-server")!
      .receipt.find((r) => r.level === "transport-written")!;
    expect(app.status).toBe("provable-today");
  });
});
