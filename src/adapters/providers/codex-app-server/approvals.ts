import type { ServerRequest } from "./generated/0.146.0/ServerRequest";
import type { CodexAppServerWire } from "./jsonl-rpc";
import type { RequestId } from "./wire";
import { isString } from "../../../shared/is-record";
import type { JsonObject } from "../../../shared/json";

export const CODEX_APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
] as const satisfies readonly ServerRequest["method"][];

export type CodexApprovalMethod = (typeof CODEX_APPROVAL_METHODS)[number];

export interface PendingApproval {
  readonly requestId: string;
  readonly wireRequestId: RequestId;
  readonly method: CodexApprovalMethod;
  readonly params: JsonObject;
  readonly wire: CodexAppServerWire;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function approvalSummary(
  method: CodexApprovalMethod,
  params: JsonObject,
): string {
  if (method === "item/commandExecution/requestApproval") {
    const command = isString(params.command) ? params.command : "command";
    const reason = isString(params.reason) ? ` — ${params.reason}` : "";
    return `${command}${reason}`;
  }
  if (method === "item/fileChange/requestApproval") {
    return isString(params.reason)
      ? params.reason
      : "Approve proposed file changes";
  }
  return isString(params.reason)
    ? params.reason
    : "Approve additional permissions";
}
