import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import {
  FakeProviderAdapter,
  type FakeProviderSession,
} from "../src/adapters/providers/protocol/fake-driver";
import { AgentUi } from "../src/cli/agent-ui/agent-ui-exports";
import { OutboundJournal } from "../src/cli/agent-ui/outbound-journal";
import {
  providerStatusForwarder,
  type StatusPoster,
} from "../src/daemon/status-service/status-service";
import { renderSession } from "../src/cli/agent-ui/run";
import { ProviderStatusReportSchema } from "../src/daemon/status-service/status-projection-service";
import { testSyntaxHighlighter } from "./agent-ui-harness";

const RUN_ID = "8f14e45f-ceea-467a-9a3f-b4a5c0d10001";
const SESSION_ID = "fake-session";

let directory: string;
let journal: OutboundJournal;
let driver: FakeProviderSession;
let ui: AgentUi;
let testRenderer: Awaited<ReturnType<typeof createTestRenderer>>;

interface Capture {
  readonly paths: string[];
  readonly bodies: unknown[];
  readonly post: StatusPoster;
}

function capturingPoster(): Capture {
  const paths: string[] = [];
  const bodies: unknown[] = [];
  return {
    paths,
    bodies,
    post: async (path, init) => {
      paths.push(path);
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    },
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-provider-events-"));
  journal = await OutboundJournal.open(join(directory, "outbound.jsonl"));
  const adapter = new FakeProviderAdapter();
  const session = await adapter.connect({
    provider: "codex",
    executable: "/fake/codex",
    argv: [],
    cwd: directory,
    env: {},
  });
  if (adapter.session === null) throw new Error("no fake session");
  driver = adapter.session;
  const ref = await session.newSession({ cwd: directory });
  testRenderer = await createTestRenderer({
    width: 100,
    height: 30,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  ui = new AgentUi({
    renderer: testRenderer.renderer,
    identity: {
      agentName: "maya",
      vendorName: "Codex",
      vendorId: "codex",
      model: "gpt-5",
    },
    session,
    journal,
    vendorSessionId: ref.vendorSessionId,
    syntaxHighlighter: testSyntaxHighlighter,
  });
});

afterEach(async () => {
  ui.detach();
  await driver.close();
  testRenderer.renderer.destroy();
  await journal.close();
  await rm(directory, { recursive: true, force: true });
});

describe("a protocol-driven vendor's own events are the pane's evidence rows", () => {
  /**
   * The defect this pins: a codex or grok pane consumed the whole normalized
   * event stream into local render state and told the daemon nothing, so its
   * agent row kept the lastEventAt written at spawn while the agent was
   * demonstrably working — a frozen timestamp that reads as a fresh negative.
   */
  test("a turn drawn in the pane reaches the daemon status service", async () => {
    const capture = capturingPoster();
    const rendering = renderSession(
      ui,
      driver,
      null,
      () => {},
      providerStatusForwarder({
        subject: "maya",
        providerRunId: RUN_ID,
        vendorSessionId: SESSION_ID,
        post: capture.post,
      }),
    );

    driver.emit({ kind: "turn-started", turnId: "t1" });
    driver.emit({ kind: "message-delta", turnId: "t1", text: "thinking" });
    driver.emit({
      kind: "tool-started",
      turnId: "t1",
      toolCallId: "c1",
      toolName: "rg",
      detail: "rg -n pump src/",
    });
    driver.emit({ kind: "turn-idle", turnId: "t1" });
    await Bun.sleep(20);

    const events = capture.bodies.map((body) =>
      ProviderStatusReportSchema.parse(body),
    );
    expect(events.map((each) => each.projection.turn)).toEqual([
      "working",
      "working",
      "done",
    ]);
    for (const path of capture.paths) {
      expect(path).toBe("/agent-status");
    }
    for (const event of events) {
      expect(event.agent).toBe("maya");
      expect(event.providerRunId).toBe(RUN_ID);
      expect(event.vendorSessionId).toBe(SESSION_ID);
    }

    await driver.close();
    await rendering;
  });

  test("the vendor's own observation time is what the event carries", async () => {
    const capture = capturingPoster();
    const rendering = renderSession(
      ui,
      driver,
      null,
      () => {},
      providerStatusForwarder({
        subject: "maya",
        providerRunId: RUN_ID,
        vendorSessionId: SESSION_ID,
        post: capture.post,
      }),
    );

    const emitted = driver.emit({ kind: "turn-started", turnId: "t1" });
    await Bun.sleep(20);

    const event = ProviderStatusReportSchema.parse(capture.bodies[0]);
    expect(event.observedAt).toBe(emitted.occurredAt);

    await driver.close();
    await rendering;
  });

  /**
   * Streamed text arrives once per chunk. Forwarding it would spend a request
   * per token to repeat what the turn-start already established, so an
   * assistant message on its own must produce no traffic at all.
   */
  test("streamed deltas are drawn without being reported", async () => {
    const capture = capturingPoster();
    const rendering = renderSession(
      ui,
      driver,
      null,
      () => {},
      providerStatusForwarder({
        subject: "maya",
        providerRunId: RUN_ID,
        vendorSessionId: SESSION_ID,
        post: capture.post,
      }),
    );

    for (const text of ["one", "two", "three"]) {
      driver.emit({ kind: "message-delta", turnId: "t1", text });
      driver.emit({ kind: "thought-delta", turnId: "t1", text });
    }
    await Bun.sleep(20);

    expect(capture.bodies).toEqual([]);
    // Positive control: the reader is wired, so the empty result above is an
    // empty world rather than a fetcher nothing was ever going to reach.
    driver.emit({ kind: "turn-idle", turnId: "t1" });
    await Bun.sleep(20);
    expect(capture.bodies).toHaveLength(1);

    await driver.close();
    await rendering;
  });

  /**
   * The daemon applies status in arrival order, so a turn-start that overtook
   * the turn-idle before it would leave a finished agent reading as working.
   */
  test("reports keep the order the vendor emitted them in", async () => {
    const seen: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const poster: StatusPoster = async (_path, init) => {
      const body = ProviderStatusReportSchema.parse(
        JSON.parse(String(init?.body)),
      );
      if (first) {
        first = false;
        await gate;
      }
      seen.push(body.projection.turn ?? "unknown");
      return new Response("{}", { status: 200 });
    };
    const rendering = renderSession(
      ui,
      driver,
      null,
      () => {},
      providerStatusForwarder({
        subject: "maya",
        providerRunId: RUN_ID,
        vendorSessionId: SESSION_ID,
        post: poster,
      }),
    );

    driver.emit({ kind: "turn-started", turnId: "t1" });
    driver.emit({ kind: "turn-idle", turnId: "t1" });
    await Bun.sleep(20);
    expect(seen).toEqual([]);
    release();
    await Bun.sleep(20);

    expect(seen).toEqual(["working", "done"]);

    await driver.close();
    await rendering;
  });

  /**
   * A standalone pane runs with no daemon at all. Reporting into one that is
   * not there would fail once per turn, which reads like an absence of turns
   * rather than an absence of a daemon.
   */
  test("a pane with no control plane reports nothing", async () => {
    const capture = capturingPoster();
    const rendering = renderSession(
      ui,
      driver,
      null,
      () => {},
      providerStatusForwarder({
        subject: "maya",
        providerRunId: RUN_ID,
        vendorSessionId: SESSION_ID,
        post: null,
      }),
    );

    driver.emit({ kind: "turn-started", turnId: "t1" });
    driver.emit({
      kind: "tool-started",
      turnId: "t1",
      toolCallId: "c1",
      toolName: "rg",
      detail: null,
    });
    driver.emit({ kind: "turn-idle", turnId: "t1" });
    await Bun.sleep(20);

    expect(capture.paths).toEqual([]);
    // Positive control: the very same events on a pane that HAS a daemon do
    // report, so the empty result above is the guard and not a dead driver.
    const withDaemon = capturingPoster();
    const forward = providerStatusForwarder({
      subject: "maya",
      providerRunId: RUN_ID,
      vendorSessionId: SESSION_ID,
      post: withDaemon.post,
    });
    forward(driver.emit({ kind: "turn-started", turnId: "t2" }));
    await forward.flush();
    expect(withDaemon.paths).toEqual(["/agent-status"]);

    await driver.close();
    await rendering;
  });

  test("a daemon that refuses the report does not end the pane", async () => {
    const rendering = renderSession(
      ui,
      driver,
      null,
      () => {},
      providerStatusForwarder({
        subject: "maya",
        providerRunId: RUN_ID,
        vendorSessionId: SESSION_ID,
        post: async () => {
          throw new Error("connection refused");
        },
      }),
    );

    driver.emit({ kind: "turn-started", turnId: "t1" });
    driver.emit({ kind: "turn-idle", turnId: "t1" });
    await Bun.sleep(20);

    expect(ui.snapshot().view.turn).toBe("done");

    await driver.close();
    await rendering;
  });

  test("a settled permission is reported to the control plane", async () => {
    const settled: { requestId: string; outcome: string }[] = [];
    const rendering = renderSession(
      ui,
      driver,
      null,
      () => {},
      () => {},
      (requestId, outcome) => settled.push({ requestId, outcome }),
    );

    driver.emit({
      kind: "elicitation-settled",
      requestId: "permission-1",
      outcome: "deny",
    });
    await Bun.sleep(20);

    expect(settled).toEqual([{ requestId: "permission-1", outcome: "deny" }]);

    await driver.close();
    await rendering;
  });
});
