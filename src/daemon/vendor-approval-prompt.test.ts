import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import { HiveDaemon } from "./server";
import { actingAs } from "./testing";
import type { SpawnRequest, Spawner } from "./spawner";
import type {
  SessiondAgentInput,
  SessiondInjectResult,
} from "./session-host/sessiond-agent-input";
import type { InputReceipt } from "./session-host/terminal-host-contract";

/**
 * #102: a codex agent parked on its own TUI approval popup was unreachable by
 * every party at once — hive_approvals was empty, steer and urgent had no tool
 * boundary to inject at, and the pane refused input. The agent was killed with
 * committed work stranded.
 *
 * These tests model that state: the vendor says it is waiting (its
 * PermissionRequest hook), and the decision has to reach the pane as the
 * keystroke the popup itself advertises.
 */

const home = mkdtempSync(join(tmpdir(), "hive-vendor-prompt-test-"));
process.env.HIVE_HOME = home;

const timestamp = "2026-07-21T12:00:00.000Z";

class StubSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not spawned in this test");
  }
}

/** A codex writer live in a sessiond-hosted pane, mid-turn. */
function blockedCodexAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-sam",
    name: "sam",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "working",
    taskDescription: "Land the fix",
    worktreePath: "/tmp/hive-sam",
    branch: "hive/sam-fix",
    tmuxSession: "hive-sam",
    contextPct: 20,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    sessionLocator: {
      schemaVersion: 1 as const,
      instanceId: "hive-fixture",
      subject: { kind: "agent" as const, agentId: "agent-sam" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-0000000001aa",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-fixture",
    },
    ...overrides,
  };
}

function receipt(transactionId: string): InputReceipt {
  return {
    transactionId,
    stage: "written-to-terminal",
    byteRange: { start: "0", endExclusive: "1" },
    orderedAt: "1",
    availableCreditBytes: 4096,
    consumedByProcess: "not-claimed",
    completeness: "complete",
    diagnostic: null,
  };
}

/** Records every keystroke the daemon sends to a parked pane. */
function recordingInput(): SessiondAgentInput & {
  keys: Array<{ name: string; keys: string }>;
} {
  const keys: Array<{ name: string; keys: string }> = [];
  return {
    keys,
    async injectIdle(): Promise<SessiondInjectResult> {
      return { outcome: "declined", reason: "not used in this test" };
    },
    async injectKeys(agent, sent, options): Promise<SessiondInjectResult> {
      keys.push({ name: agent.name, keys: sent });
      return { outcome: "injected", receipt: receipt(options.transactionId) };
    },
  };
}

async function withDaemon(
  fixture: string,
  sessiondInput: SessiondAgentInput,
  body: (context: {
    db: HiveDatabase;
    daemon: HiveDaemon;
    client: Client;
  }) => Promise<void>,
): Promise<void> {
  const db = new HiveDatabase(join(home, `${fixture}.db`));
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: new StubSpawner(),
    sessiondInput,
  });
  const client = new Client({ name: "vendor-prompt-test", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://hive/mcp"), {
        fetch: actingAs(daemon, "operator"),
      }),
    );
    await body({ db, daemon, client });
  } finally {
    await client.close();
    db.close();
  }
}

function textValue(
  result: Awaited<ReturnType<Client["callTool"]>>,
): unknown {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as unknown;
}

function pendingApprovalId(db: HiveDatabase): string {
  const pending = db.listApprovals("pending");
  expect(pending).toHaveLength(1);
  return pending[0]!.id;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectFailedInjectionPreserved(
  fixture: string,
  injectKeys: NonNullable<SessiondAgentInput["injectKeys"]>,
): Promise<void> {
  const input: SessiondAgentInput = {
    async injectIdle(): Promise<SessiondInjectResult> {
      return { outcome: "declined", reason: "not used in this test" };
    },
    injectKeys,
  };
  await withDaemon(fixture, input, async ({ db, daemon, client }) => {
    db.insertAgent(blockedCodexAgent());
    await daemon.processEvent({
      kind: "approval-request",
      agentName: "sam",
      timestamp: "2026-07-21T12:01:00.000Z",
      description: "Bash: git push",
    });
    const approvalId = pendingApprovalId(db);
    const queued = await daemon.delivery.send(
      "queen",
      "sam",
      "Read this after the prompt is really gone.",
    );
    expect(queued.state).toEqual("queued");

    const result = textValue(await client.callTool({
      name: "hive_approve",
      arguments: { id: approvalId, decision: "approve" },
    })) as { outcome: string; status: string };

    expect(result).toMatchObject({ outcome: "delivery-failed", status: "pending" });
    expect(db.getApproval(approvalId)?.status).toEqual("pending");
    expect(db.getAgentByName("sam")?.status).toEqual("awaiting-approval");
    expect(db.getMessage(queued.id)).toMatchObject({
      state: "queued",
      deliveredAt: null,
    });
  });
}

describe("a vendor TUI parked on an approval prompt", () => {
  test("surfaces through hive_approvals, and approving it presses the key that advances the popup", async () => {
    const input = recordingInput();
    await withDaemon("approve", input, async ({ db, daemon, client }) => {
      db.insertAgent(blockedCodexAgent());

      // What codex's PermissionRequest hook reports, carrying the command
      // being decided (measured payload, codex-cli 0.145.0).
      await daemon.processEvent({
        kind: "approval-request",
        agentName: "sam",
        timestamp: "2026-07-21T12:01:00.000Z",
        description: "Bash: curl -sS -o /dev/null https://example.com",
      });

      // The state that used to be invisible is now a decision queen can make.
      expect(db.getAgentByName("sam")?.status).toEqual("awaiting-approval");
      const approvals = textValue(
        await client.callTool({ name: "hive_approvals", arguments: {} }),
      ) as Array<{ id: string; description: string; status: string }>;
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toEqual("pending");
      expect(approvals[0]?.description).toEqual(
        "Bash: curl -sS -o /dev/null https://example.com",
      );

      await client.callTool({
        name: "hive_approve",
        arguments: { id: approvals[0]!.id, decision: "approve" },
      });

      // The decision reached the pane: "y" is the shortcut codex prints on its
      // "Yes, proceed" option. Anything less and an approved request leaves the
      // agent exactly as blocked as a denied one.
      expect(input.keys).toEqual([{ name: "sam", keys: "y" }]);
      // The turn resumes, so the agent is working — calling it idle here would
      // invite the wake loop to paste queued mail into a busy pane.
      expect(db.getAgentByName("sam")?.status).toEqual("working");
    });
  });

  test("denying presses escape, which codex's popup labels as its decline", async () => {
    const input = recordingInput();
    await withDaemon("deny", input, async ({ db, daemon, client }) => {
      db.insertAgent(blockedCodexAgent());
      await daemon.processEvent({
        kind: "approval-request",
        agentName: "sam",
        timestamp: "2026-07-21T12:01:00.000Z",
        description: "Bash: rm -rf /",
      });

      await client.callTool({
        name: "hive_approve",
        arguments: { id: pendingApprovalId(db), decision: "deny" },
      });

      expect(input.keys).toEqual([{ name: "sam", keys: "\u001b" }]);
    });
  });

  test("a manually answered prompt makes its approval STALE before a later popup can reuse it", async () => {
    const input = recordingInput();
    await withDaemon("stale-prompt", input, async ({ db, daemon, client }) => {
      db.insertAgent(blockedCodexAgent());
      await daemon.processEvent({
        kind: "approval-request",
        agentName: "sam",
        timestamp: "2026-07-21T12:01:00.000Z",
        description: "Bash: command A",
      });
      const staleId = pendingApprovalId(db);

      // A tool boundary proves the person at the pane already answered A.
      await daemon.processEvent({
        kind: "tool-boundary",
        agentName: "sam",
        timestamp: "2026-07-21T12:02:00.000Z",
      });
      await daemon.processEvent({
        kind: "approval-request",
        agentName: "sam",
        timestamp: "2026-07-21T12:03:00.000Z",
        description: "Bash: command B",
      });
      const currentId = pendingApprovalId(db);
      expect(currentId).not.toEqual(staleId);

      const result = textValue(await client.callTool({
        name: "hive_approve",
        arguments: { id: staleId, decision: "approve" },
      })) as { outcome: string; status: string };

      expect(result).toMatchObject({ outcome: "stale", status: "stale" });
      expect(input.keys).toEqual([]);
      expect(db.getApproval(currentId)?.status).toEqual("pending");
      expect(db.getAgentByName("sam")?.status).toEqual("awaiting-approval");
    });
  });

  test("rechecks prompt identity after awaited injection setup", async () => {
    const started = deferred();
    const release = deferred();
    const keys: string[] = [];
    const input: SessiondAgentInput = {
      async injectIdle(): Promise<SessiondInjectResult> {
        return { outcome: "declined", reason: "not used in this test" };
      },
      async injectKeys(_agent, sent, options): Promise<SessiondInjectResult> {
        started.resolve();
        await release.promise;
        if (!options.isPromptPending()) {
          return { outcome: "declined", reason: "approval prompt is stale" };
        }
        keys.push(sent);
        return { outcome: "injected", receipt: receipt(options.transactionId) };
      },
    };
    await withDaemon("injection-race", input, async ({ db, daemon, client }) => {
      db.insertAgent(blockedCodexAgent());
      await daemon.processEvent({
        kind: "approval-request",
        agentName: "sam",
        timestamp: "2026-07-21T12:01:00.000Z",
        description: "Bash: command A",
      });
      const approvalId = pendingApprovalId(db);
      const resolving = client.callTool({
        name: "hive_approve",
        arguments: { id: approvalId, decision: "approve" },
      });
      await started.promise;

      // The popup is answered manually while broker/attach/input work awaits.
      await daemon.processEvent({
        kind: "tool-boundary",
        agentName: "sam",
        timestamp: "2026-07-21T12:02:00.000Z",
      });
      release.resolve();
      const result = textValue(await resolving) as { outcome: string };

      expect(result.outcome).toEqual("stale");
      expect(keys).toEqual([]);
      expect(db.getAgentByName("sam")?.status).toEqual("working");
    });
  });

  test("an old denial completing cannot overwrite one fresh prompt or answer it again", async () => {
    const started = deferred();
    const release = deferred();
    const keys: string[] = [];
    const input: SessiondAgentInput = {
      async injectIdle(): Promise<SessiondInjectResult> {
        return { outcome: "declined", reason: "not used in this test" };
      },
      async injectKeys(_agent, sent, options): Promise<SessiondInjectResult> {
        keys.push(sent);
        started.resolve();
        await release.promise;
        return { outcome: "injected", receipt: receipt(options.transactionId) };
      },
    };
    await withDaemon("fresh-after-denial", input, async ({ db, daemon, client }) => {
      db.insertAgent(blockedCodexAgent());
      await daemon.processEvent({
        kind: "approval-request",
        agentName: "sam",
        timestamp: "2026-07-21T12:01:00.000Z",
        description: "Bash: command A",
      });
      const oldId = pendingApprovalId(db);
      const denying = client.callTool({
        name: "hive_approve",
        arguments: { id: oldId, decision: "deny" },
      });
      await started.promise;

      await daemon.processEvent({
        kind: "approval-request",
        agentName: "sam",
        timestamp: "2026-07-21T12:02:00.000Z",
        description: "Bash: command B",
      });
      release.resolve();
      await denying;

      const pending = db.listApprovals("pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.description).toEqual("Bash: command B");
      expect(db.getAgentByName("sam")?.status).toEqual("awaiting-approval");
      expect(keys).toEqual(["\u001b"]);
    });
  });

  test("never presses a key for an approval no vendor pane is waiting on", async () => {
    const input = recordingInput();
    await withDaemon("gated", input, async ({ db, daemon, client }) => {
      // Positive control first: this agent's own tool prompt DOES get a key,
      // so a later empty `keys` is a gate that held, not a wire that is dead.
      db.insertAgent(blockedCodexAgent());
      await daemon.processEvent({
        kind: "approval-request",
        agentName: "sam",
        timestamp: "2026-07-21T12:01:00.000Z",
        description: "Bash: git push",
      });
      await client.callTool({
        name: "hive_approve",
        arguments: { id: pendingApprovalId(db), decision: "approve" },
      });
      expect(input.keys).toHaveLength(1);

      // Each of the three gates gets its own blocked-looking agent, so exactly
      // one condition differs from the case that DID press a key above.

      // No viewer wire to speak to.
      db.insertAgent(blockedCodexAgent({
        id: "agent-tess",
        name: "tess",
        status: "awaiting-approval",
        tmuxSession: "hive-tess",
        sessionLocator: undefined,
      }));
      // A Hive-authored approval (cost consent, land re-arm) has no popup
      // behind it at all.
      db.insertAgent(blockedCodexAgent({
        id: "agent-remy",
        name: "remy",
        status: "awaiting-approval",
        sessionLocator: {
          ...blockedCodexAgent().sessionLocator!,
          subject: { kind: "agent" as const, agentId: "agent-remy" },
          sessionId: "ses_018f1e90-7b5a-7cc0-8000-0000000001bb",
        },
      }));
      // Answered at the pane already: the tool boundary that observed it moved
      // this agent back to working, and a key now would type into a composer.
      db.insertAgent(blockedCodexAgent({
        id: "agent-nina",
        name: "nina",
        status: "working",
        sessionLocator: {
          ...blockedCodexAgent().sessionLocator!,
          subject: { kind: "agent" as const, agentId: "agent-nina" },
          sessionId: "ses_018f1e90-7b5a-7cc0-8000-0000000001cc",
        },
      }));
      const gated: Array<[string, string, "tool-permission" | "land-rearm"]> = [
        ["approval-tess", "tess", "tool-permission"],
        ["approval-remy", "remy", "land-rearm"],
        ["approval-nina", "nina", "tool-permission"],
      ];
      for (const [id, agentName, kind] of gated) {
        db.insertApproval({
          id,
          agentName,
          kind,
          description: `${kind} for ${agentName}`,
          status: "pending",
          createdAt: "2026-07-21T12:02:00.000Z",
          resolvedAt: null,
        });
        await client.callTool({
          name: "hive_approve",
          arguments: { id, decision: "approve" },
        });
      }
      expect(input.keys).toHaveLength(1);
    });
  });

  test("keeps the approval pending when the host has no key channel", async () => {
    const withoutKeys: SessiondAgentInput = {
      async injectIdle(): Promise<SessiondInjectResult> {
        return { outcome: "declined", reason: "not used in this test" };
      },
    };
    await withDaemon("no-keys", withoutKeys, async ({ db, daemon, client }) => {
      db.insertAgent(blockedCodexAgent());
      await daemon.processEvent({
        kind: "approval-request",
        agentName: "sam",
        timestamp: "2026-07-21T12:01:00.000Z",
        description: "Bash: git push",
      });
      await client.callTool({
        name: "hive_approve",
        arguments: { id: pendingApprovalId(db), decision: "approve" },
      });
      expect(db.getAgentByName("sam")?.status).toEqual("awaiting-approval");
      expect(db.listApprovals("pending")).toHaveLength(1);
    });
  });

  test("keeps approval and queued mail when key injection is declined", async () => {
    await expectFailedInjectionPreserved(
      "declined-keys",
      async () => ({ outcome: "declined", reason: "viewer claim refused" }),
    );
  });

  test("keeps approval and queued mail when key injection throws", async () => {
    await expectFailedInjectionPreserved("throwing-keys", async () => {
      throw new Error("viewer wire broke");
    });
  });
});
