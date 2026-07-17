import { describe, expect, test } from "bun:test";
import {
  PROVIDER_SURFACE_IDS,
  ProviderManifestSchema,
  ProviderConformanceReportSchema,
  TG4_SCENARIOS,
  TERMINAL_RECEIPT_LEVELS,
  type AttemptContext,
  type ProviderSurfaceId,
  type ReadinessEvidenceKind,
  type ReceiptEvidenceKind,
} from "../../schemas/provider-manifest";
import {
  allProviderManifests,
  collectManifestCitationPaths,
  PROVIDER_MANIFESTS,
} from "./provider-manifests";
import {
  classifyProviderObservation,
  CLAUDE_PERMISSION_PROMPT_TYPE,
} from "./provider-evidence";
import {
  buildProviderConformanceReport,
  PROVIDER_CONFORMANCE_REPORT,
} from "./provider-conformance-report";
import {
  ABSENT_FIELD_CONTROLS,
  GROK_HOOK_ABSENCE_PROBES,
  TG4_SCENARIO_FIXTURES,
} from "./__fixtures__/tg4/corpus";

/**
 * §25-derived expectations for TG4 scenarios.
 * These are reasoned from the design prerequisites, not copied from collector
 * return enums stored on fixtures.
 */
function section25Expectation(
  surface: ProviderSurfaceId,
  scenario: (typeof TG4_SCENARIOS)[number],
): { readiness: ReadinessEvidenceKind; receipt: ReceiptEvidenceKind } {
  switch (surface) {
    case "claude-tui":
      switch (scenario) {
        case "idle":
          // Stop + health + session + no modal + matching attempt after commit
          return { readiness: "ready", receipt: "provider-observed" };
        case "busy":
          return { readiness: "busy", receipt: "provider-observed" };
        case "approval":
          // permission_prompt measured — no receipt upgrade without matching boundary
          return { readiness: "awaiting-approval", receipt: "evidence-absent" };
        case "modal":
          return { readiness: "blocked-unknown", receipt: "evidence-absent" };
        case "disconnect":
          // committed attempt + death → in-doubt
          return { readiness: "disconnected", receipt: "attempt-in-doubt" };
        case "restart":
          return { readiness: "restarting", receipt: "evidence-absent" };
      }
      break;
    case "codex-tui":
      switch (scenario) {
        case "idle":
          return { readiness: "ready", receipt: "provider-observed" };
        case "busy":
          return { readiness: "busy", receipt: "provider-observed" };
        case "approval":
          // No Notification/approval hook registered (codex.ts:174-186)
          return { readiness: "capability-absent", receipt: "capability-absent" };
        case "modal":
          // Notification not registered → capability-absent, not fake blocked path
          return { readiness: "capability-absent", receipt: "capability-absent" };
        case "disconnect":
          return { readiness: "disconnected", receipt: "attempt-in-doubt" };
        case "restart":
          return { readiness: "restarting", receipt: "evidence-absent" };
      }
      break;
    case "codex-app-server":
      switch (scenario) {
        case "idle":
          return { readiness: "ready", receipt: "provider-observed" };
        case "busy":
          return { readiness: "busy", receipt: "provider-observed" };
        case "approval":
          return { readiness: "awaiting-approval", receipt: "evidence-absent" };
        case "modal":
          return { readiness: "blocked-unknown", receipt: "evidence-absent" };
        case "disconnect":
          return { readiness: "disconnected", receipt: "attempt-in-doubt" };
        case "restart":
          return { readiness: "restarting", receipt: "evidence-absent" };
      }
      break;
    case "grok-tui":
      switch (scenario) {
        case "idle":
          return { readiness: "ready", receipt: "provider-observed" };
        case "busy":
          return { readiness: "busy", receipt: "provider-observed" };
        case "approval":
        case "modal":
          return { readiness: "blocked-unknown", receipt: "evidence-absent" };
        case "disconnect":
          return { readiness: "disconnected", receipt: "attempt-in-doubt" };
        case "restart":
          return { readiness: "restarting", receipt: "evidence-absent" };
      }
      break;
  }
  throw new Error(`unmapped ${surface}:${scenario}`);
}

describe("WP8 provider manifests", () => {
  test("every terminal provider surface has a schema-valid manifest", () => {
    expect(Object.keys(PROVIDER_MANIFESTS).sort()).toEqual(
      [...PROVIDER_SURFACE_IDS].sort(),
    );
    for (const manifest of allProviderManifests()) {
      ProviderManifestSchema.parse(manifest);
      expect(manifest.unknownModalBlocksDelivery.value).toBe(true);
      expect(manifest.fixtureSet.value.startsWith("tg4-")).toBe(true);
      expect(manifest.versionRange.supportedMin.length).toBeGreaterThan(0);
      expect(manifest.versionRange.supportedMax.length).toBeGreaterThan(0);
      expect(manifest.versionRange.measuredExamples.length).toBeGreaterThan(0);
    }
  });

  test("every grounded manifest field carries non-empty sourceCitations", () => {
    for (const manifest of allProviderManifests()) {
      const paths = collectManifestCitationPaths(manifest);
      // Must cover the fields the review named, not only launchArgv.
      const pathNames = paths.map((p) => p.path);
      expect(pathNames).toContain("versionRange");
      expect(pathNames).toContain("readinessStates");
      expect(pathNames).toContain("strongestAutomaticReceipt");
      expect(pathNames).toContain("unknownModalBlocksDelivery");
      expect(pathNames).toContain("capabilityAbsences");
      expect(pathNames).toContain("fixtureSet");
      expect(pathNames).toContain("launchArgv");
      for (const row of paths) {
        expect(row.citations.length).toBeGreaterThan(0);
        for (const citation of row.citations) {
          expect(citation.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("codex-tui does not claim awaiting-approval readiness (Notification absent)", () => {
    const states = PROVIDER_MANIFESTS["codex-tui"].readinessStates.value;
    expect(states).not.toContain("awaiting-approval");
    expect(
      PROVIDER_MANIFESTS["codex-tui"].capabilityAbsences.value.some((a) =>
        a.includes("approval") || a.includes("Notification"),
      ),
    ).toBe(true);
    const notification = PROVIDER_MANIFESTS["codex-tui"].eventSchemas.find(
      (e) => e.role === "notification",
    );
    expect(notification?.available).toBe(false);
  });

  test("Grok hook event schemas are unavailable and cite grok.ts", () => {
    const grok = PROVIDER_MANIFESTS["grok-tui"];
    for (const role of [
      "session-start",
      "turn-start",
      "turn-end",
      "tool-boundary",
      "notification",
    ] as const) {
      const event = grok.eventSchemas.find((e) => e.role === role);
      expect(event?.available).toBe(false);
      expect(
        event?.sourceCitations.some((c) => c.includes("grok.ts")),
      ).toBe(true);
    }
  });

  test("versionRange pins supportedMin/Max, not only measured examples", () => {
    for (const manifest of allProviderManifests()) {
      expect(manifest.versionRange.supportedMin).toBeTruthy();
      expect(manifest.versionRange.supportedMax).toBeTruthy();
      expect(manifest.versionRange.sourceCitations.length).toBeGreaterThan(0);
    }
  });
});

describe("WP8 attempt-context receipt ladder (§25)", () => {
  const session = "ses-1";
  const baseAttempt: AttemptContext = {
    attemptId: "txn-1",
    committed: true,
    providerSessionId: session,
    committedAt: "2026-07-16T12:00:00.000Z",
  };
  const laterBoundary = {
    kind: "turn-start",
    agentName: "w",
    timestamp: "2026-07-16T12:00:02.000Z",
    toolSessionId: session,
    processHealth: "alive",
  };

  test("without attempt context, receipt stays evidence-absent even with a boundary", () => {
    const evidence = classifyProviderObservation("claude-tui", laterBoundary);
    expect(evidence.readiness).toBe("busy");
    expect(evidence.receipt).toBe("evidence-absent");
    expect(evidence.receipt).not.toBe("provider-observed");
  });

  test("provider-observed requires committed + same session + later timestamp", () => {
    expect(
      classifyProviderObservation("claude-tui", laterBoundary, baseAttempt).receipt,
    ).toBe("provider-observed");

    expect(
      classifyProviderObservation("claude-tui", laterBoundary, {
        ...baseAttempt,
        committed: false,
      }).receipt,
    ).toBe("evidence-absent");

    expect(
      classifyProviderObservation("claude-tui", laterBoundary, {
        ...baseAttempt,
        providerSessionId: "other-session",
      }).receipt,
    ).toBe("evidence-absent");

    expect(
      classifyProviderObservation("claude-tui", {
        ...laterBoundary,
        timestamp: "2026-07-16T11:59:00.000Z",
      }, baseAttempt).receipt,
    ).toBe("evidence-absent");
  });

  test("death without committed attempt is disconnected, not attempt-in-doubt", () => {
    const dead = {
      kind: "dead",
      agentName: "w",
      timestamp: "2026-07-16T12:00:03.000Z",
      toolSessionId: session,
    };
    const noAttempt = classifyProviderObservation("claude-tui", dead);
    expect(noAttempt.readiness).toBe("disconnected");
    expect(noAttempt.receipt).toBe("evidence-absent");
    expect(noAttempt.receipt).not.toBe("attempt-in-doubt");

    const withAttempt = classifyProviderObservation(
      "claude-tui",
      dead,
      baseAttempt,
    );
    expect(withAttempt.readiness).toBe("disconnected");
    expect(withAttempt.receipt).toBe("attempt-in-doubt");
  });
});

describe("WP8 readiness prerequisites (§25)", () => {
  test("Claude ready needs processHealth, toolSessionId, unresolvedModal=false", () => {
    const incomplete = {
      kind: "turn-end",
      agentName: "w",
      timestamp: "2026-07-16T12:00:02.000Z",
    };
    expect(classifyProviderObservation("claude-tui", incomplete).readiness)
      .toBe("evidence-absent");

    const full = {
      kind: "turn-end",
      agentName: "w",
      timestamp: "2026-07-16T12:00:02.000Z",
      toolSessionId: "s",
      processHealth: "alive",
      unresolvedModal: false,
    };
    expect(classifyProviderObservation("claude-tui", full).readiness).toBe("ready");
  });

  test("app-server busy/ready requires params.turn.id and thread identity", () => {
    expect(
      classifyProviderObservation("codex-app-server", {
        method: "turn/started",
        timestamp: "2026-07-16T12:00:02.000Z",
        params: { threadId: "th" },
      }).readiness,
    ).toBe("evidence-absent");

    expect(
      classifyProviderObservation("codex-app-server", {
        method: "turn/started",
        timestamp: "2026-07-16T12:00:02.000Z",
        params: { turn: { id: "t1" }, threadId: "th" },
      }).readiness,
    ).toBe("busy");
  });

  test("Grok ready/busy requires processState, sessionId, and activity advancement", () => {
    expect(
      classifyProviderObservation("grok-tui", {
        processState: "alive",
        turnCompleted: true,
      }).readiness,
    ).toBe("evidence-absent");

    expect(
      classifyProviderObservation("grok-tui", {
        processState: "alive",
        sessionId: "g",
        lastActivityAt: "2026-07-16T12:00:02.000Z",
        turnCompleted: true,
      }).readiness,
    ).toBe("evidence-absent");

    expect(
      classifyProviderObservation("grok-tui", {
        processState: "alive",
        sessionId: "g",
        previousLastActivityAt: "2026-07-16T12:00:00.000Z",
        lastActivityAt: "2026-07-16T12:00:02.000Z",
        turnCompleted: true,
        timestamp: "2026-07-16T12:00:02.000Z",
      }).readiness,
    ).toBe("ready");
  });
});

describe("WP8 TG4 scenario corpus", () => {
  test("corpus covers every surface × scenario exactly once", () => {
    const keys = TG4_SCENARIO_FIXTURES.map((f) => `${f.surface}:${f.scenario}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const surface of PROVIDER_SURFACE_IDS) {
      for (const scenario of TG4_SCENARIOS) {
        expect(keys).toContain(`${surface}:${scenario}`);
      }
    }
  });

  test("classifications match §25-derived expectations (not fixture self-enums)", () => {
    for (const fixture of TG4_SCENARIO_FIXTURES) {
      const expected = section25Expectation(fixture.surface, fixture.scenario);
      const evidence = classifyProviderObservation(
        fixture.surface,
        fixture.observation,
        fixture.attempt,
      );
      expect(evidence.readiness).toBe(expected.readiness);
      expect(evidence.receipt).toBe(expected.receipt);
      if (fixture.scenario === "modal" && fixture.surface === "claude-tui") {
        expect(evidence.readiness).toBe("blocked-unknown");
        expect(evidence.readiness).not.toBe("ready");
      }
    }
  });

  test("positive controls: misspelled/missing keys are evidence-absent; correct keys classify", () => {
    for (const control of ABSENT_FIELD_CONTROLS) {
      const miss = classifyProviderObservation(
        control.surface,
        control.misspelled,
        control.attempt,
      );
      expect(miss.readiness).toBe("evidence-absent");

      const hit = classifyProviderObservation(
        control.surface,
        control.correctlySpelled,
        control.attempt,
      );
      expect(hit.readiness).not.toBe("evidence-absent");
    }
  });

  test("Grok hook probes are capability-absent", () => {
    for (const probe of GROK_HOOK_ABSENCE_PROBES) {
      const evidence = classifyProviderObservation("grok-tui", {
        capabilityProbe: probe,
      });
      expect(evidence.readiness).toBe("capability-absent");
    }
  });

  test("permission_prompt is awaiting-approval", () => {
    const evidence = classifyProviderObservation("claude-tui", {
      kind: "notification",
      agentName: "w",
      timestamp: "2026-07-16T12:00:00.000Z",
      notificationType: CLAUDE_PERMISSION_PROMPT_TYPE,
    });
    expect(evidence.readiness).toBe("awaiting-approval");
  });
});

describe("WP8 TG4 conformance report (collector-derived)", () => {
  test("report is schema-valid and covers all surfaces and receipt levels", () => {
    const report = ProviderConformanceReportSchema.parse(
      buildProviderConformanceReport(),
    );
    expect(report.derivedFrom).toContain("classifyProviderObservation");
    expect(report.surfaces.map((s) => s.surface).sort()).toEqual(
      [...PROVIDER_SURFACE_IDS].sort(),
    );
    for (const surface of report.surfaces) {
      expect(surface.receipt.map((r) => r.level).sort()).toEqual(
        [...TERMINAL_RECEIPT_LEVELS].sort(),
      );
    }
  });

  test("every provable-today row has a collectorPath from a real emission", () => {
    for (const surface of PROVIDER_CONFORMANCE_REPORT.surfaces) {
      for (const row of surface.readiness) {
        if (row.status === "provable-today") {
          expect(row.collectorPath).not.toBeNull();
        }
      }
      for (const row of surface.receipt) {
        if (row.status === "provable-today") {
          expect(row.collectorPath).not.toBeNull();
        }
      }
    }
  });

  test("transport-written is unavailable on all surfaces (collector never emits it)", () => {
    for (const surface of PROVIDER_CONFORMANCE_REPORT.surfaces) {
      const tw = surface.receipt.find((r) => r.level === "transport-written")!;
      expect(tw.status).toBe("unavailable");
      expect(tw.collectorPath).toBeNull();
    }
  });

  test("Grok awaiting-approval and turn-boundary are unavailable", () => {
    const grok = PROVIDER_CONFORMANCE_REPORT.surfaces.find(
      (s) => s.surface === "grok-tui",
    )!;
    expect(grok.readiness.find((r) => r.kind === "turn-boundary")?.status)
      .toBe("unavailable");
    expect(grok.readiness.find((r) => r.kind === "awaiting-approval")?.status)
      .toBe("unavailable");
  });

  test("codex-tui awaiting-approval is unavailable (capability-absent, not provable)", () => {
    const codex = PROVIDER_CONFORMANCE_REPORT.surfaces.find(
      (s) => s.surface === "codex-tui",
    )!;
    // capability-absent is provable; awaiting-approval is not emitted as readiness
    expect(codex.readiness.find((r) => r.kind === "awaiting-approval")?.status)
      .toBe("unavailable");
    expect(codex.readiness.find((r) => r.kind === "capability-absent")?.status)
      .toBe("provable-today");
  });

  test("report matches live rebuild (no stale hand-authored rows)", () => {
    expect(PROVIDER_CONFORMANCE_REPORT).toEqual(buildProviderConformanceReport());
  });
});
