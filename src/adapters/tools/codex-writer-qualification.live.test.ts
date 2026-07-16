import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnContextIdentityForTurn } from "../../daemon/tool-telemetry";

/**
 * Qualification evidence for the installed Codex build, driven against the real
 * binary. Skipped unless HIVE_LIVE_CODEX_WRITER=1, because it signs in and
 * SPENDS A PROMPT — unlike the other live probes, this one runs real turns:
 *
 *   HIVE_LIVE_CODEX_WRITER=1 bun test src/adapters/tools/codex-writer-qualification.live.test.ts
 *
 * This is diagnostics, NOT an admission input. Nothing in the product asks it
 * whether a build qualifies: writer admission gates on the driver, and a build
 * that cannot supply this evidence simply gets every mutation denied at
 * runtime. The test exists to tell a human WHY a writer has gone useless on
 * some future build, and to catch the protocol facts the gate is built on
 * changing underneath it — each `expect` below is one of those facts.
 */
const LIVE = Bun.env.HIVE_LIVE_CODEX_WRITER === "1";

interface ProbeResult {
  appliedModel: unknown;
  appliedEffort: unknown;
  sandbox: unknown;
  threadId: string;
  rolloutPath: string | null;
  approvals: { method: string; threadId?: string; turnId?: string; markerExisted: boolean }[];
  markerAfter: boolean;
  turnId: string | null;
}

/** One real app-server session that is told to mutate the filesystem from a
 * read-only sandbox, answering every approval with `decision`. */
async function probe(decision: "accept" | "decline"): Promise<ProbeResult> {
  const cwd = mkdtempSync(join(tmpdir(), `hive-qual-${decision}-`));
  const marker = join(cwd, "MUTATION_LANDED.txt");
  const child = Bun.spawn(["codex", "app-server", "--stdio"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  let nextId = 1;
  const pending = new Map<number, (value: any) => void>();
  const approvals: ProbeResult["approvals"] = [];
  let turnId: string | null = null;
  let turnDone!: () => void;
  const completed = new Promise<void>((resolve) => {
    turnDone = resolve;
  });

  const send = (message: unknown): void => {
    child.stdin.write(JSON.stringify(message) + "\n");
    child.stdin.flush();
  };
  const request = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  };

  void (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && message.method !== undefined) {
          // A server->client approval request: record whether the side effect
          // had already happened by the time we were asked.
          approvals.push({
            method: message.method,
            threadId: message.params?.threadId,
            turnId: message.params?.turnId,
            markerExisted: existsSync(marker),
          });
          send({ jsonrpc: "2.0", id: message.id, result: { decision } });
          continue;
        }
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)!(message.result ?? message.error);
          pending.delete(message.id);
          continue;
        }
        if (message.method === "turn/started") {
          turnId = message.params?.turn?.id ?? null;
        }
        if (message.method === "turn/completed" || message.method === "turn/failed") {
          turnDone();
        }
      }
    }
  })();

  await request("initialize", {
    clientInfo: { name: "hive", title: "Hive", version: "0" },
    capabilities: {
      experimentalApi: false,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: false,
    },
  });
  send({ jsonrpc: "2.0", method: "initialized" });

  const started = await request("thread/start", {
    cwd,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "read-only",
    developerInstructions: "You are a qualification probe.",
  });
  const threadId: string = started?.thread?.id;

  await request("turn/start", {
    threadId,
    input: [{
      type: "text",
      text:
        `Create a file at exactly ${marker} containing the word LANDED, using a shell command ` +
        `such as: echo LANDED > ${marker}. If the sandbox denies it, request approval to ` +
        `escalate and retry. Do it now.`,
    }],
  });
  await Promise.race([completed, Bun.sleep(180_000)]);

  const read = await request("thread/read", { threadId });
  const result: ProbeResult = {
    appliedModel: started?.model,
    appliedEffort: started?.reasoningEffort,
    sandbox: started?.sandbox,
    threadId,
    rolloutPath: read?.thread?.path ?? null,
    approvals,
    markerAfter: existsSync(marker),
    turnId,
  };
  child.kill();
  return result;
}

describe.skipIf(!LIVE)("codex writer qualification (real binary)", () => {
  test("a declined mutation never touches the filesystem, and the broker saw it first", async () => {
    const result = await probe("decline");
    // (b) EVERY mutation reaches a synchronous broker request BEFORE any side
    // effect. If this ever yields zero approvals AND a landed marker, the
    // sandbox is not containing writes and the whole gate is bypassable.
    expect(result.approvals.length).toBeGreaterThan(0);
    for (const approval of result.approvals) {
      expect(approval.markerExisted).toBe(false);
      // The request must be bindable to the exact thread/turn we are gating.
      expect(approval.threadId).toBe(result.threadId);
      expect(typeof approval.turnId).toBe("string");
    }
    expect(result.markerAfter).toBe(false);
  }, 240_000);

  test("an accepted mutation lands: one-shot approval is a real channel out of a read-only sandbox", async () => {
    // The positive control for the test above. Without it, a declined marker
    // proves nothing — a turn that never ran looks identical.
    const result = await probe("accept");
    expect(result.approvals.length).toBeGreaterThan(0);
    expect(result.markerAfter).toBe(true);
  }, 240_000);

  test("(a) applied model+effort are readable for the exact turn, bound via the thread's own rollout", async () => {
    const result = await probe("decline");
    // The sandbox the writer actually got.
    expect(result.sandbox).toMatchObject({ type: "readOnly" });
    // thread/start echoes the applied identity...
    expect(typeof result.appliedModel).toBe("string");
    expect(typeof result.appliedEffort).toBe("string");
    // ...and thread/read names this thread's rollout, which is how the gate
    // binds an identity read to the connection instead of scanning a worktree.
    expect(result.rolloutPath).not.toBeNull();
    expect(existsSync(result.rolloutPath!)).toBe(true);

    // The gate's actual reader, run against the real file: the turn_context for
    // the exact turn carries the APPLIED model and effort.
    const identity = turnContextIdentityForTurn(
      readFileSync(result.rolloutPath!, "utf8"),
      // The probe's cwd is the rollout's cwd.
      JSON.parse(readFileSync(result.rolloutPath!, "utf8").split("\n")[0]!)
        .payload.cwd,
      result.turnId!,
    );
    expect(identity).not.toBeNull();
    expect(identity!.model).toBe(result.appliedModel as string);
    expect(identity!.effort).toBe(result.appliedEffort as string);
  }, 240_000);
});
