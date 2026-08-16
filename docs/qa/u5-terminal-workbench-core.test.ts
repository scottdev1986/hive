import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
} from "../../src/schemas/capability";
import {
  classifyViewerReadback,
  finalU5Result,
  reconcileSpawnRequests,
  requireU5WorkspaceApp,
  resolveU5Scope,
  summarizeProviderOutcomes,
  U5_FULL_SCOPE,
  U5_PARTIAL_SCOPE,
  type U5ProviderOutcome,
  type U5SpawnRequest,
} from "./u5-terminal-workbench-core";

function outcomes(
  values: Readonly<Record<CapabilityProvider, U5ProviderOutcome>>,
): ReadonlyMap<CapabilityProvider, U5ProviderOutcome> {
  return new Map(
    CAPABILITY_PROVIDERS.map((provider) => [provider, values[provider]]),
  );
}

describe("U5 proof decisions", () => {
  test("requires an externally supplied Workspace app", () => {
    expect(() => requireU5WorkspaceApp({})).toThrow(
      "prebuilt Workspace app; the rig never invokes make run",
    );
    expect(() =>
      requireU5WorkspaceApp({
        HIVE_QA_U5_APP_EXECUTABLE: "/tmp/HiveWorkspace",
        HIVE_QA_U5_APP_READY_PATH: "/tmp/ready",
      }),
    ).toThrow("HIVE_QA_U5_APP_RELEASE_PATH");
    expect(
      requireU5WorkspaceApp({
        HIVE_QA_U5_APP_EXECUTABLE:
          "/tmp/HiveWorkspace.app/Contents/MacOS/HiveWorkspace",
        HIVE_QA_U5_APP_READY_PATH: "/tmp/ready",
        HIVE_QA_U5_APP_RELEASE_PATH: "/tmp/release",
        HIVE_QA_U5_APP_FEED_RECEIPT: "/tmp/feed-receipt",
      }),
    ).toEqual({
      executablePath: "/tmp/HiveWorkspace.app/Contents/MacOS/HiveWorkspace",
      readyPath: "/tmp/ready",
      releasePath: "/tmp/release",
      feedReceiptPath: "/tmp/feed-receipt",
    });
  });

  test("keeps incomplete auxiliary viewer readback unclaimed", () => {
    expect(classifyViewerReadback("complete", "visible terminal")).toEqual({
      state: "observed-complete",
      completeness: "complete",
      nonEmptyScreen: true,
    });
    expect(classifyViewerReadback("gap", "")).toEqual({
      state: "not-established",
      completeness: "gap",
      nonEmptyScreen: false,
      reason:
        "the auxiliary readback client does not decode checkpoint snapshots; replay completeness is unclaimed",
    });
    expect(classifyViewerReadback("gap", "visible fragment")).toMatchObject({
      state: "not-established",
      completeness: "gap",
      nonEmptyScreen: true,
    });
    expect(classifyViewerReadback("complete", " \n\t")).toMatchObject({
      state: "not-established",
      completeness: "complete",
      nonEmptyScreen: false,
    });
  });

  test("defaults to all five live providers", () => {
    expect(resolveU5Scope(undefined)).toEqual({
      scope: U5_FULL_SCOPE,
      scopedPartial: false,
      attemptProviders: [...CAPABILITY_PROVIDERS],
    });
    expect(resolveU5Scope(U5_PARTIAL_SCOPE)).toEqual({
      scope: U5_PARTIAL_SCOPE,
      scopedPartial: true,
      attemptProviders: ["claude", "codex", "opencode", "grok", "kimi"],
    });
    expect(() => resolveU5Scope("three-live-v1")).toThrow(
      "unsupported HIVE_QA_U5_SCOPE",
    );
  });

  test("a blocked provider cannot yield an overall pass", () => {
    const plan = resolveU5Scope(U5_PARTIAL_SCOPE);
    for (const blocked of [
      "quota-blocked",
      "schema-blocked",
      "launch-refused",
    ] as const) {
      const proof = summarizeProviderOutcomes(
        plan.attemptProviders,
        outcomes({
          claude: "attested",
          codex: "attested",
          opencode: "attested",
          grok: blocked,
          kimi: "attested",
        }),
      );

      expect(proof).toMatchObject({
        result: "partial",
        acceptance: "not-met",
        attestedProviders: ["claude", "codex", "opencode", "kimi"],
        blockedProviders: ["grok"],
      });
      expect(finalU5Result(proof.result, "clean", "restored")).toEqual({
        result: "partial",
        acceptance: "not-met",
        exitCode: 1,
      });
    }

    const twoBlocks = summarizeProviderOutcomes(
      plan.attemptProviders,
      outcomes({
        claude: "attested",
        codex: "attested",
        opencode: "attested",
        grok: "quota-blocked",
        kimi: "schema-blocked",
      }),
    );
    expect(twoBlocks).toMatchObject({
      result: "partial",
      acceptance: "not-met",
      attestedProviders: ["claude", "codex", "opencode"],
      blockedProviders: ["grok", "kimi"],
    });
  });

  test("passes only when every canonical provider is attested", () => {
    const plan = resolveU5Scope(undefined);
    const proof = summarizeProviderOutcomes(
      plan.attemptProviders,
      outcomes({
        claude: "attested",
        codex: "attested",
        grok: "attested",
        kimi: "attested",
        opencode: "attested",
      }),
    );

    expect(proof.result).toBe("passed");
    expect(finalU5Result(proof.result, "clean", "restored")).toEqual({
      result: "passed",
      acceptance: "met",
      exitCode: 0,
    });
  });
});

describe("U5 spawn cleanup reconciliation", () => {
  const admittedRows = ["claude-id", "codex-id", "opencode-id"].map((id) => ({
    id,
    taskDescription: `live ${id}`,
  }));
  const requests: U5SpawnRequest[] = [
    {
      provider: "claude",
      marker: "PROVIDER_claude",
      state: "admitted",
      admissionId: "claude-id",
    },
    {
      provider: "codex",
      marker: "PROVIDER_codex",
      state: "admitted",
      admissionId: "codex-id",
    },
    {
      provider: "opencode",
      marker: "PROVIDER_opencode",
      state: "admitted",
      admissionId: "opencode-id",
    },
    {
      provider: "grok",
      marker: "PROVIDER_grok",
      state: "refused",
      refusalReadback: { state: "absent" },
    },
    {
      provider: "kimi",
      marker: "PROVIDER_kimi",
      state: "refused",
      refusalReadback: { state: "absent" },
    },
  ];

  test("reconciles admitted IDs and refused readbacks instead of request count", () => {
    expect(reconcileSpawnRequests(requests, admittedRows)).toMatchObject({
      complete: true,
      requestCount: 5,
      admittedIds: ["claude-id", "codex-id", "opencode-id"],
      missingAdmissionIds: [],
      refusedSideEffectIds: [],
      unknownProviders: [],
      refusalReadbacksComplete: true,
    });
    expect(admittedRows).toHaveLength(3);
  });

  test("keeps every unresolved cleanup fact non-clean", () => {
    expect(
      reconcileSpawnRequests(requests, admittedRows.slice(1)).complete,
    ).toBeFalse();

    const unreadRefusal = requests.map((request) =>
      request.provider === "grok"
        ? { ...request, refusalReadback: { state: "unknown" } }
        : request,
    );
    expect(
      reconcileSpawnRequests(unreadRefusal, admittedRows).complete,
    ).toBeFalse();

    const refusedSideEffect = [
      ...admittedRows,
      { id: "grok-side-effect", taskDescription: "live PROVIDER_grok" },
    ];
    expect(
      reconcileSpawnRequests(requests, refusedSideEffect).complete,
    ).toBeFalse();

    const pending = requests.map((request) =>
      request.provider === "kimi"
        ? { ...request, state: "pending" as const }
        : request,
    );
    expect(reconcileSpawnRequests(pending, admittedRows).complete).toBeFalse();

    const admissionWithoutId = requests.map((request) =>
      request.provider === "claude"
        ? { ...request, admissionId: undefined }
        : request,
    );
    expect(
      reconcileSpawnRequests(admissionWithoutId, admittedRows).complete,
    ).toBeFalse();
  });
});
