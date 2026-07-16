#!/usr/bin/env bun
/** Regenerate with `bun run scripts/test-fixtures/workspace-feed-snapshot.ts`. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runWorkspaceFeed } from "../../src/cli/workspace-feed";
import type { AgentRecord } from "../../src/schemas";

const OBSERVED_AT = "2026-07-13T12:00:00.000Z";

export const WORKSPACE_FEED_SNAPSHOT_FIXTURE = resolve(
  import.meta.dir,
  "../../test/fixtures/workspace-feed-snapshot.json",
);

// A real Codex wire row: the daemon never binds a Codex `toolSessionId` to a
// process incarnation, so it is absent here, while `identityState` reads
// "unknown" and `processIncarnation`/`tmuxSession` are present. The Workspace
// must still open a pane from this (viewing is bound on instance + agent UUID +
// incarnation + tmux session), with authoring fail-closed as identity-unknown.
export const workspaceFeedAgentFixture: AgentRecord = {
  id: "agent-indexer",
  name: "indexer",
  tool: "codex",
  model: "gpt-5.4",
  identityState: "unknown",
  category: "standard_coding",
  status: "working",
  taskDescription: "Index the repository",
  worktreePath: "/tmp/hive/indexer",
  branch: "hive/indexer",
  tmuxSession: "hive-indexer",
  processIncarnation: 1,
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
    fetchOrchestrator: async () => "working",
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
