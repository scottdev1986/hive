import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
} from "../../src/schemas/capability";
import {
  agentStandardsRefusalMessage,
  classifyViewerReadback,
  explicitRefusalReadbackState,
  finalU5Result,
  liveRunControlSubjectReady,
  nameSpawnRefusalCause,
  partitionLiveProofSubjects,
  proofSubjectLiveness,
  reconcileSpawnRequests,
  requireParsedAgentStandards,
  spawnRefusalProofError,
  stageIsolatedProjectAgentStandards,
  assertIsolatedQaHiveHome,
  assertQaHomeFitsSocketPath,
  assertQaHomeOwner,
  assertSessiondEmbedsTreeSchema,
  defaultQaHomeRequested,
  defaultQaHomeResolved,
  headlessRootReapVerdict,
  isIsolatedQaHomePath,
  QA_HOME_DEFAULT_LABEL,
  requireHeadlessRootRunning,
  requireU5AccountabilityTaskId,
  requireU5WorkspaceApp,
  resolveU5Scope,
  summarizeProviderOutcomes,
  U5_DEFAULT_QA_HOME_TAG_HEX_LENGTH,
  U5_FULL_SCOPE,
  U5_PARTIAL_SCOPE,
  U5_QA_HOME_SOCKET_MAX_LENGTH,
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

  test("default QA home fits the socket-path limit and an over-long home is refused", () => {
    expect(U5_QA_HOME_SOCKET_MAX_LENGTH).toBe(20);
    expect(QA_HOME_DEFAULT_LABEL).toBe("hq");
    expect(U5_DEFAULT_QA_HOME_TAG_HEX_LENGTH).toBe(5);
    const requested = defaultQaHomeRequested(
      "/Users/x/Projects/hive/.hive/worktrees/helen",
    );
    expect(requested).toMatch(/^\/tmp\/hq[0-9a-f]{5}$/);
    const resolved = defaultQaHomeResolved(
      "/Users/x/Projects/hive/.hive/worktrees/helen",
    );
    expect(resolved.length).toBe(U5_QA_HOME_SOCKET_MAX_LENGTH);
    expect(assertQaHomeFitsSocketPath(resolved)).toBe(resolved);
    expect(isIsolatedQaHomePath(resolved)).toBe(true);
    expect(() =>
      assertQaHomeFitsSocketPath("/private/tmp/hvqa-a50f523119"),
    ).toThrow("QA home is too long for the session host socket path");
    expect(() =>
      assertQaHomeFitsSocketPath("/private/tmp/hvqa-f35"),
    ).toThrow("QA home is too long for the session host socket path");
  });

  test("shell and TypeScript share one QA home definition", () => {
    const sourceRoot = "/Users/x/Projects/hive/.hive/worktrees/helen";
    const shell = Bun.spawnSync(
      [
        "bash",
        "-c",
        'source "$1" && qa_default_home_requested "$2" && qa_home_is_isolated "$3"; echo isolated:$?',
        "qa-home",
        resolve(import.meta.dir, "qa-home.sh"),
        sourceRoot,
        defaultQaHomeResolved(sourceRoot),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(shell.exitCode).toBe(0);
    const lines = new TextDecoder()
      .decode(shell.stdout)
      .trim()
      .split("\n");
    expect(lines[0]).toBe(defaultQaHomeRequested(sourceRoot));
    expect(lines[1]).toBe("isolated:0");
  });

  test("a QA home owned by a different checkout is refused by name, same-checkout reuse is not", () => {
    expect(() =>
      assertQaHomeOwner(
        "/Users/x/Projects/hive/.hive/worktrees/carmen",
        "/Users/x/Projects/hive/.hive/worktrees/helen",
      ),
    ).toThrow("QA_HOME is owned by");
    expect(() =>
      assertQaHomeOwner(
        "/Users/x/Projects/hive/.hive/worktrees/helen",
        "/Users/x/Projects/hive/.hive/worktrees/helen",
      ),
    ).not.toThrow();
    expect(() =>
      assertQaHomeOwner(undefined, "/Users/x/Projects/hive/.hive/worktrees/helen"),
    ).not.toThrow();
  });

  test("sessiond must embed the tree schema; a stale binary is refused by name", () => {
    const tree = Buffer.from('{"schemaVersion":1,"title":"session-protocol"}');
    expect(() => assertSessiondEmbedsTreeSchema(Buffer.from(""), tree)).toThrow(
      "U5 sessiond schema stale: staged hive-sessiond does not embed the tree's session-protocol.schema.json",
    );
    expect(() =>
      assertSessiondEmbedsTreeSchema(Buffer.from("unrelated binary"), tree),
    ).toThrow(
      "U5 sessiond schema stale: staged hive-sessiond does not embed the tree's session-protocol.schema.json",
    );
    expect(() =>
      assertSessiondEmbedsTreeSchema(Buffer.from(""), Buffer.from("")),
    ).toThrow(
      "U5 sessiond schema check refused: tree session-protocol.schema.json is empty",
    );
    expect(() =>
      assertSessiondEmbedsTreeSchema(
        Buffer.concat([Buffer.from("hdr"), tree, Buffer.from("tlr")]),
        tree,
      ),
    ).not.toThrow();
  });

  test("headless root open refuses any state that is not running", () => {
    expect(() => requireHeadlessRootRunning("exited")).toThrow(
      "U5 headless root open refused: state is exited, not running",
    );
    expect(() => requireHeadlessRootRunning("failed")).toThrow(
      "U5 headless root open refused: state is failed, not running",
    );
    expect(() => requireHeadlessRootRunning("")).toThrow(
      "U5 headless root open refused: state is , not running",
    );
    expect(() => requireHeadlessRootRunning("running")).not.toThrow();
  });

  test("headless root reap is clean only when the host is live before and absent after", () => {
    expect(headlessRootReapVerdict(false, null, null)).toBe("not-opened");
    expect(headlessRootReapVerdict(true, "live", "absent")).toBe("clean");
    expect(headlessRootReapVerdict(true, "live", "live")).toBe("failed");
    expect(headlessRootReapVerdict(true, "absent", "absent")).toBe("failed");
    expect(headlessRootReapVerdict(true, "unknown", "absent")).toBe("failed");
  });

  test("live accountability task id is required and never defaulted", () => {
    expect(() => requireU5AccountabilityTaskId({})).toThrow(
      "U5 live evidence requires HIVE_QA_U5_ACCOUNTABILITY_TASK_ID; the harness does not default a live-board id",
    );
    expect(() =>
      requireU5AccountabilityTaskId({ HIVE_QA_U5_ACCOUNTABILITY_TASK_ID: "" }),
    ).toThrow(
      "U5 live evidence requires HIVE_QA_U5_ACCOUNTABILITY_TASK_ID; the harness does not default a live-board id",
    );
    expect(
      requireU5AccountabilityTaskId({
        HIVE_QA_U5_ACCOUNTABILITY_TASK_ID:
          "task_01a00790-000b-7000-8000-00000000010b",
      }),
    ).toBe("task_01a00790-000b-7000-8000-00000000010b");
  });

  test("fixture-task seeding refuses a machine hive home by name", () => {
    expect(() =>
      assertIsolatedQaHiveHome("/Users/x/.hive", "/Users/x/.hive"),
    ).toThrow(
      "U5 fixture-task seeding refuses HIVE_HOME that resolves to the machine hive",
    );
    expect(() =>
      assertIsolatedQaHiveHome(
        "/Users/x/.hive/instances/dev-abc",
        "/Users/x/.hive",
      ),
    ).toThrow(
      "U5 fixture-task seeding refuses HIVE_HOME that resolves to the machine hive",
    );
    expect(() =>
      assertIsolatedQaHiveHome("/tmp/not-qa", "/Users/x/.hive"),
    ).toThrow(
      "U5 fixture-task seeding refuses a HIVE_HOME that is not an isolated QA root",
    );
    expect(
      assertIsolatedQaHiveHome("/tmp/hvqa-fixture-control", "/Users/x/.hive"),
    ).toBe(resolve("/tmp/hvqa-fixture-control"));
    expect(isIsolatedQaHomePath("/private/tmp/hqabcde")).toBe(true);
    expect(isIsolatedQaHomePath("/tmp/not-qa")).toBe(false);
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

describe("U5 isolated project agent standards", () => {
  const repoRoot = join(import.meta.dir, "../..");

  test("spawn still refuses by name when AGENT_STANDARDS.md is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "u5-std-absent-"));
    try {
      const refusal = await agentStandardsRefusalMessage(root);
      expect(refusal).toMatch(/Cannot spawn: agent standards are unreadable/);
      expect(refusal).toContain(join(root, "AGENT_STANDARDS.md"));
      expect(nameSpawnRefusalCause(refusal)).toBe("standards-unreadable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stub that only satisfies readFile is refused as undeclared", async () => {
    const root = await mkdtemp(join(tmpdir(), "u5-std-stub-"));
    try {
      await writeFile(
        join(root, "AGENT_STANDARDS.md"),
        "# notes\n\n## Coding guidelines\n\nbody\n",
      );
      const refusal = await agentStandardsRefusalMessage(root);
      expect(refusal).toMatch(/declares no sections/);
      expect(nameSpawnRefusalCause(refusal)).toBe("standards-undeclared");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the staged checkout file parses against the declaration check", async () => {
    const root = await mkdtemp(join(tmpdir(), "u5-std-real-"));
    try {
      const source = await readFile(join(repoRoot, "AGENT_STANDARDS.md"), "utf8");
      const staged = stageIsolatedProjectAgentStandards(root, source);
      expect(staged.path).toBe(join(root, "AGENT_STANDARDS.md"));
      expect(staged.bytes).toBeGreaterThan(0);
      const parsed = await requireParsedAgentStandards(root);
      expect(parsed.sectionCount).toBeGreaterThan(0);
      expect(parsed.headings).toContain("Coding guidelines");
      expect(parsed.headings).toContain("Hive protocol");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an empty stage source is refused rather than written", () => {
    expect(() => stageIsolatedProjectAgentStandards("/tmp/unused", "")).toThrow(
      "U5 isolated project refuses to stage empty AGENT_STANDARDS.md",
    );
    expect(() =>
      stageIsolatedProjectAgentStandards("/tmp/unused", "   \n"),
    ).toThrow("U5 isolated project refuses to stage empty AGENT_STANDARDS.md");
  });
});

describe("U5 spawn refusal attribution", () => {
  const unreadable =
    "Cannot spawn: agent standards are unreadable at /private/tmp/u5p-h/AGENT_STANDARDS.md: ENOENT";
  const undeclared =
    'Cannot spawn: /private/tmp/u5p-h/AGENT_STANDARDS.md declares no sections. Above the first "##" heading it needs a ```standards block';

  test("first spawn with no prior live admissions can prove absence", () => {
    expect(
      explicitRefusalReadbackState({
        positiveControlIds: [],
        visiblePositiveControlCount: 0,
        matchingCount: 0,
      }),
    ).toEqual({ state: "absent" });
  });

  test("a marker-bound row and a missing live control stay unknown", () => {
    expect(
      explicitRefusalReadbackState({
        positiveControlIds: [],
        visiblePositiveControlCount: 0,
        matchingCount: 1,
      }),
    ).toEqual({
      state: "unknown",
      reason: "the refused request has a marker-bound agent row",
    });
    expect(
      explicitRefusalReadbackState({
        positiveControlIds: ["claude-id"],
        visiblePositiveControlCount: 0,
        matchingCount: 0,
      }),
    ).toEqual({
      state: "unknown",
      reason:
        "the status read could not see every required live positive control",
    });
  });

  test("proofError names the spawn refusal instead of collapsing it", () => {
    const collapsed =
      "claude refusal could not prove the absence of a marker-bound admission";
    const firstSpawnUnknown = spawnRefusalProofError("claude", unreadable, {
      state: "unknown",
      reason:
        "the status read could not see every required live positive control",
    });
    expect(firstSpawnUnknown).toContain("standards-unreadable");
    expect(firstSpawnUnknown).toContain(unreadable);
    expect(firstSpawnUnknown).not.toBe(collapsed);

    expect(
      spawnRefusalProofError("claude", undeclared, {
        state: "unknown",
        reason: "the refused request has a marker-bound agent row",
      }),
    ).toContain("standards-undeclared");

    expect(
      spawnRefusalProofError("claude", unreadable, { state: "absent" }),
    ).toBeNull();
    expect(spawnRefusalProofError("claude", "", { state: "absent" })).toBe(
      "claude refusal omitted its cause",
    );
  });
});

describe("U5 live-proof subject liveness", () => {
  test("a done agent with a live tree stays a proof subject", () => {
    expect(
      proofSubjectLiveness({ agentStatus: "done", tree: "live" }),
    ).toMatchObject({ state: "tree-live" });
    expect(
      proofSubjectLiveness({ agentStatus: "working", tree: "live" }),
    ).toMatchObject({ state: "tree-live" });
  });

  test("one vendor's gone tree does not withhold the others", () => {
    const { keep, drop } = partitionLiveProofSubjects([
      {
        provider: "claude",
        liveness: proofSubjectLiveness({ agentStatus: "working", tree: "live" }),
      },
      {
        provider: "opencode",
        liveness: proofSubjectLiveness({ agentStatus: "done", tree: "absent" }),
      },
      {
        provider: "codex",
        liveness: proofSubjectLiveness({ agentStatus: "done", tree: "live" }),
      },
    ]);
    expect(keep.map((subject) => subject.provider)).toEqual([
      "claude",
      "codex",
    ]);
    expect(drop).toEqual([
      {
        provider: "opencode",
        reason: "session process tree is absent (agent status done)",
      },
    ]);
  });

  test("Stop/Terminate entry keys on the tree, not provider-run busy-ness", () => {
    expect(
      liveRunControlSubjectReady({
        shellState: "retained",
        censusState: "complete",
        liveMemberCount: 2,
        shellRootLive: true,
      }).ready,
    ).toBe(true);
    expect(
      liveRunControlSubjectReady({
        shellState: "retained",
        censusState: "unknown",
        liveMemberCount: 0,
        shellRootLive: true,
      }).ready,
    ).toBe(true);
    expect(
      liveRunControlSubjectReady({
        shellState: "terminated",
        censusState: "terminated",
        liveMemberCount: 0,
        shellRootLive: false,
      }).ready,
    ).toBe(false);
  });
});
