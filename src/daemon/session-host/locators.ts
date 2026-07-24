import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { AgentRecord } from "../../schemas";
import type { SessionLocator, SessionSubject } from "./contract";

const INSTANCE_HASH_LENGTH = 10;

export function sameSessionLocator(
  left: SessionLocator,
  right: SessionLocator,
): boolean {
  const sameSubject = left.subject.kind === right.subject.kind &&
    (left.subject.kind === "root" || (
      right.subject.kind === "agent" &&
      left.subject.agentId === right.subject.agentId
    ));
  return left.schemaVersion === right.schemaVersion &&
    left.instanceId === right.instanceId &&
    sameSubject &&
    left.generation === right.generation &&
    left.sessionId === right.sessionId &&
    left.hostKind === right.hostKind &&
    left.engineBuildId === right.engineBuildId;
}

export function sessionInstanceId(hiveHome: string): string {
  return createHash("sha256")
    .update(resolve(hiveHome))
    .digest("hex")
    .slice(0, INSTANCE_HASH_LENGTH);
}

export function mintSessionLocator(
  instanceId: string,
  subject: SessionSubject,
  generation: number,
  engineBuildId: string,
  now = Date.now(),
): SessionLocator {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Session generation must be a positive safe integer");
  }
  return {
    schemaVersion: 1,
    instanceId,
    subject,
    generation,
    sessionId: `ses_${uuidV7(now)}`,
    hostKind: "sessiond",
    engineBuildId,
  };
}

export function requireAgentSessionLocator(
  agent: Pick<AgentRecord, "id" | "sessionLocator">,
): SessionLocator {
  const locator = agent.sessionLocator;
  if (
    locator === undefined ||
    locator.subject.kind !== "agent" ||
    locator.subject.agentId !== agent.id
  ) {
    throw new Error(`Agent ${agent.id} has a mismatched SessionLocator`);
  }
  return locator;
}

export function nextAgentSessionLocator(
  agent: Pick<AgentRecord, "id" | "sessionLocator">,
): SessionLocator {
  const current = requireAgentSessionLocator(agent);
  return mintSessionLocator(
    current.instanceId,
    current.subject,
    current.generation + 1,
    current.engineBuildId,
  );
}

export function mintSessionRequestId(now = Date.now()): string {
  return `req_${uuidV7(now)}`;
}

function uuidV7(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new Error("UUIDv7 timestamp is outside the 48-bit range");
  }
  const timestamp = now.toString(16).padStart(12, "0");
  const random = randomBytes(10).toString("hex");
  const variant = ((Number.parseInt(random[3]!, 16) & 0x3) | 0x8).toString(16);
  const body = `${timestamp}7${random.slice(0, 3)}${variant}${random.slice(4, 19)}`;
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20, 32)}`;
}
