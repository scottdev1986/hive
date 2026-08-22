import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/shared/is-record";
import {
  type JsonValue,
  safeJsonParse,
  type JsonObject,
} from "../src/shared/json";

const FIXTURES = join(import.meta.dir, "fixtures/protocol/kimi");
const SID = "session_00000000-0000-4000-8000-000000000001";

function load(name: string): JsonValue {
  const parsed = safeJsonParse(readFileSync(join(FIXTURES, name), "utf8"));
  if (parsed === undefined) {
    throw new Error(`fixture ${name} was not JSON`);
  }
  return parsed;
}

function send<T>(message: T): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify<T>(update: T): void {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: SID, update },
  });
}

let promptAwaitingCancel: number | null = null;
let promptAwaitingPermission: number | null = null;
let promptAwaitingQuestion: number | null = null;
// Mirrors the real server's "mode" config option, whose session/new value is
// "default" (manual approvals). Only "default" asks before running a tool.
let mode = "default";

function handleRequest(msg: {
  id: number;
  method: string;
  params?: JsonObject;
}): void {
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: load("initialize.response.json"),
      });
      return;
    case "session/new":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: load("session-new.response.json"),
      });
      setTimeout(() => notify(load("commands.update.json")), 10);
      return;
    case "session/load":
      // Replay history, then respond (kimi 0.31.1 load behavior).
      notify({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Reply with exactly: PONG" },
      });
      notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "PONG" },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
      return;
    case "session/resume":
      // No replay (kimi 0.31.1 resume behavior).
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
      return;
    case "session/set_config_option": {
      const params = msg.params ?? {};
      if (params.configId === "mode") mode = String(params.value);
      // SAFETY: The test owns this value and its fields.
      const fixture = load("session-new.response.json") as JsonObject;
      const configOptions = Array.isArray(fixture.configOptions)
        ? fixture.configOptions.map((option) => {
            if (
              isRecord(option) &&
              "id" in option &&
              option.id === params.configId
            ) {
              return { ...option, currentValue: params.value };
            }
            return option;
          })
        : [];
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { configOptions, recordedParams: params },
      });
      return;
    }
    case "session/prompt": {
      const blocks = Array.isArray(msg.params?.prompt) ? msg.params.prompt : [];
      // SAFETY: The test owns this value and its fields.
      const first = blocks[0] as { text?: string } | undefined;
      const text = first?.text ?? "";
      if (text.includes("repeat-prompt")) {
        notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { stopReason: "end_turn" },
        });
        return;
      }
      if (text.includes("essay")) {
        promptAwaitingCancel = msg.id;
        notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Chapter one" },
        });
        return;
      }
      if (text.includes("usage-full")) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            stopReason: "end_turn",
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              cachedReadTokens: 20,
              cacheCreationTokens: 5,
              reasoningTokens: 10,
            },
          },
        });
        return;
      }
      if (text.includes("stderr-failure")) {
        process.stderr.write(
          `${String.fromCharCode(27)}[31mHTTP 402: build balance exhausted; token=vendor-secret-value credential=/Users/example/.config/vendor/auth.json${String.fromCharCode(27)}[0m\nauthorization: Bearer short-token\n`,
        );
        setTimeout(
          () =>
            send({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: "synthetic RPC failure" },
            }),
          20,
        );
        return;
      }
      if (text.includes("chatty-stderr")) {
        for (let index = 0; index < 12; index += 1) {
          const tail = index === 11 ? "word ".repeat(140) : "";
          process.stderr.write(`vendor diagnostic ${index} ${tail}\n`);
        }
        setTimeout(
          () =>
            send({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: "chatty RPC failure" },
            }),
          20,
        );
        return;
      }
      if (text.includes("empty-rpc-error")) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: "empty RPC failure" },
        });
        return;
      }
      if (text.includes("AskUserQuestion")) {
        promptAwaitingQuestion = msg.id;
        notify(load("tool_call.update.json"));
        // SAFETY: The test owns this value and its fields.
        const question = load("question.request.json") as { params: unknown };
        send({
          jsonrpc: "2.0",
          id: 100,
          method: "session/request_permission",
          params: question.params,
        });
        return;
      }
      if (text.includes("echo")) {
        notify(load("tool_call.update.json"));
        // Outside "default" the tool just runs; the user is never consulted.
        if (mode !== "default") {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { stopReason: "end_turn" },
          });
          return;
        }
        promptAwaitingPermission = msg.id;
        // SAFETY: The test owns this value and its fields.
        const permission = load("permission.request.json") as {
          params: unknown;
        };
        send({
          jsonrpc: "2.0",
          id: 101,
          method: "session/request_permission",
          params: permission.params,
        });
        return;
      }
      notify({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      });
      notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "PONG" },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    default:
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf("\n");
    if (!line) continue;
    // SAFETY: The test owns this value and its fields.
    const msg = JSON.parse(line) as {
      id?: number;
      method?: string;
      result?: unknown;
    };
    if (msg.method === "session/cancel") {
      if (promptAwaitingCancel !== null) {
        send({
          jsonrpc: "2.0",
          id: promptAwaitingCancel,
          result: { stopReason: "cancelled" },
        });
        promptAwaitingCancel = null;
      }
      continue;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // SAFETY: The test owns this value and its fields.
      handleRequest(msg as { id: number; method: string });
      continue;
    }
    if (msg.id !== undefined && msg.result !== undefined) {
      // Answer to our reverse-RPC: settle the turn that was waiting on it.
      if (msg.id === 100 && promptAwaitingQuestion !== null) {
        send({
          jsonrpc: "2.0",
          id: promptAwaitingQuestion,
          result: { stopReason: "end_turn" },
        });
        promptAwaitingQuestion = null;
      }
      if (msg.id === 101 && promptAwaitingPermission !== null) {
        send({
          jsonrpc: "2.0",
          id: promptAwaitingPermission,
          result: { stopReason: "end_turn" },
        });
        promptAwaitingPermission = null;
      }
    }
  }
});
