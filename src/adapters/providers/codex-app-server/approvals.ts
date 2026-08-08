// Projects Codex approval requests into the short user-facing summary shown
// while a permission decision is pending. The method set is the server-request
// surface the session treats as approval rather than ordinary notification.

import type { ServerRequest } from "./generated/0.146.0/ServerRequest";
import type { CodexAppServerWire } from "./jsonl-rpc";
import type { RequestId } from "./wire";

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
  readonly params: Record<string, unknown>;
  readonly wire: CodexAppServerWire;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function approvalSummary(
  method: CodexApprovalMethod,
  params: Record<string, unknown>,
): string {
  if (method === "item/commandExecution/requestApproval") {
    const command =
      typeof params.command === "string" ? params.command : "command";
    const reason =
      typeof params.reason === "string" ? ` — ${params.reason}` : "";
    return `${command}${reason}`;
  }
  if (method === "item/fileChange/requestApproval") {
    return typeof params.reason === "string"
      ? params.reason
      : "Approve proposed file changes";
  }
  return typeof params.reason === "string"
    ? params.reason
    : "Approve additional permissions";
}
