import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { ManifestJournal } from "../../src/daemon/manifest-journal";
import {
  buildQueenProviderProjection,
  QueenProviderConflictError,
  QueenProviderControlStore,
  terminationFailureDetail,
  vendorAvailabilityReader,
} from "../../src/daemon/queen-provider-service/projection";
import { SuccessionService } from "../../src/daemon/queen-provider-service/succession";
import { MailStore } from "../../src/mail-service/store";
import {
  QueenProviderProjectionSchema,
  QueenProviderReceiptSchema,
  SetLiveQueenProviderConflictSchema,
  SetLiveQueenProviderResponseSchema,
} from "../../src/schemas/queen-provider";

function store(): QueenProviderControlStore {
  return new QueenProviderControlStore(new HiveDatabase(":memory:"));
}

const ALL_AVAILABLE = {
  claude: { available: true },
  codex: { available: true },
  grok: { available: true },
  kimi: { available: true },
  opencode: { available: true },
} as const;

describe("queen provider control store", () => {
  test("a fresh instance is idle at revision 0 with no steer", () => {
    const control = store();
    const state = control.read();
    expect(state).toMatchObject({ revision: "0", state: "idle" });
    expect(control.launchTool()).toBeNull();
  });

  test("a stored revision the wire would reject fails the read", () => {
    const db = new HiveDatabase(":memory:");
    const control = new QueenProviderControlStore(db);
    const persist = (revision: string) => {
      db.database
        .query(
          "INSERT INTO meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(
          "queen-provider-control",
          JSON.stringify({
            version: 1,
            revision,
            state: "idle",
            desired: null,
            prior: null,
            operationId: null,
            failure: null,
            updatedAt: "2026-08-09T00:00:00.000Z",
          }),
        );
    };
    // Positive control: the shape this store writes still reads back.
    persist("7");
    expect(control.read()).toMatchObject({ revision: "7" });
    // A leading zero and an over-64-bit value are both revisions a client
    // could never send back through SetLiveQueenProviderRequestSchema.
    persist("007");
    expect(() => control.read()).toThrow();
    persist("18446744073709551616");
    expect(() => control.read()).toThrow();
  });

  test("compare-and-set accepts only the current revision", () => {
    const control = store();
    const receipt = control.accept("grok", "0", "claude");
    expect(receipt.revision).toEqual("1");
    expect(QueenProviderReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(control.read()).toMatchObject({
      state: "pending",
      desired: "grok",
      prior: "claude",
    });
    expect(control.launchTool()).toEqual("grok");

    expect(() => control.accept("kimi", "0", "claude")).toThrow(
      QueenProviderConflictError,
    );
    // The conflict changed nothing.
    expect(control.read()).toMatchObject({ revision: "1", desired: "grok" });
  });

  test("only observation of the desired provider flips pending to idle", () => {
    const control = store();
    control.accept("grok", "0", "claude");
    // The old queen still running is not completion.
    control.reconcileObserved("claude");
    expect(control.read().state).toEqual("pending");
    // No queen at all (the terminate half-way point) is not completion.
    control.reconcileObserved(null);
    expect(control.read().state).toEqual("pending");
    control.reconcileObserved("grok");
    expect(control.read()).toMatchObject({
      state: "idle",
      desired: null,
      prior: "grok",
      failure: null,
    });
  });

  test("a failed change preserves the prior queen and stays visible", () => {
    const control = store();
    control.accept("codex", "0", "claude");
    control.accept("kimi", "1", "codex");
    control.reportLaunchFailure("kimi", "kimi CLI is broken");
    const failed = control.read();
    expect(failed.state).toEqual("failed");
    expect(failed.failure).toEqual("kimi CLI is broken");
    // The steer goes back to the provider that was live when the change was
    // accepted — relaunching it is the preservation.
    expect(control.launchTool()).toEqual("codex");
    // Observation of the preserved queen does not clear the failure; only
    // the next accepted change does.
    control.reconcileObserved("codex");
    expect(control.read().state).toEqual("failed");
    const receipt = control.accept("grok", "2", "codex");
    expect(receipt.revision).toEqual("3");
    expect(control.read()).toMatchObject({ state: "pending", failure: null });
  });

  test("a failure of the preserving relaunch itself is appended, not lost", () => {
    const control = store();
    control.accept("kimi", "0", "claude");
    control.reportLaunchFailure("kimi", "kimi CLI is broken");
    control.reportLaunchFailure("claude", "claude also gone");
    expect(control.read().failure).toEqual(
      "kimi CLI is broken; preserving claude also failed: claude also gone",
    );
  });

  test("a failure report for a provider nobody asked about changes nothing", () => {
    const control = store();
    control.accept("grok", "0", "claude");
    control.reportLaunchFailure("opencode", "not the pending provider");
    expect(control.read().state).toEqual("pending");
  });
});

describe("termination verdict discrimination", () => {
  test("only a survivors verdict fails a change; unknown and terminated defer to observation", () => {
    expect(
      terminationFailureDetail({ state: "survivors", survivors: [{}, {}] }),
    ).toEqual(
      "the running root survived termination with 2 survivor process(es)",
    );
    // sessiond reports "unknown" for an immediate root kill it could not
    // fully verify even when the whole tree is dead — proven live, where
    // treating it as failure broke the very first swap.
    expect(
      terminationFailureDetail({ state: "unknown", survivors: [] }),
    ).toBeNull();
    expect(
      terminationFailureDetail({ state: "terminated", survivors: [] }),
    ).toBeNull();
  });

  test("through the store: survivors fails the pending change, unknown leaves it pending", () => {
    for (const [verdict, expected] of [
      [{ state: "survivors", survivors: [{}] }, "failed"],
      [{ state: "unknown", survivors: [] }, "pending"],
      [{ state: "terminated", survivors: [] }, "pending"],
    ] as const) {
      const control = store();
      control.accept("grok", "0", "claude");
      const detail = terminationFailureDetail(verdict);
      if (detail !== null) control.reportLaunchFailure("grok", detail);
      expect([verdict.state, control.read().state]).toEqual([
        verdict.state,
        expected,
      ]);
    }
  });
});

describe("queen provider projection", () => {
  const base = {
    instanceId: "inst-1",
    signals: [] as const,
    observedLiveProvider: null,
    vendors: ALL_AVAILABLE,
    change: { state: "idle" as const, revision: "0", failure: null },
    now: new Date("2026-07-31T00:00:00.000Z"),
  };

  test("reports observation, not intention: pending with no live provider", () => {
    const projection = buildQueenProviderProjection({
      ...base,
      change: { state: "pending", revision: "2", failure: null },
    });
    expect(projection.liveProvider).toBeNull();
    expect(projection.change).toEqual({
      state: "pending",
      revision: "2",
      failure: null,
    });
    expect(projection.root).toEqual({ name: "queen", instanceId: "inst-1" });
  });

  test("prefers exact provider health and retains conservative legacy fallback", () => {
    const asking = buildQueenProviderProjection({
      ...base,
      signals: ["turn-end", "turn-end"],
      providerStatus: "awaiting_answer",
      observedLiveProvider: "claude",
    });
    expect(asking.health).toEqual("awaiting_answer");
    expect(asking.contradicted).toEqual(false);

    const working = buildQueenProviderProjection({
      ...base,
      signals: ["turn-start"],
      observedLiveProvider: "claude",
    });
    expect(working.health).toEqual("working");
    expect(working.contradicted).toEqual(false);

    // A legacy turn that ended without starting is named as a contradiction;
    // disconnected is the concrete lifecycle state when no root is observed.
    const lying = buildQueenProviderProjection({
      ...base,
      signals: ["turn-end", "turn-end"],
    });
    expect(lying.health).toEqual("disconnected");
    expect(lying.contradicted).toEqual(true);

    // No signals and no live root is disconnected, never unknown.
    const silent = buildQueenProviderProjection(base);
    expect(silent.health).toEqual("disconnected");
    expect(silent.contradicted).toEqual(false);
  });

  test("always carries all five vendors", () => {
    const projection = buildQueenProviderProjection(base);
    expect(Object.keys(projection.vendors).sort()).toEqual([
      "claude",
      "codex",
      "grok",
      "kimi",
      "opencode",
    ]);
  });
});

describe("queen provider wire fixtures", () => {
  // Frozen wire shapes. A schema change that breaks one of these breaks the
  // Workspace client and needs a schemaVersion bump, not a fixture edit.
  const projectionFixture = {
    schemaVersion: 1,
    root: { name: "queen", instanceId: "90a8c286e1" },
    liveProvider: "claude",
    health: "idle",
    contradicted: false,
    vendors: {
      claude: { available: true },
      codex: { available: true },
      grok: { available: true },
      kimi: { available: true },
      opencode: { available: false },
    },
    change: { state: "idle", revision: "4", failure: null },
    observedAt: "2026-07-31T00:00:00.000Z",
  };

  test("projection", () => {
    expect(QueenProviderProjectionSchema.parse(projectionFixture)).toEqual(
      projectionFixture as never,
    );
  });

  test("set response: receipt plus immediate readback", () => {
    const fixture = {
      receipt: {
        operationId: "qpo_019fb59a-b33d-7000-859b-ac4db0b9fac7",
        revision: "5",
      },
      projection: {
        ...projectionFixture,
        change: { state: "pending", revision: "5", failure: null },
      },
    };
    expect(SetLiveQueenProviderResponseSchema.parse(fixture)).toEqual(
      fixture as never,
    );
  });

  test("stale-revision conflict carries the outrunning projection", () => {
    const fixture = {
      error: "revision conflict: queen provider control is at revision 4",
      currentRevision: "4",
      projection: projectionFixture,
    };
    expect(SetLiveQueenProviderConflictSchema.parse(fixture)).toEqual(
      fixture as never,
    );
  });

  test("succession internals never cross the wire", () => {
    // The boundary as a test: these words must not exist as projection keys,
    // today or after any refactor of the internal replacement mechanism.
    const forbidden = [
      "fence",
      "generation",
      "checkpoint",
      "handoff",
      "verification",
      "attestation",
    ];
    const keys = JSON.stringify(
      Object.keys(QueenProviderProjectionSchema.shape),
    );
    for (const word of forbidden) {
      expect(keys).not.toContain(word);
    }
    const rejected = QueenProviderProjectionSchema.safeParse({
      ...projectionFixture,
      generation: 3,
    });
    expect(rejected.success).toEqual(false);
  });

  test("the projection stays opaque through every phase of a succession", () => {
    // A real succession runs behind the control store: checkpoint written,
    // backup declared, provider change accepted, fresh root observed. At
    // every phase the projection reports only idle|pending|failed and none
    // of the succession's words.
    const db = new HiveDatabase(":memory:");
    const control = new QueenProviderControlStore(db);
    const succession = new SuccessionService({
      db,
      mail: new MailStore(db),
      journal: new ManifestJournal(db),
      instanceId: "inst-1",
      reasonSource: () =>
        control.read().state === "pending"
          ? "provider-change"
          : "exit-with-live-agents",
    });
    const forbidden = [
      "fence",
      "generation",
      "checkpoint",
      "handoff",
      "verification",
      "attestation",
    ];
    const assertOpaque = () => {
      const state = control.read();
      const projection = buildQueenProviderProjection({
        instanceId: "inst-1",
        signals: [],
        observedLiveProvider: null,
        vendors: ALL_AVAILABLE,
        change: {
          state: state.state,
          revision: state.revision,
          failure: state.failure,
        },
        now: new Date("2026-07-31T00:00:00.000Z"),
      });
      expect(["idle", "pending", "failed"]).toContain(projection.change.state);
      const keys = JSON.stringify(Object.keys(projection));
      for (const word of forbidden) {
        expect(keys).not.toContain(word);
      }
    };

    assertOpaque(); // idle, nothing in flight
    const checkpoint = succession.writeRootCheckpoint({
      reason: "run-control",
      contextUsage: {
        kind: "measured",
        residentTokens: 10_000,
        measuredAt: "2026-07-31T00:00:00.000Z",
      },
      model: null,
      decision: { decision: "compact", reason: "healthy warm root" },
      written: {
        goal: "keep the run moving",
        done: [],
        failures: [],
        uncertainty: [],
        nextAction: "continue",
        rollback: "relaunch the prior root",
      },
      unresolvedQuestions: [],
    });
    assertOpaque(); // a checkpoint write is not a client-visible event
    const { succession: declared } = succession.begin({
      reasonDetail:
        "orchestrator exited with code 9 while 1 agent(s) remained active",
      priorRootGeneration: 0,
      snapshot: [],
    });
    expect(declared.proof).toEqual({
      kind: "checkpoint",
      ref: { revision: "1", digest: checkpoint.digest },
    });
    assertOpaque(); // recovering, still idle on the wire
    control.accept("grok", "0", "claude");
    assertOpaque(); // pending while the succession is open
    control.reconcileObserved("grok");
    // Observation is not an attestation: the projection must not move.
    assertOpaque();
    expect(succession.projection().succession?.state).toEqual("recovering");
    succession.gateRootToolCall(
      { id: "cap-successor" } as never,
      "hive_status",
    );
    succession.gateRootToolCall(
      { id: "cap-successor" } as never,
      "hive_mail_poll",
    );
    succession.gateRootToolCall(
      { id: "cap-successor" } as never,
      "hive_task_list",
    );
    succession.gateRootToolCall(
      { id: "cap-successor" } as never,
      "hive_run_checkpoint_get",
    );
    succession.attest(
      {
        successionId: declared.successionId,
        generation: 1,
        checkpointDigest: checkpoint.digest,
      },
      "cap-successor",
    );
    expect(succession.projection().succession?.state).toEqual("attested");
    assertOpaque(); // attested and idle
    control.reportLaunchFailure("grok", "grok CLI is broken");
    assertOpaque(); // failed, still nothing but the three words
    db.close();
  });
});

describe("vendor availability reader", () => {
  test("probes at most once per interval", () => {
    let probes = 0;
    let clock = 0;
    const read = vendorAvailabilityReader(
      () => {
        probes += 1;
        return ALL_AVAILABLE;
      },
      () => clock,
    );
    read();
    read();
    expect(probes).toEqual(1);
    clock = 61_000;
    read();
    expect(probes).toEqual(2);
  });
});
