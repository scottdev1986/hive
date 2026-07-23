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
} from "../../../src/schemas/provider-manifest";
import {
  allProviderManifests,
  collectManifestCitationPaths,
  PROVIDER_MANIFESTS,
} from "../../../src/adapters/tools/provider-manifests";
import {
  classifyProviderObservation,
  parseAttemptContext,
  receiptForBoundary,
  receiptForLostBoundary,
  CLAUDE_PERMISSION_PROMPT_TYPE,
} from "../../../src/adapters/tools/provider-evidence";
import {
  adapterEvidenceIsStructurallyGrounded,
  buildProviderConformanceReport,
  PROVIDER_CONFORMANCE_REPORT,
} from "../../../src/adapters/tools/provider-conformance-report";
import {
  ABSENT_FIELD_CONTROLS,
  ADAPTER_EVIDENCE_SURFACE_FILES,
  CONFORMANCE_PROBES,
  EMITTABLE_PROBES,
  GROK_HOOK_ABSENCE_PROBES,
  IN_DOUBT_NEGATIVE_CONTROLS,
  TG4_SCENARIO_FIXTURES,
  attemptFor,
  hasRequiredEvidenceGrounding,
} from "../../../src/adapters/tools/__fixtures__/tg4/corpus";

/**
 * §25-derived expectations — not self-enums on fixtures.
 */
function section25Expectation(
  surface: ProviderSurfaceId,
  scenario: (typeof TG4_SCENARIOS)[number],
): { readiness: ReadinessEvidenceKind; receipt: ReceiptEvidenceKind } {
  switch (surface) {
    case "claude-tui":
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
    case "codex-tui":
      switch (scenario) {
        case "idle":
          return { readiness: "ready", receipt: "provider-observed" };
        case "busy":
          return { readiness: "busy", receipt: "provider-observed" };
        case "approval":
        case "modal":
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
          // summary.json mtime advance is artifact activity, not idle/ready.
          return { readiness: "evidence-absent", receipt: "provider-observed" };
        case "busy":
          // no turn stream in grok.ts
          return { readiness: "capability-absent", receipt: "capability-absent" };
        case "approval":
        case "modal":
          return { readiness: "capability-absent", receipt: "capability-absent" };
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
      expect(manifest.versionRange.supportedMin.length).toBeGreaterThan(0);
      expect(manifest.versionRange.supportedMax.length).toBeGreaterThan(0);
    }
  });

  test("every grounded manifest field carries non-empty sourceCitations", () => {
    for (const manifest of allProviderManifests()) {
      const paths = collectManifestCitationPaths(manifest);
      const pathNames = paths.map((p) => p.path);
      for (const required of [
        "versionRange",
        "readinessStates",
        "strongestAutomaticReceipt",
        "unknownModalBlocksDelivery",
        "capabilityAbsences",
        "fixtureSet",
        "launchArgv",
      ]) {
        expect(pathNames).toContain(required);
      }
      for (const row of paths) {
        expect(row.citations.length).toBeGreaterThan(0);
      }
    }
  });

  test("codex-tui does not claim awaiting-approval", () => {
    expect(PROVIDER_MANIFESTS["codex-tui"].readinessStates.value)
      .not.toContain("awaiting-approval");
  });

  test("Grok marks ready and turn stream unavailable; summary mtime is activity", () => {
    const grok = PROVIDER_MANIFESTS["grok-tui"];
    const updates = grok.eventSchemas.find((e) => e.id === "hive.grok.updates-jsonl");
    expect(updates?.available).toBe(false);
    expect(updates?.sourceCitations.some((c) => c.includes("grok.ts"))).toBe(true);
    const summary = grok.eventSchemas.find((e) => e.id === "hive.grok.summary-mtime");
    expect(summary?.available).toBe(true);
    expect(summary?.sourceCitations.some((c) => c.includes("grok.ts:"))).toBe(true);
    expect(grok.readinessStates.value).not.toContain("ready");
    expect(grok.readinessStates.value).not.toContain("busy");
    expect(
      grok.eventSchemas.find((e) => e.id === "hive.grok.preassigned-session")
        ?.role,
    ).toBe("session-identity");
  });
});

describe("WP8 attempt-context fail-closed", () => {
  const session = "ses-1";
  const validAttempt: AttemptContext = {
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

  test("parseAttemptContext accepts valid attempt and rejects misspelled keys", () => {
    expect(parseAttemptContext(validAttempt)).toEqual(validAttempt);
    // misspelled attemptId key
    expect(
      parseAttemptContext({
        atemptId: "txn-1",
        committed: true,
        providerSessionId: session,
        committedAt: validAttempt.committedAt,
      }),
    ).toBeUndefined();
    // missing attemptId
    expect(
      parseAttemptContext({
        committed: true,
        providerSessionId: session,
        committedAt: validAttempt.committedAt,
      }),
    ).toBeUndefined();
  });

  test("misspelled attemptId with committed=true never upgrades receipt", () => {
    const broken = {
      atemptId: "txn-1",
      committed: true,
      providerSessionId: session,
      committedAt: validAttempt.committedAt,
    };
    const evidence = classifyProviderObservation(
      "claude-tui",
      laterBoundary,
      broken,
    );
    expect(evidence.readiness).toBe("busy");
    expect(evidence.receipt).toBe("evidence-absent");
    expect(evidence.receipt).not.toBe("provider-observed");

    // positive control: same observation with valid attempt upgrades
    const good = classifyProviderObservation(
      "claude-tui",
      laterBoundary,
      validAttempt,
    );
    expect(good.receipt).toBe("provider-observed");
  });

  test("exported receipt helpers parse misspelled attempt keys fail-closed", () => {
    const broken = {
      atemptId: "txn-1",
      committed: true,
      providerSessionId: session,
      committedAt: validAttempt.committedAt,
    };
    const observedAt = "2026-07-16T12:00:02.000Z";

    expect(receiptForBoundary(broken, session, observedAt).receipt)
      .toBe("evidence-absent");
    expect(receiptForLostBoundary(broken, session, observedAt).receipt)
      .toBe("evidence-absent");

    expect(receiptForBoundary(validAttempt, session, observedAt).receipt)
      .toBe("provider-observed");
    expect(receiptForLostBoundary(validAttempt, session, observedAt).receipt)
      .toBe("attempt-in-doubt");
  });

  test("without attempt context, receipt stays evidence-absent", () => {
    const evidence = classifyProviderObservation("claude-tui", laterBoundary);
    expect(evidence.receipt).toBe("evidence-absent");
  });

  test("provider-observed requires committed + same session + later timestamp", () => {
    expect(
      classifyProviderObservation("claude-tui", laterBoundary, validAttempt)
        .receipt,
    ).toBe("provider-observed");
    expect(
      classifyProviderObservation("claude-tui", laterBoundary, {
        ...validAttempt,
        committed: false,
      }).receipt,
    ).toBe("evidence-absent");
  });
});

describe("WP8 attempt-in-doubt strict prerequisites", () => {
  test("in-doubt requires nonempty session equality and loss timestamp >= commit", () => {
    const good = classifyProviderObservation(
      "claude-tui",
      {
        kind: "dead",
        agentName: "w",
        timestamp: "2026-07-16T12:00:03.000Z",
        toolSessionId: "ses-1",
      },
      attemptFor("ses-1", "2026-07-16T12:00:01.000Z"),
    );
    expect(good.readiness).toBe("disconnected");
    expect(good.receipt).toBe("attempt-in-doubt");
  });

  test("negative controls never upgrade to attempt-in-doubt", () => {
    for (const control of IN_DOUBT_NEGATIVE_CONTROLS) {
      const evidence = classifyProviderObservation(
        control.surface,
        control.observation,
        control.attempt,
      );
      expect(evidence.readiness).toBe("disconnected");
      expect(evidence.receipt).toBe("evidence-absent");
      expect(evidence.receipt).not.toBe("attempt-in-doubt");
    }
  });

  test("death without any attempt is disconnected, not in-doubt", () => {
    const evidence = classifyProviderObservation("claude-tui", {
      kind: "dead",
      agentName: "w",
      timestamp: "2026-07-16T12:00:03.000Z",
      toolSessionId: "ses-1",
    });
    expect(evidence.receipt).toBe("evidence-absent");
  });
});

describe("WP8 readiness prerequisites", () => {
  test("Claude ready needs processHealth, toolSessionId, unresolvedModal=false", () => {
    expect(
      classifyProviderObservation("claude-tui", {
        kind: "turn-end",
        timestamp: "2026-07-16T12:00:02.000Z",
      }).readiness,
    ).toBe("evidence-absent");
    expect(
      classifyProviderObservation("claude-tui", {
        kind: "turn-end",
        timestamp: "2026-07-16T12:00:02.000Z",
        toolSessionId: "s",
        processHealth: "alive",
        unresolvedModal: false,
      }).readiness,
    ).toBe("ready");
  });

  test("app-server requires params.turn.id", () => {
    expect(
      classifyProviderObservation("codex-app-server", {
        method: "turn/started",
        timestamp: "2026-07-16T12:00:02.000Z",
        params: { threadId: "th" },
      }).readiness,
    ).toBe("evidence-absent");
  });

  test("Grok summary mtime proves activity receipt, never ready", () => {
    expect(
      classifyProviderObservation("grok-tui", {
        processState: "alive",
        sessionId: "g",
        turnCompleted: true,
      }).readiness,
    ).toBe("evidence-absent");

    const activity = classifyProviderObservation(
      "grok-tui",
      {
        processState: "alive",
        sessionId: "g",
        summaryLocated: true,
        previousSummaryMtimeMs: 1,
        summaryMtimeMs: 2,
        timestamp: "2026-07-16T12:00:02.000Z",
      },
      attemptFor("g", "2026-07-16T12:00:01.000Z"),
    );
    expect(activity.readiness).toBe("evidence-absent");
    expect(activity.receipt).toBe("provider-observed");

    const withoutAttempt = classifyProviderObservation("grok-tui", {
      processState: "alive",
      sessionId: "g",
      summaryLocated: true,
      previousSummaryMtimeMs: 1,
      summaryMtimeMs: 2,
      timestamp: "2026-07-16T12:00:02.000Z",
    });
    expect(withoutAttempt.receipt).toBe("evidence-absent");
  });
});

describe("WP8 TG4 scenario corpus", () => {
  test("corpus covers every surface × scenario once with source citations", () => {
    const keys = TG4_SCENARIO_FIXTURES.map((f) => `${f.surface}:${f.scenario}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const surface of PROVIDER_SURFACE_IDS) {
      for (const scenario of TG4_SCENARIOS) {
        expect(keys).toContain(`${surface}:${scenario}`);
      }
    }
    for (const fixture of TG4_SCENARIO_FIXTURES) {
      expect(fixture.sourceCitations.length).toBeGreaterThan(0);
    }
  });

  test("no codex-tui fixture fabricates Notification or approval-request payloads", () => {
    for (const fixture of TG4_SCENARIO_FIXTURES.filter(
      (f) => f.surface === "codex-tui",
    )) {
      const obs = fixture.observation as Record<string, unknown>;
      expect(obs.kind).not.toBe("notification");
      expect(obs.kind).not.toBe("approval-request");
      if (fixture.scenario === "approval" || fixture.scenario === "modal") {
        expect(obs.capabilityProbe).toBeDefined();
      }
    }
  });

  test("Grok approval and modal use distinct capability probes", () => {
    const approval = TG4_SCENARIO_FIXTURES.find(
      (f) => f.surface === "grok-tui" && f.scenario === "approval",
    )!;
    const modal = TG4_SCENARIO_FIXTURES.find(
      (f) => f.surface === "grok-tui" && f.scenario === "modal",
    )!;
    const a = (approval.observation as { capabilityProbe: string }).capabilityProbe;
    const m = (modal.observation as { capabilityProbe: string }).capabilityProbe;
    expect(a).toBe("structured-approval");
    expect(m).toBe("structured-modal");
    expect(a).not.toBe(m);
  });

  test("classifications match §25-derived expectations", () => {
    for (const fixture of TG4_SCENARIO_FIXTURES) {
      const expected = section25Expectation(fixture.surface, fixture.scenario);
      const evidence = classifyProviderObservation(
        fixture.surface,
        fixture.observation,
        fixture.attempt,
      );
      expect(evidence.readiness).toBe(expected.readiness);
      expect(evidence.receipt).toBe(expected.receipt);
    }
  });

  test("positive controls for misspelled keys", () => {
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
      expect(
        hit.readiness !== "evidence-absent" ||
          hit.receipt !== "evidence-absent",
      ).toBe(true);
    }
  });

  test("Grok capability probes are capability-absent", () => {
    for (const probe of GROK_HOOK_ABSENCE_PROBES) {
      expect(
        classifyProviderObservation("grok-tui", { capabilityProbe: probe })
          .readiness,
      ).toBe("capability-absent");
    }
  });

  test("permission_prompt is awaiting-approval", () => {
    expect(
      classifyProviderObservation("claude-tui", {
        kind: "notification",
        timestamp: "2026-07-16T12:00:00.000Z",
        notificationType: CLAUDE_PERMISSION_PROMPT_TYPE,
      }).readiness,
    ).toBe("awaiting-approval");
  });
});

describe("WP8 emittable probes and conformance report", () => {
  test("adapter-origin probes cite and structurally validate the named adapter surface", () => {
    expect(CONFORMANCE_PROBES.length).toBeGreaterThan(0);
    expect(CONFORMANCE_PROBES.length).toBe(EMITTABLE_PROBES.length);
    for (const probe of CONFORMANCE_PROBES) {
      expect(hasRequiredEvidenceGrounding(probe)).toBe(true);
      if (probe.evidenceOrigins.includes("adapter")) {
        expect(probe.adapterSurface).toBeDefined();
        const adapterFile = ADAPTER_EVIDENCE_SURFACE_FILES[probe.adapterSurface!];
        expect(
          probe.sourceCitations.some((citation) =>
            citation.startsWith(`${adapterFile}:`)
          ),
        ).toBe(true);
        expect(adapterEvidenceIsStructurallyGrounded(probe)).toBe(true);
      }
    }

    const adapterProbe = CONFORMANCE_PROBES.find((probe) =>
      probe.evidenceOrigins.includes("adapter")
    )!;
    expect(
      adapterEvidenceIsStructurallyGrounded({
        ...adapterProbe,
        sourceCitations: ["src/schemas/event.ts:1-70"],
      }),
    ).toBe(false);
  });

  test("TG4 fixtures declare host versus adapter evidence origins", () => {
    for (const fixture of TG4_SCENARIO_FIXTURES) {
      expect(hasRequiredEvidenceGrounding(fixture)).toBe(true);
      expect(adapterEvidenceIsStructurallyGrounded(fixture)).toBe(true);
    }
  });

  test("report is schema-valid and transport-written unavailable", () => {
    const report = ProviderConformanceReportSchema.parse(
      buildProviderConformanceReport(),
    );
    expect(report.derivedFrom).toContain("emittable");
    for (const surface of report.surfaces) {
      expect(surface.receipt.map((r) => r.level).sort()).toEqual(
        [...TERMINAL_RECEIPT_LEVELS].sort(),
      );
      const tw = surface.receipt.find((r) => r.level === "transport-written")!;
      expect(tw.status).toBe("unavailable");
    }
  });

  test("provable-today rows come from emittable probes with citations, not collector alone", () => {
    for (const surface of PROVIDER_CONFORMANCE_REPORT.surfaces) {
      for (const row of surface.readiness) {
        if (row.status === "provable-today") {
          expect(row.evidence).toContain("emittable probe");
          expect(row.evidence).toMatch(/cited /);
          expect(row.evidenceOrigins.length).toBeGreaterThan(0);
          if (row.evidenceOrigins.includes("adapter")) {
            expect(row.evidence).toContain("adapter source structurally validated");
          }
        } else {
          expect(row.evidenceOrigins).toEqual([]);
        }
      }
      for (const row of surface.receipt) {
        if (row.status === "provable-today") {
          expect(row.evidence).toContain("emittable probe");
          expect(row.evidence).toMatch(/cited /);
          expect(row.evidenceOrigins.length).toBeGreaterThan(0);
          if (row.evidenceOrigins.includes("adapter")) {
            expect(row.evidence).toContain("adapter source structurally validated");
          }
        } else {
          expect(row.evidenceOrigins).toEqual([]);
        }
      }
    }
  });

  test("Grok busy, awaiting-approval, and ready are unavailable", () => {
    const grok = PROVIDER_CONFORMANCE_REPORT.surfaces.find(
      (s) => s.surface === "grok-tui",
    )!;
    expect(grok.readiness.find((r) => r.kind === "busy")?.status)
      .toBe("unavailable");
    expect(grok.readiness.find((r) => r.kind === "awaiting-approval")?.status)
      .toBe("unavailable");
    expect(grok.readiness.find((r) => r.kind === "ready")?.status)
      .toBe("unavailable");
  });

  test("report matches live rebuild", () => {
    expect(PROVIDER_CONFORMANCE_REPORT).toEqual(buildProviderConformanceReport());
  });
});
