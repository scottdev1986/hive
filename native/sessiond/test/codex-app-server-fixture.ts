import { createInterface } from "node:readline";

type Message = {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function turnText(params: unknown): string {
  if (!isRecord(params) || !Array.isArray(params.input)) return "";
  return params.input
    .filter(isRecord)
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("");
}

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.146.0");
  process.exit(0);
}

let nextTurn = 1;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const message = JSON.parse(line) as Message;
  if (message.id === undefined || message.method === undefined) continue;
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "hive-protocol-terminal/0.146.0 (sessiond fixture)",
        codexHome: "/bounded-test-root",
        platformFamily: "unix",
        platformOs: "test",
      },
    });
    continue;
  }
  if (message.method === "thread/start") {
    send({
      id: message.id,
      result: { thread: { id: "thread-sessiond-fixture" } },
    });
    continue;
  }
  if (message.method === "turn/start") {
    const turnId = `turn-${nextTurn}`;
    nextTurn += 1;
    const text = turnText(message.params);
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({
      method: "turn/started",
      params: {
        threadId: "thread-sessiond-fixture",
        turn: { id: turnId, status: "inProgress" },
      },
    });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-sessiond-fixture",
        turnId,
        delta: text,
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-sessiond-fixture",
        turn: { id: turnId, status: "completed" },
      },
    });
    continue;
  }
  send({ id: message.id, result: {} });
}
