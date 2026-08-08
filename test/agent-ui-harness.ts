import type { TreeSitterClient } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeProviderAdapter,
  type FakeProviderSession,
} from "../src/adapters/providers/protocol/fake-driver";
import type {
  ProviderSession,
  SubmissionReceipt,
} from "../src/adapters/providers/protocol/types";
import type { MeasuredProviderCapabilities } from "../src/schemas/capability";
import type { FrontendWakeReport } from "../src/schemas/mail-wake";
import {
  AgentUi,
  type PaneIdentity,
  type UiDiagnosticReport,
} from "../src/cli/agent-ui/agent-ui-exports";
import { OutboundJournal } from "../src/cli/agent-ui/outbound-journal";

/** Keeps UI tests deterministic without starting OpenTUI's shared parser worker. */
export const testSyntaxHighlighter = {
  highlightOnce: async () => ({ highlights: [] }),
} as unknown as TreeSitterClient;

export interface AgentUiHarness {
  readonly directory: string;
  readonly journal: OutboundJournal;
  readonly driver: FakeProviderSession;
  readonly session: ProviderSession;
  readonly ui: AgentUi;
  readonly testRenderer: Awaited<ReturnType<typeof createTestRenderer>>;
  readonly reportedReceipts: SubmissionReceipt[];
  readonly reportedWakes: FrontendWakeReport[];
  close(): Promise<void>;
}

const DEFAULT_IDENTITY: PaneIdentity = {
  agentName: "maya",
  vendorName: "Kimi Code",
  vendorId: "kimi",
  model: "kimi-k2",
  effort: "high",
};

export interface AgentUiHarnessOptions {
  readonly identity?: PaneIdentity;
  readonly capabilities?: MeasuredProviderCapabilities;
  readonly reportWake?: (report: FrontendWakeReport) => Promise<void>;
  readonly reportDiagnostic?: (report: UiDiagnosticReport) => void;
  readonly prepareJournal?: (journal: OutboundJournal) => Promise<void>;
  readonly loadCompactReload?: () => Promise<string>;
}

export async function createAgentUiHarness(
  options: AgentUiHarnessOptions = {},
): Promise<AgentUiHarness> {
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const directory = await mkdtemp(join(tmpdir(), "hive-agent-ui-"));
  const journal = await OutboundJournal.open(join(directory, "outbound.jsonl"));
  await options.prepareJournal?.(journal);
  const adapter = new FakeProviderAdapter(options.capabilities);
  const session = await adapter.connect({
    provider: "kimi",
    executable: "/fake/kimi",
    argv: [],
    cwd: directory,
    env: {},
  });
  if (adapter.session === null) throw new Error("no fake session");
  const driver = adapter.session;
  const ref = await session.newSession({ cwd: directory });
  const testRenderer = await createTestRenderer({
    width: 100,
    height: 30,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const reportedReceipts: SubmissionReceipt[] = [];
  const reportedWakes: FrontendWakeReport[] = [];
  const ui = new AgentUi({
    renderer: testRenderer.renderer,
    identity,
    session,
    journal,
    vendorSessionId: ref.vendorSessionId,
    reportReceipt: async (receipt) => {
      reportedReceipts.push(receipt);
    },
    now: () => "1970-01-01T00:00:00.000Z",
    // Tests must never write the developer's real clipboard.
    writeLocalClipboard: () => false,
    syntaxHighlighter: testSyntaxHighlighter,
    reportWake: async (report) => {
      reportedWakes.push(report);
      await options.reportWake?.(report);
    },
    ...(options.reportDiagnostic === undefined
      ? {}
      : { reportDiagnostic: options.reportDiagnostic }),
    ...(options.loadCompactReload === undefined
      ? {}
      : { loadCompactReload: options.loadCompactReload }),
  });
  let closed = false;
  return {
    directory,
    journal,
    driver,
    session,
    ui,
    testRenderer,
    reportedReceipts,
    reportedWakes,
    close: async () => {
      if (closed) return;
      closed = true;
      ui.detach();
      await ui.settleInput();
      await driver.close();
      testRenderer.renderer.destroy();
      await journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
