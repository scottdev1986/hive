// The vocabulary of Hive's authorization boundary: who a caller is, what it may ask for, and the credential that says so. Only the names live here. Minting, verification, and the role-to-action allowlists are the daemon's job — this file is the leaf that mail, memory, and usage may name when they declare which action a tool needs, without importing the authorization engine to do it.
import type { Hv1CapabilityConstraints } from "./capability";

export type Role = "user" | "orchestrator" | "writer" | "reader";

export type Action =
  | "status:read"
  | "status:write"
  | "terminal:observe"
  | "quota:read"
  | "quota:write"
  | "token-usage:read"
  | "token-usage:write"
  | "agent:spawn"
  | "agent:kill"
  | "agent:mark-dead"
  | "agent:recover"
  | "settlement:decide"
  | "settlement:execute"
  | "approval:read"
  | "approval:decide"
  | "message:send"
  | "message:ack"
  | "message:read"
  | "inbox:read"
  | "branch:land"
  | "knowledge:read"
  | "run:bootstrap"
  | "node:create"
  | "grant:issue"
  | "task:write"
  | "task:read"
  | "review:write"
  | "artifact:write"
  | "artifact:read"
  | "ownership:transfer"
  | "memory:read"
  | "memory:write"
  | "memory:delete"
  | "event:report"
  | "telemetry:report"
  | "root-token:mint"
  | "autonomy:read"
  | "autonomy:write"
  | "routing-policy:read"
  | "routing-policy:write"
  | "queen-provider:write"
  | "run-control:write"
  | "succession:write"
  | "workspace-visibility:write";

export interface Capability {
  readonly id: string;
  readonly subject: string;
  readonly role: Role;
  readonly epoch: number;
  readonly constraints?: Hv1CapabilityConstraints | undefined;
  readonly subjects?: readonly string[] | undefined;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}
