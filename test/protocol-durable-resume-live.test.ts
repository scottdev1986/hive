import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";
import { CodexAppServerAdapter } from "../src/adapters/providers/codex-app-server/runtime-adapter";
import {
  type DurableSessionRecord,
  openProviderSession,
  readStoredSession,
} from "../src/adapters/providers/protocol/durable-session";
import {
  OpenCodeAcpAdapter,
  openCodeAcpSpawn,
} from "../src/adapters/providers/protocol/opencode-acp-adapter";
import type {
  NormalizedProviderEvent,
  ProviderRuntimeAdapter,
  ProviderSession,
  ProviderSpawn,
  VendorSessionRef,
} from "../src/adapters/providers/protocol/types";
import { writeEvidenceFile } from "./evidence-write";
import {
  requireExecutable,
  requireStagedLiveFile,
  requireSuccessfulTurn,
  requireVerifiedVersion,
} from "./live-prerequisites";

const LIVE = process.env.HIVE_DURABLE_RESUME_LIVE === "1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/** Drains a session's events into an array for the life of the session. */
function startReader(session: ProviderSession): {
  seen: NormalizedProviderEvent[];
  done: Promise<void>;
} {
  const seen: NormalizedProviderEvent[] = [];
  const done = (async () => {
    for await (const event of session.events) seen.push(event);
  })();
  return { seen, done };
}

/**
 * Wait until the session stops producing events. A `load` resume replays the
 * earlier turns, and those replayed frames would otherwise be read as the
 * answer to the next question.
 */
async function quiet(
  seen: NormalizedProviderEvent[],
  idleMs = 750,
  capMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + capMs;
  let count = seen.length;
  let changedAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(100);
    if (seen.length !== count) {
      count = seen.length;
      changedAt = Date.now();
      continue;
    }
    if (Date.now() - changedAt >= idleMs) return;
  }
}

/**
 * Submit one prompt and return everything the model said. Waits for a terminal
 * turn event rather than trusting the submit call, because one transport
 * answers when the turn ends and the other answers when it starts.
 */
async function ask(
  session: ProviderSession,
  vendorSession: VendorSessionRef,
  seen: NormalizedProviderEvent[],
  clientInputId: string,
  text: string,
  timeoutMs = 180_000,
): Promise<string> {
  const from = seen.length;
  const receipt = await session.submit({
    session: vendorSession,
    clientInputId,
    text,
  });
  if (receipt.outcome !== "accepted") {
    throw new Error(
      `submit ${clientInputId} was ${receipt.outcome}: ${receipt.detail ?? "no detail"}`,
    );
  }
  const deadline = Date.now() + timeoutMs;
  let settled = false;
  while (Date.now() < deadline) {
    const terminal = seen
      .slice(from)
      .some(
        (event) =>
          event.kind === "turn-idle" ||
          event.kind === "turn-failed" ||
          event.kind === "interrupted",
      );
    if (terminal) {
      settled = true;
      break;
    }
    await sleep(100);
  }
  if (!settled) throw new Error(`${clientInputId} timed out before settling`);
  requireSuccessfulTurn(clientInputId, receipt, seen.slice(from));
  return seen
    .slice(from)
    .flatMap((event) => (event.kind === "message-delta" ? [event.text] : []))
    .join("");
}

function writeEvidence(vendor: string, payload: Record<string, unknown>): void {
  writeEvidenceFile(
    join("docs/evidence/protocol-terminal", vendor, "durable-resume.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

interface DurableResumeResult {
  readonly steps: Record<string, string>;
  readonly created: DurableSessionRecord;
  readonly resumedVendorSessionId: string;
}

/**
 * The whole sequence on one vendor: create and record, crash, resume from the
 * record alone, then prove version metadata does not block the protocol.
 */
async function proveDurableResume(
  vendor: string,
  makeAdapter: () => ProviderRuntimeAdapter,
  spawn: ProviderSpawn,
  store: string,
  passphrase: string,
): Promise<DurableResumeResult> {
  const steps: Record<string, string> = {};

  const first = await openProviderSession(makeAdapter(), spawn, store);
  const firstReader = startReader(first.session);
  steps["1-first-start-has-no-stored-ref"] =
    first.decision.outcome === "no-stored-session"
      ? "pass"
      : `fail: ${first.decision.outcome}`;

  const stored = await readStoredSession(store);
  if (stored.state !== "present") {
    throw new Error(`session ref was not recorded: ${stored.state}`);
  }
  steps["2-ref-recorded-at-creation"] =
    stored.record.session.vendorSessionId ===
    first.vendorSession.vendorSessionId
      ? "pass"
      : "fail: recorded a different id than the vendor issued";

  const planted = await ask(
    first.session,
    first.vendorSession,
    firstReader.seen,
    `${vendor}-plant`,
    `Remember this passphrase exactly: ${passphrase}. Reply with only the word STORED. Do not use tools.`,
  );
  steps["3-fact-planted"] = planted.length > 0 ? "pass" : "fail: no reply";

  // The crash: the vendor child goes with the session.
  await first.session.close();
  await Promise.race([firstReader.done, sleep(2_000)]);
  steps["4-session-closed"] = "pass";

  // A brand new adapter and a brand new vendor process. Everything it knows
  // about the earlier conversation comes out of the record.
  const second = await openProviderSession(makeAdapter(), spawn, store);
  const secondReader = startReader(second.session);
  steps["5-resume-decided-from-the-record"] =
    second.decision.outcome === "resume" &&
    second.decision.vendorSessionId === stored.record.session.vendorSessionId
      ? "pass"
      : `fail: ${second.decision.outcome}`;
  steps["6-resumed-the-same-conversation"] =
    second.vendorSession.vendorSessionId ===
    stored.record.session.vendorSessionId
      ? "pass"
      : "fail: the vendor answered with a different session id";

  // The replayed history is drained first, and the answer has to carry a token
  // that was never said before the crash. Between them, a replayed frame cannot
  // be mistaken for the model recalling anything.
  await quiet(secondReader.seen);
  const recallToken = `${passphrase}-RECALLED`;
  const recalled = await ask(
    second.session,
    second.vendorSession,
    secondReader.seen,
    `${vendor}-recall`,
    `What passphrase did I ask you to remember? Reply with that passphrase followed by the word RECALLED, joined by a hyphen, and nothing else. Do not use tools.`,
  );
  steps["7-history-survived-the-crash"] = recalled.includes(recallToken)
    ? "pass"
    : `fail: reply did not contain ${recallToken} (${recalled.slice(0, 120)})`;

  await second.session.close();
  await Promise.race([secondReader.done, sleep(2_000)]);

  // Version is evidence, not compatibility authority. The vendor gets to
  // decide whether the same session id still works after an upgrade.
  const tampered: DurableSessionRecord = {
    ...stored.record,
    identity: { ...stored.record.identity, version: "0.0.0-not-installed" },
  };
  await writeFile(store, `${JSON.stringify(tampered, null, 2)}\n`);
  const third = await openProviderSession(makeAdapter(), spawn, store);
  const thirdReader = startReader(third.session);
  steps["8-version-metadata-does-not-block-resume"] =
    third.decision.outcome === "resume"
      ? "pass"
      : `fail: ${third.decision.outcome}`;
  steps["9-version-change-keeps-the-conversation"] =
    third.vendorSession.vendorSessionId ===
    stored.record.session.vendorSessionId
      ? "pass"
      : "fail: opened a different conversation";
  await third.session.close();
  await Promise.race([thirdReader.done, sleep(2_000)]);

  return {
    steps,
    created: stored.record,
    resumedVendorSessionId: second.vendorSession.vendorSessionId,
  };
}

function assertPassed(result: DurableResumeResult): void {
  for (const [step, verdict] of Object.entries(result.steps)) {
    expect(`${step}=${verdict.split(":")[0]}`).toBe(`${step}=pass`);
  }
}

(LIVE ? test : test.skip)(
  "OpenCode 1.18.x resumes from the recorded ref alone",
  async () => {
    const executable = requireExecutable("OpenCode", which("opencode"));
    requireStagedLiveFile(
      "HIVE_LIVE_OPENCODE_AUTH_FILE",
      join(process.env.XDG_DATA_HOME ?? "", "opencode", "auth.json"),
    );
    const probe = await new OpenCodeAcpAdapter().probe(executable);
    const version = requireVerifiedVersion("OpenCode", probe.version, "1.18");
    const cwd = join(tmpdir(), `hive-durable-opencode-${process.pid}`);
    const pane = join(tmpdir(), `hive-durable-opencode-pane-${process.pid}`);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(pane, { recursive: true });
    const store = join(pane, "session.json");
    const passphrase = `HIVE-OPENCODE-${process.pid}`;

    const result = await proveDurableResume(
      "opencode",
      () => new OpenCodeAcpAdapter(),
      openCodeAcpSpawn(executable, cwd, readEnvironment()),
      store,
      passphrase,
    );

    writeEvidence("opencode", {
      vendor: "opencode",
      version,
      transport: "acp",
      proof: "durable provider resume (§12 replacement)",
      capturedAt: new Date().toISOString(),
      passphrase,
      ...result,
      notes: [
        "resume goes through ProviderSession.resumeSession (session/load)",
        "the resumed id came from the recorded ref, not from a scan",
      ],
    });

    assertPassed(result);
  },
  900_000,
);

(LIVE ? test : test.skip)(
  "Codex 0.147.x resumes from the recorded ref alone",
  async () => {
    const executable = requireExecutable("Codex", which("codex"));
    requireStagedLiveFile(
      "HIVE_LIVE_CODEX_AUTH_FILE",
      join(process.env.CODEX_HOME ?? "", "auth.json"),
    );
    requireStagedLiveFile(
      "HIVE_LIVE_CODEX_CONFIG_FILE",
      join(process.env.CODEX_HOME ?? "", "config.toml"),
    );
    const probe = await new CodexAppServerAdapter().probe(executable);
    const version = requireVerifiedVersion("Codex", probe.version, "0.147");
    const cwd = join(tmpdir(), `hive-durable-codex-${process.pid}`);
    const pane = join(tmpdir(), `hive-durable-codex-pane-${process.pid}`);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(pane, { recursive: true });
    const store = join(pane, "session.json");
    const passphrase = `HIVE-CODEX-${process.pid}`;

    const result = await proveDurableResume(
      "codex",
      () => new CodexAppServerAdapter({ approvalTimeoutMs: 15_000 }),
      {
        provider: "codex",
        executable,
        argv: [],
        cwd,
        env: readEnvironment(),
      },
      store,
      passphrase,
    );

    writeEvidence("codex", {
      vendor: "codex",
      version,
      transport: "codex-app-server",
      proof: "durable provider resume (§12 replacement)",
      capturedAt: new Date().toISOString(),
      passphrase,
      ...result,
      notes: [
        "resume goes through ProviderSession.resumeSession (thread/resume)",
        "the resumed id came from the recorded ref, not from a rollout scan",
      ],
    });

    assertPassed(result);
  },
  900_000,
);
