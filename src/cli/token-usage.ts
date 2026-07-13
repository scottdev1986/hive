import { z } from "zod";
import {
  TokenUsageSnapshotSchema,
  type TokenUsageSnapshot,
} from "../schemas";
import { operatorFetch } from "./credential";

const IdentifierResponseSchema = z.union([
  z.object({ sessionId: z.string().uuid() }),
  z.object({ subjectId: z.string().uuid() }),
]);

async function request(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await operatorFetch(`http://127.0.0.1:${port}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new Error(error.success
      ? error.data.error
      : `token usage request failed with HTTP ${response.status}`);
  }
  return body;
}

const post = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

export async function fetchTokenUsage(
  port: number,
  repoRoot?: string,
): Promise<TokenUsageSnapshot> {
  const query = repoRoot === undefined
    ? ""
    : `?repoRoot=${encodeURIComponent(repoRoot)}`;
  return TokenUsageSnapshotSchema.parse(
    await request(port, `/token-usage${query}`),
  );
}

export async function startTokenUsageSession(
  port: number,
  repoRoot: string,
): Promise<string> {
  const result = IdentifierResponseSchema.parse(
    await request(port, "/token-usage/sessions", post({ repoRoot })),
  );
  if (!("sessionId" in result)) throw new Error("daemon returned no token session id");
  return result.sessionId;
}

export async function startOrchestratorTokenSubject(
  port: number,
  sessionId: string,
  provider: string,
  cwd: string,
): Promise<string> {
  const result = IdentifierResponseSchema.parse(await request(
    port,
    `/token-usage/sessions/${sessionId}/orchestrators`,
    post({ provider, cwd }),
  ));
  if (!("subjectId" in result)) throw new Error("daemon returned no token subject id");
  return result.subjectId;
}

export async function endTokenUsageSubject(
  port: number,
  subjectId: string,
): Promise<void> {
  await request(port, `/token-usage/subjects/${subjectId}/end`, post({}));
}

export async function endTokenUsageSession(
  port: number,
  sessionId: string,
): Promise<void> {
  await request(port, `/token-usage/sessions/${sessionId}/end`, post({}));
}
