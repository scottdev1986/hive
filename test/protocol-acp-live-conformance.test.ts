import { isRecord, isString } from "../src/shared/is-record";
import type { JsonObject } from "../src/shared/json";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";
import type { AcpProviderSession } from "../src/adapters/providers/protocol/acp-session";
import { definedFields } from "../src/shared/defined-fields";
import {
  GrokAcpAdapter,
  grokAcpSpawn,
} from "../src/adapters/providers/protocol/grok-acp-adapter";
import {
  KimiAcpAdapter,
  kimiAcpSpawn,
} from "../src/adapters/providers/protocol/kimi-acp-adapter";
import {
  OpenCodeAcpAdapter,
  openCodeAcpSpawn,
} from "../src/adapters/providers/protocol/opencode-acp-adapter";
import {
  capabilityFinding,
  capabilitySupport,
  type NormalizedProviderEvent,
  type ProviderRuntimeAdapter,
  type ProviderSpawn,
  type SubmissionReceipt,
  steadyStateUnknowns,
  unprovenBaseline,
} from "../src/adapters/providers/protocol/types";
import type {
  CapabilityName,
  MeasuredProviderCapabilities,
} from "../src/schemas/capability";
import { errorMessage } from "../src/shared/error-message";
import { writeEvidenceFile } from "./evidence-write";
import {
  installedCliVersion,
  requireExecutable,
  requireStagedLiveFile,
  requireSuccessfulTurn,
  requireVerifiedVersion,
} from "./live-prerequisites";

const LIVE = process.env.HIVE_ACP_LIVE === "1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireSettledTurn(
  label: string,
  receipt: SubmissionReceipt,
  seen: readonly NormalizedProviderEvent[],
): Promise<void> {
  if (receipt.outcome !== "accepted" || receipt.turnId === null) {
    requireSuccessfulTurn(label, receipt, seen);
  }
  const deadline = Date.now() + 5_000;
  while (
    Date.now() < deadline &&
    !seen.some(
      (event) =>
        "turnId" in event &&
        event.turnId === receipt.turnId &&
        (event.kind === "turn-idle" ||
          event.kind === "turn-failed" ||
          event.kind === "interrupted"),
    )
  ) {
    await sleep(25);
  }
  requireSuccessfulTurn(label, receipt, seen);
}

function writeEvidence(vendor: string, payload: JsonObject): string {
  const path = join(
    "docs/evidence/protocol-terminal",
    vendor,
    "conformance.json",
  );
  const outcome = writeEvidenceFile(
    path,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  return outcome === "written"
    ? path
    : `${path} (unchanged; set HIVE_WRITE_EVIDENCE=1 to capture)`;
}

function summarizeCapabilities(capabilities: MeasuredProviderCapabilities) {
  const names: CapabilityName[] = [
    "newSession",
    "prompt",
    "cancel",
    "permissions",
    "streamingText",
    "toolLifecycle",
    "sessionRecovery",
    "questions",
    "commandCatalog",
    "modelCatalog",
    "modeCatalog",
    "contextUsage",
    "fork",
    "compact",
    "steering",
  ];
  const out: Record<string, string> = {};
  for (const name of names) {
    const finding = capabilityFinding(capabilities, name);
    out[name] =
      finding.state === "not-reported"
        ? `not-reported: ${finding.absence.reason}`
        : finding.state;
  }
  return out;
}

async function runBaseline(
  vendor: string,
  adapter: ProviderRuntimeAdapter,
  spawn: ProviderSpawn,
  options: {
    exercisePermission: boolean;
    exerciseFork: boolean;
    exerciseClose: boolean;
    /**
     * The vendor's own name for a mode that still asks before running a tool.
     * Only a vendor whose session opens autonomous needs one: the others
     * already ask, and mode names are not shared between vendors — Kimi's
     * "default" is not a mode OpenCode has.
     */
    manualMode?: string;
    /** Kimi: exercise a question through the permission reverse-RPC. */
    exerciseQuestion?: boolean;
    /** Kimi: measure load replay and prove reattach on a fresh process. */
    measureReplay?: boolean;
    /** Vendor version series this proof has re-verified. */
    verifiedSeries: string;
  },
): Promise<{
  steps: Record<string, string>;
  capabilities: Record<string, string>;
  unproven: string[];
  steadyStateUnknowns: string[];
  events: string[];
  version: string;
}> {
  const steps: Record<string, string> = {};
  const env = { ...spawn.env };

  const probe = await adapter.probe(spawn.executable);
  const version = requireVerifiedVersion(
    vendor,
    probe.version ?? installedCliVersion(spawn.executable),
    options.verifiedSeries,
  );
  steps["1-initialize-probe"] =
    probe.verdict === "compatible" ? "pass" : `fail: ${probe.reason ?? ""}`;

  // SAFETY: The test owns this value and its fields.
  const session = (await adapter.connect({
    ...spawn,
    env,
  })) as AcpProviderSession;
  const seen: NormalizedProviderEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events) {
      seen.push(event);
    }
  })();

  try {
    // 2. create session without a model prompt where protocol permits.
    // A permission reverse-RPC can only be measured from a session that still
    // stops to ask, and a vendor launched autonomous never does — so that one
    // names the mode that asks. The name belongs to the caller: it is the
    // vendor's own vocabulary, and sending one vendor's name to another is
    // rejected outright.
    const created = await session.newSession({
      cwd: spawn.cwd,
      ...definedFields({ mode: options.manualMode }),
    });
    steps["2-new-session"] = created.vendorSessionId ? "pass" : "fail";

    // 3. isolated prompt + stream + terminal completion
    const receipt = await session.submit({
      session: created,
      clientInputId: `${vendor}-prompt-1`,
      text: "Reply with exactly the single word PONG and nothing else. Do not use tools.",
    });
    try {
      await requireSettledTurn(`${vendor} prompt`, receipt, seen);
      const streamed = seen.some(
        (event) =>
          event.kind === "message-delta" && event.turnId === receipt.turnId,
      );
      if (!streamed) throw new Error(`${vendor} prompt emitted no message`);
      steps["3-prompt-complete"] = "pass";
    } catch (error) {
      steps["3-prompt-complete"] = `fail: ${errorMessage(error)}`;
      throw error;
    }

    // 4. permission allow + deny (Grok requires non-yolo config; OpenCode may
    // auto-allow depending on project permission config — record honestly).
    if (options.exercisePermission) {
      steps["4a-permission-deny"] = await exercisePermission(
        session,
        seen,
        created,
        vendor,
        "deny",
      );
      steps["4b-permission-allow"] = await exercisePermission(
        session,
        seen,
        created,
        vendor,
        "allow",
      );
    } else {
      steps["4-permission"] = "skipped";
    }

    // 4c. question through the same reverse-RPC, answered as a question.
    if (options.exerciseQuestion === true) {
      steps["4c-question"] = await exerciseQuestion(
        session,
        seen,
        created,
        vendor,
      );
    }

    // 5. cancel a running turn
    const cancelSubmit = session.submit({
      session: created,
      clientInputId: `${vendor}-cancel`,
      text:
        "Write a very long essay of at least 2000 words about the history of computing. " +
        "Do not use tools. Start writing immediately.",
    });
    // Give the turn a moment to start, then cancel.
    await sleep(800);
    await session.cancel(`${vendor}-cancel`);
    const cancelResult = await cancelSubmit;
    const cancelDeadline = Date.now() + 5_000;
    let cancelObserved = false;
    while (
      Date.now() < cancelDeadline &&
      cancelResult.outcome === "accepted" &&
      cancelResult.turnId !== null
    ) {
      cancelObserved = seen.some(
        (event) =>
          event.kind === "interrupted" && event.turnId === cancelResult.turnId,
      );
      if (cancelObserved) break;
      await sleep(25);
    }
    steps["5-cancel"] = cancelObserved
      ? "pass"
      : `fail: outcome=${cancelResult.outcome}`;

    // 6. resume/load
    try {
      const loaded = await session.resumeSession({
        vendorSessionId: created.vendorSessionId,
        style: "load",
      });
      steps["6-load"] = loaded.vendorSessionId ? "pass" : "fail";
      if (options.measureReplay === true) {
        // Same process, session already live: kimi replays nothing here
        // (measured). Replay truth lives in the fresh-process reattach below.
        steps["6a-load-same-process-replay"] = loaded.replayedHistory
          ? "measured: replayed"
          : "measured: no-replay";
        const resumed = await session.resumeSession({
          vendorSessionId: created.vendorSessionId,
          style: "resume",
        });
        steps["6b-resume-no-replay"] = resumed.replayedHistory
          ? "fail: resume observed replay frames"
          : "pass";
      }
    } catch (error) {
      steps["6-load"] =
        `fail: ${error instanceof Error ? error.message : error}`;
    }

    // 7. discover commands/models
    const commands = await session.listCommands();
    const hasUndo = commands.some(
      (command) => command.name === "undo" || command.name === "redo",
    );
    steps["7-commands"] = hasUndo
      ? "fail: undo/redo advertised"
      : commands.length > 0 ||
          capabilitySupport(session.capabilities, "commandCatalog") !==
            "unknown" ||
          capabilitySupport(session.capabilities, "modelCatalog") ===
            "supported"
        ? "pass"
        : "unknown";

    if (options.exerciseFork) {
      try {
        const forked = await session.forkSession();
        steps["7b-fork"] = forked.vendorSessionId ? "pass" : "fail";
      } catch (error) {
        steps["7b-fork"] =
          `fail: ${error instanceof Error ? error.message : error}`;
      }
    }

    // 8. disconnect (close)
    await session.close();
    steps["8-close"] = "pass";

    // 8b. disconnect + reattach on a fresh vendor process: load replays
    // history (measured, not asserted) and no prompt is duplicated.
    if (options.measureReplay === true) {
      // SAFETY: The test owns this value and its fields.
      const reattach = (await adapter.connect({
        ...spawn,
        env,
      })) as AcpProviderSession;
      const reseen: NormalizedProviderEvent[] = [];
      const rereader = (async () => {
        for await (const event of reattach.events) reseen.push(event);
      })();
      try {
        const reloaded = await reattach.resumeSession({
          vendorSessionId: created.vendorSessionId,
          style: "load",
        });
        steps["8b-reattach-load-replay"] = reloaded.replayedHistory
          ? "pass"
          : "fail: fresh-process load observed no replay frames";
        const duplicated = reseen.some(
          (event) => event.kind === "turn-started",
        );
        steps["8c-reattach-no-duplicate-prompt"] = duplicated
          ? "fail: reattach observed a new turn"
          : "pass";
      } catch (error) {
        steps["8b-reattach-load-replay"] =
          `fail: ${error instanceof Error ? error.message : error}`;
      } finally {
        await reattach.close();
        await Promise.race([rereader, sleep(500)]);
      }
    }
  } catch (error) {
    steps.error = errorMessage(error);
    try {
      await session.close();
    } catch {
      // ignore
    }
  }

  // Drain reader
  await Promise.race([reader, sleep(500)]);

  return {
    steps,
    capabilities: summarizeCapabilities(session.capabilities),
    unproven: [...unprovenBaseline(session.capabilities)],
    steadyStateUnknowns: [...steadyStateUnknowns(session.capabilities)],
    events: seen.map((event) => event.kind),
    version,
  };
}

async function exercisePermission(
  session: AcpProviderSession,
  seen: NormalizedProviderEvent[],
  created: { vendorSessionId: string; replayedHistory: boolean },
  vendor: string,
  outcome: "allow" | "deny",
): Promise<string> {
  const tag = outcome === "allow" ? "allow" : "deny";
  const from = seen.length;
  const submitPromise = session.submit({
    session: created,
    clientInputId: `${vendor}-perm-${tag}`,
    text:
      `You MUST use a shell/terminal tool exactly once to run: echo hive-acp-perm-${tag}. ` +
      "Do not skip the tool. Do not claim you ran it without invoking the tool.",
  });

  try {
    await waitForApproval(session, seen, from, 45_000, outcome);
  } catch (error) {
    // Let the turn finish so we can keep the rest of the baseline sequence.
    try {
      await submitPromise;
    } catch {
      // ignore
    }
    return `unknown: ${errorMessage(error)}`;
  }

  const result = await submitPromise;
  try {
    await requireSettledTurn(`${vendor} permission ${tag}`, result, seen);
    return "pass";
  } catch (error) {
    return `fail: ${errorMessage(error)}`;
  }
}

async function waitForApproval(
  session: AcpProviderSession,
  seen: NormalizedProviderEvent[],
  from: number,
  timeoutMs: number,
  outcome: "allow" | "deny",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const settled = new Set<string>();
  while (Date.now() < deadline) {
    for (const event of seen.slice(from)) {
      if (event.kind !== "approval-waiting") continue;
      if (settled.has(event.requestId)) continue;
      const already = seen.some(
        (candidate) =>
          candidate.kind === "elicitation-settled" &&
          candidate.requestId === event.requestId,
      );
      if (already) {
        settled.add(event.requestId);
        continue;
      }
      await session.respondToPermission({
        requestId: event.requestId,
        outcome,
      });
      settled.add(event.requestId);
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for approval-waiting (${outcome})`);
}

async function exerciseQuestion(
  session: AcpProviderSession,
  seen: NormalizedProviderEvent[],
  created: { vendorSessionId: string; replayedHistory: boolean },
  vendor: string,
): Promise<string> {
  const from = seen.length;
  const submitPromise = session.submit({
    session: created,
    clientInputId: `${vendor}-question`,
    text:
      "You MUST call your AskUserQuestion tool exactly once to ask me to pick one: alpha or beta? " +
      "Do not skip the tool.",
  });
  try {
    await waitForQuestion(session, seen, from, 60_000);
  } catch (error) {
    try {
      await submitPromise;
    } catch {
      // ignore
    }
    return `unknown: ${errorMessage(error)}`;
  }
  const result = await submitPromise;
  try {
    await requireSettledTurn(`${vendor} question`, result, seen);
    const answered = seen
      .slice(from)
      .some(
        (event) =>
          event.kind === "elicitation-settled" && event.outcome === "answered",
      );
    return answered ? "pass" : "fail: question was not answered";
  } catch (error) {
    return `fail: ${errorMessage(error)}`;
  }
}

async function waitForQuestion(
  session: AcpProviderSession,
  seen: NormalizedProviderEvent[],
  from: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of seen.slice(from)) {
      if (event.kind !== "question-waiting") continue;
      const already = seen.some(
        (candidate) =>
          candidate.kind === "elicitation-settled" &&
          candidate.requestId === event.requestId,
      );
      if (already) continue;
      const optionId = firstAnswerOption(event.raw);
      await session.respondToPermission(
        optionId !== null
          ? { requestId: event.requestId, outcome: "allow", optionId }
          : { requestId: event.requestId, outcome: "allow" },
      );
      return;
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for question-waiting");
}

/** First answer option that is not a skip/reject, from the raw request payload. */
function firstAnswerOption<T>(raw: T): string | null {
  if (!isRecord(raw) && !Array.isArray(raw)) return null;
  // SAFETY: The test owns this value and its fields.
  const options = (raw as { options?: unknown }).options;
  if (!Array.isArray(options)) return null;
  for (const entry of options) {
    if (!isRecord(entry) && !Array.isArray(entry)) continue;
    // SAFETY: The test owns this value and its fields.
    const rec = entry as { optionId?: unknown; kind?: unknown };
    if (!isString(rec.optionId)) continue;
    if (isString(rec.kind) && rec.kind.startsWith("reject")) continue;
    return rec.optionId;
  }
  return null;
}

describe("live ACP baseline conformance", () => {
  test.skipIf(!LIVE)(
    "Grok 1.0.x baseline sequence",
    async () => {
      const executable = requireExecutable("Grok", which("grok"));
      requireStagedLiveFile(
        "HIVE_LIVE_GROK_AUTH_FILE",
        join(process.env.GROK_HOME ?? "", "auth.json"),
      );
      requireStagedLiveFile(
        "HIVE_LIVE_GROK_CONFIG_FILE",
        join(process.env.GROK_HOME ?? "", "config.toml"),
      );

      const cwd = join(tmpdir(), `hive-grok-cwd-${process.pid}`);
      mkdirSync(cwd, { recursive: true });

      const adapter = new GrokAcpAdapter();
      const spawn = grokAcpSpawn(executable, cwd);
      const result = await runBaseline(
        "grok",
        adapter,
        {
          ...spawn,
          argv: ["--permission-mode", "default", ...spawn.argv],
        },
        {
          exercisePermission: true,
          exerciseFork: false,
          exerciseClose: true,
          verifiedSeries: "1.0",
        },
      );

      const path = writeEvidence("grok", {
        vendor: "grok",
        sequence: "§2.3 baseline",
        capturedAt: new Date().toISOString(),
        ...result,
        notes: [
          "session/cancel is a notification; request form returns -32601",
          "permission reverse-RPC requires permission_mode!=always-approve",
          "undo/redo N/A for grok (not in catalog)",
        ],
      });

      expect(result.steps["1-initialize-probe"]).toBe("pass");
      expect(result.steps["2-new-session"]).toBe("pass");
      expect(result.steps["3-prompt-complete"]).toBe("pass");
      expect(result.steps["4a-permission-deny"]).toBe("pass");
      expect(result.steps["4b-permission-allow"]).toBe("pass");
      expect(result.steps["5-cancel"]).toBe("pass");
      expect(result.steps["8-close"]).toBe("pass");
      // Baseline must be fully measured after this run.
      expect(result.unproven).toEqual([]);
      // Scott: unknown is not acceptable in steady state.
      expect(result.steadyStateUnknowns).toEqual([]);
      expect(path).toContain("conformance.json");
    },
    600_000,
  );

  test.skipIf(!LIVE)(
    "OpenCode 1.18.x baseline sequence",
    async () => {
      const executable = requireExecutable("OpenCode", which("opencode"));
      requireStagedLiveFile(
        "HIVE_LIVE_OPENCODE_AUTH_FILE",
        join(process.env.XDG_DATA_HOME ?? "", "opencode", "auth.json"),
      );

      const cwd = join(tmpdir(), `hive-opencode-cwd-${process.pid}`);
      mkdirSync(cwd, { recursive: true });
      // Force tool permission prompts at the project config layer. Without this
      // the installed runtime may auto-allow bash and never emit reverse-RPC.
      await Bun.write(
        join(cwd, "opencode.json"),
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            permission: {
              bash: "ask",
              edit: "ask",
              write: "ask",
              "*": "ask",
            },
          },
          null,
          2,
        ),
      );

      const adapter = new OpenCodeAcpAdapter();
      // Production spawn: plugins/config enabled (no --pure).
      const result = await runBaseline(
        "opencode",
        adapter,
        openCodeAcpSpawn(executable, cwd),
        {
          exercisePermission: true,
          exerciseFork: true,
          exerciseClose: true,
          verifiedSeries: "1.18",
        },
      );

      const path = writeEvidence("opencode", {
        vendor: "opencode",
        sourcePin: "1882c33827cf0ce5c948b69ab5a87ed8f6790cf8",
        sequence: "§2.3 baseline",
        capturedAt: new Date().toISOString(),
        ...result,
        documentedGaps: {
          undo_redo: "ABSENT — never advertised through ACP",
        },
        notes: [
          "spawn is `opencode acp` with user config/plugins enabled",
          "--pure is test-only and was not used",
        ],
      });

      expect(result.steps["1-initialize-probe"]).toBe("pass");
      expect(result.steps["2-new-session"]).toBe("pass");
      expect(result.steps["3-prompt-complete"]).toBe("pass");
      expect(result.steps["5-cancel"]).toBe("pass");
      expect(result.steps["8-close"]).toBe("pass");
      // undo/redo must never appear
      expect(result.steps["7-commands"]).not.toBe("fail: undo/redo advertised");
      // Permissions: only claim supported when live reverse-RPC was settled.
      if (result.steps["4a-permission-deny"] === "pass") {
        expect(result.capabilities.permissions).toBe("supported");
      } else {
        expect(result.capabilities.permissions).not.toBe("supported");
      }
      // Scott: unknown is not acceptable in steady state.
      expect(result.steadyStateUnknowns).toEqual([]);
      expect(path).toContain("conformance.json");
    },
    600_000,
  );

  test.skipIf(!LIVE)(
    "Kimi 0.35.x baseline sequence",
    async () => {
      const executable = requireExecutable("Kimi", which("kimi"));
      requireStagedLiveFile(
        "HIVE_LIVE_KIMI_AUTH_FILE",
        join(process.env.KIMI_CODE_HOME ?? "", "credentials", "kimi-code.json"),
      );
      requireStagedLiveFile(
        "HIVE_LIVE_KIMI_OAUTH_FILE",
        join(process.env.KIMI_CODE_HOME ?? "", "oauth", "kimi-code"),
      );
      requireStagedLiveFile(
        "HIVE_LIVE_KIMI_CONFIG_FILE",
        join(process.env.KIMI_CODE_HOME ?? "", "config.toml"),
      );

      const cwd = join(tmpdir(), `hive-kimi-cwd-${process.pid}`);
      mkdirSync(cwd, { recursive: true });

      const adapter = new KimiAcpAdapter();
      const result = await runBaseline(
        "kimi",
        adapter,
        kimiAcpSpawn(executable, cwd),
        {
          exercisePermission: true,
          // Kimi is the one vendor Hive launches autonomous, so it is the one
          // that has to be put back into asking to measure the reverse-RPC.
          manualMode: "default",
          exerciseFork: false,
          exerciseClose: true,
          exerciseQuestion: true,
          measureReplay: true,
          verifiedSeries: "0.35",
        },
      );

      const path = writeEvidence("kimi", {
        vendor: "kimi",
        sourcePin: "e22479a62eed9c3b78a67b313f4332c2c0ba9670",
        sequence: "§2.3 baseline",
        capturedAt: new Date().toISOString(),
        ...result,
        notes: [
          "session/cancel is a notification; request form returns -32601",
          "questions share the permission reverse-RPC (AskUserQuestion)",
          "same-process load of a live session replays nothing (measured)",
          "fresh-process session/load replays history; session/resume does not",
          "models/efforts/modes are configOptions set via session/set_config_option",
        ],
      });

      expect(result.steps["1-initialize-probe"]).toBe("pass");
      expect(result.steps["2-new-session"]).toBe("pass");
      expect(result.steps["3-prompt-complete"]).toBe("pass");
      expect(result.steps["4a-permission-deny"]).toBe("pass");
      expect(result.steps["4b-permission-allow"]).toBe("pass");
      expect(result.steps["4c-question"]).toBe("pass");
      expect(result.steps["5-cancel"]).toBe("pass");
      expect(result.steps["6b-resume-no-replay"]).toBe("pass");
      expect(result.steps["8-close"]).toBe("pass");
      expect(result.steps["8b-reattach-load-replay"]).toBe("pass");
      expect(result.steps["8c-reattach-no-duplicate-prompt"]).toBe("pass");
      // Questions measured supported on kimi; baseline fully measured.
      expect(result.capabilities.questions).toBe("supported");
      expect(result.unproven).toEqual([]);
      // Scott: unknown is not acceptable in steady state.
      expect(result.steadyStateUnknowns).toEqual([]);
      expect(path).toContain("conformance.json");
    },
    600_000,
  );
});
