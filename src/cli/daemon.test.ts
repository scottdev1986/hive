import { expect, test } from "bun:test";
import type { AgentRecord } from "../schemas";
import type { SessionInspection } from "../daemon/session-host/contract";
import type { TmuxSessionHost } from "../daemon/session-host/tmux-host";
import { stopSpawnSession } from "./daemon";

test("spawn cleanup dispatches a sessiond row by its exact locator", async () => {
  const locator = {
    schemaVersion: 1 as const,
    instanceId: "hive-production",
    subject: { kind: "agent" as const, agentId: "agent-aria" },
    generation: 1,
    sessionId: "ses_019f7dca-7580-78d0-aa83-22a0c471fde6",
    hostKind: "sessiond" as const,
    engineBuildId: "engine-production",
  };
  const record = {
    id: "agent-aria",
    name: "aria",
    tool: "claude",
    model: "claude-haiku-4-5-20251001",
    category: "simple_coding",
    status: "spawning",
    taskDescription: "production pane qualification",
    worktreePath: "/tmp/aria",
    branch: "hive/aria-production-pane-qualification",
    tmuxSession: "hive-aria",
    sessionLocator: locator,
    contextPct: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    lastEventAt: "2026-07-20T00:00:00.000Z",
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: true,
    writeRevoked: false,
  } satisfies AgentRecord;
  const inspected: unknown[] = [];
  const terminated: unknown[] = [];

  await expect(stopSpawnSession(record, {
    sessions: {} as TmuxSessionHost,
    terminalHost: {
      inspect: async (candidate) => {
        inspected.push(candidate);
        return { hostPid: null } as SessionInspection;
      },
      terminate: async (candidate) => {
        terminated.push(candidate);
        return {
          locator,
          state: "terminated" as const,
          exit: null,
          survivors: [],
          errors: [],
        };
      },
    },
  })).resolves.toEqual({ killed: [], survivors: [] });
  expect(inspected).toEqual([locator]);
  expect(terminated).toEqual([locator]);
});
