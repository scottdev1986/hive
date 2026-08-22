import { isRecord } from "../../../shared/is-record";
import type { ClientRequest } from "./generated/0.146.0/ClientRequest";
import type { InitializeParams } from "./generated/0.146.0/InitializeParams";
import type { InitializeResponse } from "./generated/0.146.0/InitializeResponse";
import type { CodexAppServerWire } from "./jsonl-rpc";

export const CLIENT_NAME = "hive-protocol-terminal";
export const CLIENT_VERSION = "0.0.0";

type ClientMethod = ClientRequest["method"];

export const CODEX_APP_SERVER_METHODS = {
  initialize: "initialize",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadRead: "thread/read",
  threadList: "thread/list",
  threadSettingsUpdate: "thread/settings/update",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  compact: "thread/compact/start",
  review: "review/start",
  models: "model/list",
  permissions: "permissionProfile/list",
  config: "config/read",
  account: "account/read",
  skills: "skills/list",
} as const satisfies Readonly<Record<string, ClientMethod>>;

export type RequestId = number | string;

export class CodexAppServerIncompatibleError extends Error {
  readonly incompatible = true;

  constructor(message: string) {
    super(`Codex App Server incompatible: ${message}`);
    this.name = "CodexAppServerIncompatibleError";
  }
}

export function requiredString(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") {
    throw new CodexAppServerIncompatibleError(`${context}.${key} is absent`);
  }
  return field;
}

export function requestIdKey(id: RequestId): string {
  return `${typeof id}:${id}`;
}

export function isRequestId(value: unknown): value is RequestId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

export function validateHandshake(value: unknown): InitializeResponse {
  if (!isRecord(value)) {
    throw new CodexAppServerIncompatibleError(
      "initialize result is not an object",
    );
  }
  const userAgent = requiredString(value, "userAgent", "initialize result");
  const codexHome = requiredString(value, "codexHome", "initialize result");
  const platformFamily = requiredString(
    value,
    "platformFamily",
    "initialize result",
  );
  const platformOs = requiredString(value, "platformOs", "initialize result");
  if (!userAgent.startsWith(`${CLIENT_NAME}/`)) {
    throw new CodexAppServerIncompatibleError(
      `initialize userAgent does not report ${CLIENT_NAME}`,
    );
  }
  return { userAgent, codexHome, platformFamily, platformOs };
}

export async function initializeWire(
  wire: CodexAppServerWire,
): Promise<InitializeResponse> {
  const params: InitializeParams = {
    clientInfo: {
      name: CLIENT_NAME,
      title: "Hive protocol terminal",
      version: CLIENT_VERSION,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  };
  const response = validateHandshake(
    await wire.request(CODEX_APP_SERVER_METHODS.initialize, params),
  );
  wire.notify("initialized");
  return response;
}
