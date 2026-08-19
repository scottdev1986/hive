// Tests for the Stage-1 rows (scripts/qa/stage1-rows.ts). No rig: a fake-rig
// simulator plays the app side of the qa-control mailbox and the daemon side
// of the oracles, with switches that construct each failing condition — a
// broken apply commit, a frozen revision, a dying gate, a snapshot that never
// advances. The suite-level idempotency property (T1-09) is proven by running
// the whole stage twice against the same simulator.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  normalizePolicyExport,
  rowT101RouterReachable,
  rowT102MemberApplyWrites,
  rowT103WeightWritesThrough,
  rowT104IllegalWeightRefused,
  rowT105ModeEffortWriteThrough,
  rowT106ApplyIsTheOnlyWrite,
  rowT107ProviderToggleIsSpendConsent,
  rowT108ProbeRefreshIsARead,
  rowT109RigBaseline,
  runStage1Rows,
  type Stage1Context,
} from "../../scripts/qa/stage1-rows";
import type {
  Exec,
  ExecResult,
  ObserveClients,
} from "../../scripts/qa/qa-runner";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

const QA_BIN = "/qa/hive";
const K0 = { provider: "alpha", model: "a1" };
const K1 = { provider: "beta", model: "b1" };
const MODES = [
  { id: "user-weighted", label: "Weighted split", weightEditable: true },
  { id: "hive-equal", label: "Equal split", weightEditable: false },
];
const EFFORTS = [
  { argument: "low", label: "Low", effort: { mode: "exact", value: "low" } },
  { argument: "high", label: "High", effort: { mode: "exact", value: "high" } },
];

interface Draft {
  members: Map<string, boolean>;
  weights: Map<string, number>;
  mode: string | null | undefined;
  efforts: Map<string, unknown>;
}

class FakeRig {
  route = "shell";
  revision = 1;
  updatedAtTick = 0;
  providers: Record<string, string> = { alpha: "enabled", beta: "enabled" };
  global: {
    mode: string;
    candidates: Array<{
      provider: string;
      model: string;
      weight: number;
      effort: unknown;
    }>;
  } | null = { mode: "user-weighted", candidates: [] };
  observedTick = 0;
  applyEnabled = false;
  hideApply = false;
  gateDown = false;
  applyNoCommit = false;
  modeEffortNoCommit = false;
  freezeRevision = false;
  providerToggleNoop = false;
  catalog = [
    { ...K0, effortOptions: EFFORTS },
    { ...K1, effortOptions: EFFORTS },
  ];
  private draft: Draft = {
    members: new Map(),
    weights: new Map(),
    mode: undefined,
    efforts: new Map(),
  };

  key(provider: string, model: string): string {
    return `${provider}/${model}`;
  }

  isMember(key: string): boolean {
    const staged = this.draft.members.get(key);
    if (staged !== undefined) return staged;
    return (
      this.global?.candidates.some(
        (candidate) => this.key(candidate.provider, candidate.model) === key,
      ) ?? false
    );
  }

  currentMode(): string | null {
    if (this.draft.mode !== undefined) return this.draft.mode;
    return this.global?.mode ?? null;
  }

  private bump(): void {
    if (!this.freezeRevision) this.revision += 1;
    this.updatedAtTick += 1;
  }

  private commit(): void {
    if (!this.applyNoCommit) {
      for (const [key, on] of this.draft.members) {
        const [provider, model] = key.split("/") as [string, string];
        const candidates = this.global?.candidates ?? [];
        const index = candidates.findIndex(
          (candidate) => this.key(candidate.provider, candidate.model) === key,
        );
        if (on && index === -1) {
          candidates.push({
            provider,
            model,
            weight: 1,
            effort: EFFORTS[0]?.effort,
          });
        }
        if (!on && index !== -1) candidates.splice(index, 1);
      }
      if (this.global === null && this.draft.mode !== undefined) {
        this.global = { mode: "user-weighted", candidates: [] };
      }
      for (const [key, weight] of this.draft.weights) {
        const candidate = this.global?.candidates.find(
          (entry) => this.key(entry.provider, entry.model) === key,
        );
        if (candidate !== undefined) candidate.weight = weight;
      }
      if (this.draft.mode !== undefined && this.draft.mode !== null) {
        if (this.global !== null && !this.modeEffortNoCommit)
          this.global.mode = this.draft.mode;
      }
      for (const [key, effort] of this.draft.efforts) {
        const candidate = this.global?.candidates.find(
          (entry) => this.key(entry.provider, entry.model) === key,
        );
        if (candidate !== undefined && !this.modeEffortNoCommit)
          candidate.effort = effort;
      }
    }
    this.bump();
    this.draft = {
      members: new Map(),
      weights: new Map(),
      mode: undefined,
      efforts: new Map(),
    };
    this.applyEnabled = false;
  }

  policy() {
    return {
      schemaVersion: 3,
      revision: this.revision,
      updatedAt: `2026-08-19T00:00:${String(this.updatedAtTick).padStart(2, "0")}Z`,
      provisional: false,
      providers: this.providers,
      models: [],
      global: this.global,
      categories: {},
    };
  }

  exportText(): string {
    return `${JSON.stringify(this.policy(), null, 2)}\n`;
  }

  snapshot() {
    return {
      schemaVersion: 1,
      observedAt: `2026-08-19T00:00:${String(this.observedTick).padStart(2, "0")}Z`,
      routing: {
        catalog: this.catalog,
        modes: MODES,
        weightRange: { minimum: 1, maximum: 100, defaultValue: 1 },
      },
    };
  }

  refreshProbe(): void {
    this.observedTick += 1;
  }

  private controls() {
    const controls: Array<{
      identifier: string;
      role: string;
      enabled: boolean;
      actionable: boolean;
      functionallyPresent: boolean;
    }> = [];
    const add = (identifier: string, enabled: boolean) =>
      controls.push({
        identifier,
        role: "control",
        enabled,
        actionable: true,
        functionallyPresent: true,
      });
    if (this.route === "router") {
      if (!this.hideApply) add("task-router-apply", this.applyEnabled);
      for (const entry of this.catalog) {
        const key = this.key(entry.provider, entry.model);
        add(`task-router-member-${key}`, true);
        add(`task-router-weight-${key}`, true);
        add(`task-router-effort-${key}`, true);
      }
      add("task-router-mode", true);
    }
    if (this.route === "models") {
      for (const provider of Object.keys(this.providers)) {
        add(`models-quota-provider-${provider}`, true);
      }
      add("models-quota-probe-refresh", true);
    }
    return controls;
  }

  private answer(status: "ok" | "fail", reason?: string): ExecResult {
    const controls = this.controls();
    return {
      exitCode: status === "ok" ? 0 : 1,
      stdout: JSON.stringify({
        requestId: "r",
        status,
        root: "hive-workspace-qa-root",
        route: this.route,
        controls,
        count: controls.length,
        terminator: `qa-control-end:r:${controls.length}`,
        ...(reason === undefined ? {} : { reason }),
      }),
      stderr: "",
    };
  }

  qaControl(argv: readonly string[]): ExecResult {
    if (this.gateDown) {
      return { exitCode: 2, stdout: "", stderr: "NO MEASUREMENT: gone" };
    }
    const verb = argv[2];
    const identifier = argv[3];
    if (verb === "enumerate") return this.answer("ok");
    const controls = this.controls();
    if (
      identifier === undefined ||
      (!identifier.startsWith("shell-nav-") &&
        !controls.some((control) => control.identifier === identifier))
    ) {
      return this.answer("fail", "control not found");
    }
    if (identifier === "shell-nav-router") {
      this.route = "router";
      return this.answer("ok");
    }
    if (identifier === "shell-nav-models") {
      this.route = "models";
      return this.answer("ok");
    }
    if (verb === "invoke" && identifier === "task-router-apply") {
      if (!this.applyEnabled)
        return this.answer("fail", "control is not actionable");
      this.commit();
      return this.answer("ok");
    }
    if (verb === "invoke" && identifier?.startsWith("task-router-member-")) {
      const key = identifier.slice("task-router-member-".length);
      this.draft.members.set(key, !this.isMember(key));
      this.applyEnabled = true;
      return this.answer("ok");
    }
    if (verb === "invoke" && identifier?.startsWith("task-router-weight-")) {
      const key = identifier.slice("task-router-weight-".length);
      if (!this.isMember(key) || this.currentMode() !== "user-weighted") {
        return this.answer("fail", "control is not actionable");
      }
      const input = argv[argv.indexOf("--input") + 1] ?? "";
      const weight = Number.parseInt(input, 10);
      if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
        this.applyEnabled = false;
        return this.answer("ok");
      }
      this.draft.weights.set(key, weight);
      this.applyEnabled = true;
      return this.answer("ok");
    }
    if (verb === "select" && identifier === "task-router-mode") {
      const titleIndex = argv.indexOf("--title");
      const indexIndex = argv.indexOf("--index");
      if (titleIndex !== -1) {
        const mode = MODES.find(
          (entry) => entry.label === argv[titleIndex + 1],
        );
        if (mode === undefined)
          return this.answer("fail", "popup item not found");
        this.draft.mode = mode.id;
      } else if (indexIndex !== -1) {
        const index = Number(argv[indexIndex + 1]);
        if (index === 0) this.draft.mode = null;
        else {
          const mode = MODES[index - 1];
          if (mode === undefined)
            return this.answer("fail", "popup item not found");
          this.draft.mode = mode.id;
        }
      }
      this.applyEnabled = true;
      return this.answer("ok");
    }
    if (verb === "select" && identifier?.startsWith("task-router-effort-")) {
      const key = identifier.slice("task-router-effort-".length);
      if (!this.isMember(key))
        return this.answer("fail", "control is not actionable");
      const index = Number(argv[argv.indexOf("--index") + 1]);
      const option = EFFORTS[index];
      if (option === undefined)
        return this.answer("fail", "popup item not found");
      this.draft.efforts.set(key, option.effort);
      this.applyEnabled = true;
      return this.answer("ok");
    }
    if (verb === "invoke" && identifier?.startsWith("models-quota-provider-")) {
      const provider = identifier.slice("models-quota-provider-".length);
      const state = this.providers[provider];
      if (state === undefined) return this.answer("fail", "control not found");
      if (!this.providerToggleNoop) {
        this.providers[provider] = state === "enabled" ? "disabled" : "enabled";
        this.bump();
      }
      return this.answer("ok");
    }
    if (verb === "invoke" && identifier === "models-quota-probe-refresh") {
      this.refreshProbe();
      return this.answer("ok");
    }
    return this.answer("fail", "control not found");
  }
}

function rigExec(rig: FakeRig): Exec {
  return async (argv) => {
    if (argv[0] === QA_BIN && argv[1] === "qa-control")
      return rig.qaControl(argv);
    if (argv[0] === QA_BIN && argv[1] === "routing" && argv[2] === "export") {
      return { exitCode: 0, stdout: rig.exportText(), stderr: "" };
    }
    return {
      exitCode: 127,
      stdout: "",
      stderr: `unexpected exec: ${argv.join(" ")}`,
    };
  };
}

function rigObserve(
  rig: FakeRig,
  overrides: Partial<ObserveClients> = {},
): ObserveClients {
  return {
    httpStatus: async () => 200,
    httpJson: async (path) => {
      if (path === "/routing/policy")
        return { status: 200, body: rig.policy() };
      if (path === "/model-control/snapshot") {
        return { status: 200, body: rig.snapshot() };
      }
      return { status: 404, body: {} };
    },
    mcpCall: async () => ({}),
    close: async () => {},
    ...overrides,
  };
}

const sleep = async (ms: number): Promise<void> => Bun.sleep(ms);

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function ctx(rig: FakeRig, observe?: ObserveClients | null): Stage1Context {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-stage1-"));
  fixtures.push(fixture);
  return {
    exec: rigExec(rig),
    qaBin: QA_BIN,
    observe: observe === undefined ? rigObserve(rig) : observe,
    sleep,
    baselinePath: join(fixture, "state", "qa-rig-baseline.json"),
    boundMs: 300,
  };
}

describe("T1-01 router reachable", () => {
  test("passes when the second enumerate shows the router with apply", async () => {
    const row = await rowT101RouterReachable(ctx(new FakeRig()));
    expect(row.status).toBe("PASS");
  });

  test("fails when apply never appears on the router screen", async () => {
    const rig = new FakeRig();
    rig.hideApply = true;
    const row = await rowT101RouterReachable(ctx(rig));
    expect(row.status).toBe("FAIL");
  });

  test("NO MEASUREMENT when the gate is down", async () => {
    const rig = new FakeRig();
    rig.gateDown = true;
    const row = await rowT101RouterReachable(ctx(rig));
    expect(row.status).toBe("NO MEASUREMENT");
  });
});

describe("T1-02 member apply writes", () => {
  test("passes the full plant-verify-restore cycle", async () => {
    const rig = new FakeRig();
    const row = await rowT102MemberApplyWrites(ctx(rig), K1);
    expect(row.status).toBe("PASS");
    expect(rig.global?.candidates).toEqual([]);
  });

  test("fails when apply reports ok but the export never shows the candidate", async () => {
    const rig = new FakeRig();
    rig.applyNoCommit = true;
    const row = await rowT102MemberApplyWrites(ctx(rig), K1);
    expect(row.status).toBe("FAIL");
    expect(row.reason).toContain("no candidate");
  });

  test("fails when the write lands but the revision does not move", async () => {
    const rig = new FakeRig();
    rig.freezeRevision = true;
    const row = await rowT102MemberApplyWrites(ctx(rig), K1);
    expect(row.status).toBe("FAIL");
    expect(row.reason).toContain("revision stayed");
  });

  test("NO MEASUREMENT when the policy oracle refuses", async () => {
    const rig = new FakeRig();
    const row = await rowT102MemberApplyWrites(
      ctx(
        rig,
        rigObserve(rig, {
          httpJson: async () => ({ status: 500, body: {} }),
        }),
      ),
      K1,
    );
    expect(row.status).toBe("NO MEASUREMENT");
  });
});

describe("T1-03 weight writes through", () => {
  test("passes weight 1 -> 3 -> 1 with the revision moving", async () => {
    const rig = new FakeRig();
    const row = await rowT103WeightWritesThrough(ctx(rig), K1);
    expect(row.status).toBe("PASS");
    expect(row.reason).toContain("1 -> 3 -> 1");
  });

  test("NO MEASUREMENT when the membership precondition cannot be planted", async () => {
    const rig = new FakeRig();
    // No catalog rows means no member control for k1: the door refuses.
    rig.catalog = [];
    const row = await rowT103WeightWritesThrough(ctx(rig), K1);
    expect(row.status).toBe("NO MEASUREMENT");
    expect(row.reason).toContain("could not plant");
  });
});

describe("T1-04 an illegal weight refuses locally", () => {
  test("passes: apply disabled, revision unchanged, control moved", async () => {
    const row = await rowT104IllegalWeightRefused(ctx(new FakeRig()), K1);
    expect(row.status).toBe("PASS");
    expect(row.reason).toContain("control: plant moved");
  });

  test("fails when apply stays enabled with an illegal weight", async () => {
    const rig = new FakeRig();
    const realQaControl = rig.qaControl.bind(rig);
    rig.qaControl = (argv) => {
      const result = realQaControl(argv);
      // The defect: weightChanged never disables apply.
      if (argv[3]?.startsWith("task-router-weight-")) rig.applyEnabled = true;
      return result;
    };
    const row = await rowT104IllegalWeightRefused(ctx(rig), K1);
    expect(row.status).toBe("FAIL");
    expect(row.reason).toContain("stayed enabled");
  });

  test("fails when the revision moves on a refused weight", async () => {
    const rig = new FakeRig();
    const realQaControl = rig.qaControl.bind(rig);
    rig.qaControl = (argv) => {
      const result = realQaControl(argv);
      if (argv[3]?.startsWith("task-router-weight-") && argv.includes("0")) {
        rig.applyEnabled = false;
        rig.revision += 1; // the defect: a refused write still moved the policy
      }
      return result;
    };
    const row = await rowT104IllegalWeightRefused(ctx(rig), K1);
    expect(row.status).toBe("FAIL");
    expect(row.reason).toContain("refused weight");
  });

  test("NO MEASUREMENT when the positive control does not move the revision", async () => {
    const rig = new FakeRig();
    rig.freezeRevision = true;
    const row = await rowT104IllegalWeightRefused(ctx(rig), K1);
    expect(row.status).toBe("NO MEASUREMENT");
    expect(row.reason).toContain("positive control failed");
  });
});

describe("T1-05 mode and effort write through", () => {
  test("passes with a mode switch and an effort change, then restores", async () => {
    const rig = new FakeRig();
    const row = await rowT105ModeEffortWriteThrough(ctx(rig), K1);
    expect(row.status).toBe("PASS");
    expect(row.reason).toContain("hive-equal");
    expect(rig.global?.mode).toBe("user-weighted");
    expect(rig.global?.candidates).toEqual([]);
  });

  test("NO MEASUREMENT with fewer than two effort options", async () => {
    const rig = new FakeRig();
    rig.catalog = [
      rig.catalog[0] as (typeof rig.catalog)[number],
      { ...K1, effortOptions: [EFFORTS[0] as (typeof EFFORTS)[number]] },
    ];
    const row = await rowT105ModeEffortWriteThrough(ctx(rig), K1);
    expect(row.status).toBe("NO MEASUREMENT");
    expect(row.reason).toContain("effort options");
  });

  test("fails when apply reports ok but the export never shows the mode", async () => {
    const rig = new FakeRig();
    rig.modeEffortNoCommit = true;
    const row = await rowT105ModeEffortWriteThrough(ctx(rig), K1);
    expect(row.status).toBe("FAIL");
  });
});

describe("T1-06 apply is the only write", () => {
  test("passes: draft leaves the revision, apply moves it", async () => {
    const row = await rowT106ApplyIsTheOnlyWrite(ctx(new FakeRig()), K1);
    expect(row.status).toBe("PASS");
  });

  test("fails when a draft edit moves the revision", async () => {
    const rig = new FakeRig();
    const realQaControl = rig.qaControl.bind(rig);
    rig.qaControl = (argv) => {
      const result = realQaControl(argv);
      if (argv[3]?.startsWith("task-router-member-")) rig.revision += 1;
      return result;
    };
    const row = await rowT106ApplyIsTheOnlyWrite(ctx(rig), K1);
    expect(row.status).toBe("FAIL");
    expect(row.reason).toContain("without apply");
  });
});

describe("T1-07 provider toggle is spend-consent", () => {
  test("passes flip and restore with the revision moving", async () => {
    const rig = new FakeRig();
    const row = await rowT107ProviderToggleIsSpendConsent(ctx(rig), "beta");
    expect(row.status).toBe("PASS");
    expect(rig.providers.beta).toBe("enabled");
  });

  test("NO MEASUREMENT for an unconfigured provider", async () => {
    const row = await rowT107ProviderToggleIsSpendConsent(
      ctx(new FakeRig()),
      "gamma",
    );
    expect(row.status).toBe("NO MEASUREMENT");
  });

  test("fails when the toggle reports ok but the export never flips", async () => {
    const rig = new FakeRig();
    rig.providerToggleNoop = true;
    const row = await rowT107ProviderToggleIsSpendConsent(ctx(rig), "beta");
    expect(row.status).toBe("FAIL");
  });
});

describe("T1-08 probe refresh is a read", () => {
  test("passes with the T1-07 positive control named", async () => {
    const row = await rowT108ProbeRefreshIsARead(
      ctx(new FakeRig()),
      "T1-07 moved the revision (2 -> 3)",
    );
    expect(row.status).toBe("PASS");
    expect(row.reason).toContain("control: T1-07");
  });

  test("NO MEASUREMENT without a positive control", async () => {
    const row = await rowT108ProbeRefreshIsARead(ctx(new FakeRig()), null);
    expect(row.status).toBe("NO MEASUREMENT");
  });

  test("fails when refresh never advances the snapshot", async () => {
    const rig = new FakeRig();
    rig.refreshProbe = () => {};
    const row = await rowT108ProbeRefreshIsARead(ctx(rig), "control");
    expect(row.status).toBe("FAIL");
  });

  test("fails when refresh moves the revision", async () => {
    const rig = new FakeRig();
    const realQaControl = rig.qaControl.bind(rig);
    rig.qaControl = (argv) => {
      const result = realQaControl(argv);
      if (argv[3] === "models-quota-probe-refresh") rig.revision += 1;
      return result;
    };
    const row = await rowT108ProbeRefreshIsARead(ctx(rig), "control");
    expect(row.status).toBe("FAIL");
  });
});

describe("T1-09 the rig baseline", () => {
  test("first run records the baseline, second diffs empty", async () => {
    const rig = new FakeRig();
    const context = ctx(rig);
    const first = await rowT109RigBaseline(context, K0);
    expect(first.status).toBe("PASS");
    expect(first.reason).toContain("recorded");
    const second = await rowT109RigBaseline(context, K0);
    expect(second.status).toBe("PASS");
    expect(second.reason).toContain("diffs empty");
  });

  test("fails when the run's export differs from the baseline", async () => {
    const rig = new FakeRig();
    const context = ctx(rig);
    await rowT109RigBaseline(context, K0);
    rig.providers.alpha = "disabled";
    const row = await rowT109RigBaseline(context, K0);
    expect(row.status).toBe("FAIL");
    expect(row.reason).toContain("not repeatable");
  });

  test("normalizePolicyExport ignores revision and updatedAt only", () => {
    const a = '{"revision":1,"updatedAt":"x","providers":{"alpha":"enabled"}}';
    const b = '{"revision":9,"updatedAt":"y","providers":{"alpha":"enabled"}}';
    const c = '{"revision":9,"updatedAt":"y","providers":{"alpha":"disabled"}}';
    expect(normalizePolicyExport(a)).toBe(normalizePolicyExport(b));
    expect(normalizePolicyExport(a)).not.toBe(normalizePolicyExport(c));
  });
});

describe("the stage as a suite", () => {
  test("all nine rows NO MEASUREMENT when the observe stack is absent", async () => {
    const rows = await runStage1Rows(ctx(new FakeRig(), null));
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.status === "NO MEASUREMENT")).toBe(true);
  });

  test("rows needing a second model go NO MEASUREMENT when the catalog offers one", async () => {
    const rig = new FakeRig();
    rig.catalog = [rig.catalog[0] as (typeof rig.catalog)[number]];
    const rows = await runStage1Rows(ctx(rig));
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    for (const id of ["T1-02", "T1-03", "T1-04", "T1-05", "T1-06"]) {
      expect(byId.get(id)).toBe("NO MEASUREMENT");
    }
    // T1-01, T1-07, T1-08 and T1-09 need at most the one catalog model.
    expect(byId.get("T1-01")).toBe("PASS");
    expect(byId.get("T1-07")).toBe("PASS");
    expect(byId.get("T1-08")).toBe("PASS");
    expect(byId.get("T1-09")).toBe("PASS");
  });

  test("two consecutive full runs pass, the second diffing empty", async () => {
    const rig = new FakeRig();
    const context = ctx(rig);
    const first = await runStage1Rows(context);
    expect(
      first.every((row) => row.status === "PASS"),
      JSON.stringify(first),
    ).toBe(true);
    const second = await runStage1Rows(context);
    expect(
      second.every((row) => row.status === "PASS"),
      JSON.stringify(second),
    ).toBe(true);
    const t109 = second.find((row) => row.id === "T1-09");
    expect(t109?.reason).toContain("diffs empty");
  });
});
