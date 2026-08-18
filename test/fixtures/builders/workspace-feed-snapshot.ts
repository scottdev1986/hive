#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  runWorkspaceFeed,
  type WorkspaceOrchestratorSnapshot,
} from "../../../src/cli/workspace-feed";
import type { AgentRecord } from "../../../src/schemas/agent";

const OBSERVED_AT = "2026-07-13T12:00:00.000Z";

export const WORKSPACE_FEED_SNAPSHOT_FIXTURE = resolve(
  import.meta.dir,
  "../workspace-feed-snapshot.json",
);

export const workspaceFeedAgentFixture: AgentRecord = {
  id: "agent-indexer",
  name: "indexer",
  tool: "codex",
  model: "gpt-5.4",
  category: "standard_coding",
  status: "working",
  statusDimensions: {
    schemaVersion: 1,
    revision: "6",
    runtime: {
      kind: "observed",
      field: {
        value: "ready",
        source: { kind: "provider-protocol", id: "runtime-fixture" },
        observedAt: OBSERVED_AT,
        freshness: "fresh",
        confidence: "authoritative",
      },
    },
    turn: {
      kind: "observed",
      field: {
        value: "working",
        source: { kind: "provider-protocol", id: "turn-fixture" },
        observedAt: OBSERVED_AT,
        freshness: "fresh",
        confidence: "authoritative",
      },
    },
    input: {
      kind: "observed",
      field: {
        value: "free",
        source: { kind: "sessiond", id: "input-fixture" },
        observedAt: OBSERVED_AT,
        freshness: "fresh",
        confidence: "authoritative",
      },
    },
    mail: {
      kind: "observed",
      field: {
        value: "none",
        source: { kind: "provider-protocol", id: "mail-fixture" },
        observedAt: OBSERVED_AT,
        freshness: "fresh",
        confidence: "authoritative",
      },
    },
    health: {
      kind: "observed",
      field: {
        value: "healthy",
        source: { kind: "sessiond", id: "health-fixture" },
        observedAt: OBSERVED_AT,
        freshness: "fresh",
        confidence: "authoritative",
      },
    },
    attention: {
      kind: "observed",
      field: {
        value: "none",
        source: { kind: "user", id: "attention-fixture" },
        observedAt: OBSERVED_AT,
        freshness: "fresh",
        confidence: "authoritative",
      },
    },
  },
  taskDescription: "Index the repository",
  worktreePath: "/tmp/hive/indexer",
  branch: "hive/indexer",
  contextPct: 41.5,
  createdAt: OBSERVED_AT,
  lastEventAt: OBSERVED_AT,
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
    fetchAutonomy: async () => ({ kind: "current", value: "dangerous" }),
    fetchOrchestrator: async (): Promise<WorkspaceOrchestratorSnapshot> => ({
      name: "queen",
      status: "working",
      tool: "codex",
      model: "gpt-5.6-sol",
      host: "sessiond",
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
