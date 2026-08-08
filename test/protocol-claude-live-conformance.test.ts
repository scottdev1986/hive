import { expect, test } from "bun:test";
import { join } from "node:path";
import { which } from "bun";
import { ClaudeStreamJsonAdapter } from "../src/adapters/providers/protocol/claude-runtime-adapter";
import type {
  ClaudeProcess,
  ClaudeProcessFactory,
} from "../src/adapters/providers/protocol/claude-stream-process";
import {
  type NormalizedProviderEvent,
  type ProviderSession,
  type ProviderSpawn,
  steadyStateUnknowns,
} from "../src/adapters/providers/protocol/types";
import { writeEvidenceFile } from "./evidence-write";
import {
  requireExecutable,
  requireStagedLiveFile,
  requireVerifiedVersion,
} from "./live-prerequisites";

const LIVE = process.env.HIVE_CLAUDE_LIVE === "1";
const EVIDENCE_PATH = "docs/evidence/protocol-terminal/claude/conformance.json";

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(value: string): string {
  return value.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "<session-id>",
  );
}

async function waitForEvent(
  events: readonly NormalizedProviderEvent[],
  predicate: (event: NormalizedProviderEvent) => boolean,
  label: string,
  timeoutMs = 45_000,
): Promise<NormalizedProviderEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event !== undefined) return event;
    await sleep(25);
  }
  throw new Error(`timed out waiting for Claude ${label}`);
}

function record(session: ProviderSession): {
  readonly events: NormalizedProviderEvent[];
  readonly finished: Promise<void>;
} {
  const events: NormalizedProviderEvent[] = [];
  const finished = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return { events, finished };
}

interface LaunchEvidence {
  readonly pid: number;
  readonly command: readonly string[];
  readonly stdio: "pipes";
  readonly processObservation: string;
  readonly processGroupMatchesParent: boolean;
}

function capturingProcessFactory(
  launches: LaunchEvidence[],
  stderrOutput: string[],
): ClaudeProcessFactory {
  return (command, options) => {
    const child = Bun.spawn([...command], {
      cwd: options.cwd,
      env: { ...options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const observation = Bun.spawnSync([
      "ps",
      "-p",
      String(child.pid),
      "-o",
      "pid=,ppid=,pgid=,tty=,command=",
    ])
      .stdout.toString()
      .trim();
    const parentProcessGroup = Bun.spawnSync([
      "ps",
      "-p",
      String(process.pid),
      "-o",
      "pgid=",
    ])
      .stdout.toString()
      .trim();
    const childProcessGroup = observation.trim().split(/\s+/)[2];
    launches.push({
      pid: child.pid,
      command: [...command],
      stdio: "pipes",
      processObservation: observation,
      processGroupMatchesParent: childProcessGroup === parentProcessGroup,
    });
    const capturedStderr = (async function* (): AsyncGenerator<Uint8Array> {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        stderrOutput.push(decoder.decode(chunk, { stream: true }));
        yield chunk;
      }
      const tail = decoder.decode();
      if (tail.length > 0) stderrOutput.push(tail);
    })();
    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: capturedStderr,
      exited: child.exited,
      kill: (signal) => child.kill(signal),
    } as ClaudeProcess;
  };
}

async function runTurn(
  session: ProviderSession,
  events: readonly NormalizedProviderEvent[],
  reference: { vendorSessionId: string; replayedHistory: boolean },
  clientInputId: string,
  text: string,
  permission?: "allow" | "deny",
): Promise<string> {
  const firstSequence = events.at(-1)?.sequence ?? 0;
  const receipt = await session.submit({
    session: reference,
    clientInputId,
    text,
  });
  if (receipt.outcome !== "accepted" || receipt.turnId === null) {
    throw new Error(`Claude rejected ${clientInputId}: ${receipt.outcome}`);
  }
  if (permission !== undefined) {
    const approval = await waitForEvent(
      events,
      (event) =>
        event.sequence > firstSequence &&
        event.kind === "approval-waiting" &&
        event.turnId === receipt.turnId,
      `${clientInputId} approval`,
    );
    if (approval.kind !== "approval-waiting")
      throw new Error("approval missing");
    await session.respondToPermission({
      requestId: approval.requestId,
      outcome: permission,
    });
  }
  const terminal = await waitForEvent(
    events,
    (event) =>
      event.sequence > firstSequence &&
      (event.kind === "turn-idle" ||
        event.kind === "turn-failed" ||
        event.kind === "interrupted") &&
      event.turnId === receipt.turnId,
    `${clientInputId} terminal event`,
  );
  if (terminal.kind === "turn-failed") {
    throw new Error(`${clientInputId} failed: ${terminal.reason}`);
  }
  if (terminal.kind === "interrupted") {
    throw new Error(`${clientInputId} was interrupted`);
  }
  return receipt.turnId;
}

test.skipIf(!LIVE)(
  "installed Claude 2.1.x passes §2.3 baseline conformance",
  async () => {
    const executable = requireExecutable("Claude", which("claude"));
    requireStagedLiveFile(
      "HIVE_LIVE_CLAUDE_CREDENTIAL_FILE",
      join(process.env.HOME ?? "", ".claude", ".credentials.json"),
    );
    requireStagedLiveFile(
      "HIVE_LIVE_CLAUDE_CONFIG_FILE",
      join(process.env.HOME ?? "", ".claude.json"),
    );
    const steps: Record<string, string> = {};
    const launches: LaunchEvidence[] = [];
    const stderrOutput: string[] = [];
    const adapter = new ClaudeStreamJsonAdapter({
      processFactory: capturingProcessFactory(launches, stderrOutput),
    });
    const spawn: ProviderSpawn = {
      provider: "claude",
      executable,
      argv: [
        "--model",
        "haiku",
        "--permission-mode",
        "default",
        "--settings",
        JSON.stringify({ permissions: { ask: ["Bash"] } }),
      ],
      cwd: process.cwd(),
      env: environment(),
    };

    const probe = await adapter.probe(executable);
    const version = requireVerifiedVersion("Claude", probe.version, "2.1");
    steps["1-initialize-probe"] =
      probe.verdict === "compatible"
        ? "pass"
        : `fail: ${probe.reason ?? version}`;

    let session = await adapter.connect(spawn);
    let log = record(session);
    const created = await session.newSession({
      cwd: spawn.cwd,
      model: "haiku",
    });
    steps["2-new-session"] = created.vendorSessionId ? "pass" : "fail";

    const promptTurn = await runTurn(
      session,
      log.events,
      created,
      "claude-prompt-1",
      "Reply with exactly the single word PONG and nothing else. Do not use tools.",
    );
    const promptText = log.events
      .filter(
        (event) =>
          event.kind === "message-delta" && event.turnId === promptTurn,
      )
      .map((event) => (event.kind === "message-delta" ? event.text : ""))
      .join("");
    steps["3-prompt-complete"] =
      promptText === "PONG" ? "pass" : `fail: ${promptText}`;

    await runTurn(
      session,
      log.events,
      created,
      "claude-permission-deny",
      "Use the Bash tool exactly once to run pwd. Do not use any other tool. Then reply DENIED.",
      "deny",
    );
    steps["4a-permission-deny"] = "pass";
    await runTurn(
      session,
      log.events,
      created,
      "claude-permission-allow",
      "Use the Bash tool exactly once to run pwd. Do not use any other tool. Then reply ALLOWED.",
      "allow",
    );
    const hasToolLifecycle =
      log.events.some((event) => event.kind === "tool-started") &&
      log.events.some((event) => event.kind === "tool-finished");
    steps["4b-permission-allow"] = hasToolLifecycle
      ? "pass"
      : "fail: tool lifecycle incomplete";

    const cancelReceipt = await session.submit({
      session: created,
      clientInputId: "claude-cancel",
      text: "Write the integers from 1 through 10000, one per line, without using tools.",
    });
    if (cancelReceipt.turnId === null)
      throw new Error("cancel turn was not accepted");
    await session.cancel(cancelReceipt.turnId);
    await waitForEvent(
      log.events,
      (event) =>
        event.kind === "interrupted" && event.turnId === cancelReceipt.turnId,
      "cancel interruption",
    );
    steps["5-cancel"] = "pass";

    const resumed = await session.resumeSession({
      vendorSessionId: created.vendorSessionId,
      style: "resume",
    });
    steps["6-resume"] =
      resumed.vendorSessionId === created.vendorSessionId &&
      !resumed.replayedHistory
        ? "pass"
        : "fail";

    const commands = await session.listCommands();
    const handshake = session.capabilities.handshake as {
      models?: unknown[];
    };
    await waitForEvent(
      log.events,
      (event) =>
        event.kind === "usage-updated" && event.contextPercent !== null,
      "usage update",
    );
    const commandNames = commands.map((command) => command.name);
    const commandsAddressable =
      commands.length === 54 && new Set(commandNames).size === commands.length;
    const capabilityUnknowns = steadyStateUnknowns(session.capabilities);
    steps["7-catalogs-usage"] =
      commandsAddressable &&
      handshake.models?.length === 5 &&
      capabilityUnknowns.length === 0
        ? "pass"
        : `fail: commands=${commands.length} models=${handshake.models?.length ?? 0} unknowns=${capabilityUnknowns.join(",")}`;

    await session.close();
    await log.finished;
    const allEvents = [...log.events];
    session = await adapter.connect(spawn);
    log = record(session);
    const reattached = await session.resumeSession({
      vendorSessionId: created.vendorSessionId,
      style: "resume",
    });
    const wrotePromptDuringReattach = launches
      .slice(-2)
      .some((launch) => launch.command.some((argument) => argument === "PONG"));
    steps["8-disconnect-reattach"] =
      reattached.vendorSessionId === created.vendorSessionId &&
      !wrotePromptDuringReattach
        ? "pass"
        : "fail";
    await session.close();
    await log.finished;
    allEvents.push(...log.events);

    await sleep(100);
    const livePids = launches.filter((launch) => {
      const result = Bun.spawnSync([
        "ps",
        "-p",
        String(launch.pid),
        "-o",
        "pid=",
      ]);
      return (
        result.exitCode === 0 && result.stdout.toString().trim().length > 0
      );
    });
    const launchText = JSON.stringify(launches.map((launch) => launch.command));
    const outputText =
      stderrOutput.join("") +
      JSON.stringify(allEvents.map((event) => event.raw));
    const channels = {
      launchEnablement: /channelsEnabled|channel_enable|--channels?\b/i.test(
        launchText,
      ),
      environmentEnablement: Object.entries(spawn.env).some(([key, value]) =>
        /channelsEnabled|channel_enable|CLAUDE_[A-Z0-9_]*CHANNEL/i.test(
          `${key}=${value}`,
        ),
      ),
      outputWarning:
        /WARNING:\s*Loading development channels|Channels are enabled|MCP channels? enabled/i.test(
          outputText,
        ),
    };
    steps.containment =
      livePids.length === 0 &&
      launches.every(
        (launch) =>
          launch.stdio === "pipes" &&
          launch.processGroupMatchesParent &&
          /\?\?/.test(launch.processObservation),
      )
        ? "pass"
        : `fail: live pids ${livePids.map((launch) => launch.pid).join(",")}`;
    steps["channels-off"] = Object.values(channels).every((value) => !value)
      ? "pass"
      : "fail";

    writeEvidenceFile(
      EVIDENCE_PATH,
      `${JSON.stringify(
        {
          vendor: "claude",
          version,
          sdkVersionCompared: "0.3.220",
          sequence: "§2.3 baseline",
          capturedAt: new Date().toISOString(),
          executable: executable.replace(/^\/Users\/[^/]+/, "<user-home>"),
          transport: "direct stream-json control framing",
          steps,
          commandCount: commands.length,
          commandNames,
          modelCount: handshake.models?.length ?? 0,
          capabilities: session.capabilities.measured,
          capabilityAbsences: session.capabilities.absences,
          steadyStateUnknowns: capabilityUnknowns,
          channels,
          launchObservations: launches.map((launch) => ({
            command: launch.command.map(sanitize),
            stdio: launch.stdio,
            processGroupMatchesParent: launch.processGroupMatchesParent,
            processObservation: sanitize(
              launch.processObservation.replace(
                /^\s*\d+\s+\d+\s+\d+/,
                "<pid> <ppid> <pgid>",
              ),
            ),
          })),
          zeroOrphansAfterClose: livePids.length === 0,
        },
        null,
        2,
      )}\n`,
    );

    expect(
      Object.entries(steps).filter(([, outcome]) => outcome !== "pass"),
    ).toEqual([]);
  },
  240_000,
);
