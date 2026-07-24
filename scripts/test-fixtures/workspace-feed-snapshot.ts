#!/usr/bin/env bun
/** Regenerate with `bun run scripts/test-fixtures/workspace-feed-snapshot.ts`. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  runWorkspaceFeed,
  type WorkspaceOrchestratorSnapshot,
} from "../../src/cli/workspace-feed";
import type { AgentRecord } from "../../src/schemas";

const OBSERVED_AT = "2026-07-13T12:00:00.000Z";

export const WORKSPACE_FEED_SNAPSHOT_FIXTURE = resolve(
  import.meta.dir,
  "../../test/fixtures/workspace-feed-snapshot.json",
);

export const workspaceFeedAgentFixture: AgentRecord = {
  id: "agent-indexer",
  name: "indexer",
  tool: "codex",
  model: "gpt-5.4",
  category: "standard_coding",
  status: "working",
  taskDescription: "Index the repository",
  worktreePath: "/tmp/hive/indexer",
  branch: "hive/indexer",
  tmuxSession: "hive-indexer",
  contextPct: 41.5,
  createdAt: OBSERVED_AT,
  lastEventAt: OBSERVED_AT,
  recoveryAttempts: 0,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
};

export async function buildWorkspaceFeedSnapshotFixture(): Promise<
  Record<string, unknown>
> {
  const controller = new AbortController();
  const lines: string[] = [];
  const exitCode = await runWorkspaceFeed(4483, {
    signal: controller.signal,
    now: () => Date.parse(OBSERVED_AT),
    sleep: async () => undefined,
    fetchStatus: async () => {
      controller.abort();
      return [workspaceFeedAgentFixture];
    },
    fetchAutonomy: async () => "dangerous",
    fetchOrchestrator: async (): Promise<WorkspaceOrchestratorSnapshot> => ({
      status: "working",
      host: "tmux",
      hostState: null,
      hostDiagnostic: null,
      sessionLocator: null,
    }),
    write: (line) => lines.push(line),
  });
  if (exitCode !== 0 || lines.length !== 1 || lines[0] === undefined) {
    throw new Error(
      `workspace feed fixture produced exit ${exitCode} and ${lines.length} lines`,
    );
  }
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

export const renderWorkspaceFeedSnapshotFixture = async (): Promise<string> =>
  `${JSON.stringify(await buildWorkspaceFeedSnapshotFixture(), null, 2)}\n`;

if (import.meta.main) {
  await mkdir(dirname(WORKSPACE_FEED_SNAPSHOT_FIXTURE), { recursive: true });
  await writeFile(
    WORKSPACE_FEED_SNAPSHOT_FIXTURE,
    await renderWorkspaceFeedSnapshotFixture(),
  );
  console.log(WORKSPACE_FEED_SNAPSHOT_FIXTURE);
}
