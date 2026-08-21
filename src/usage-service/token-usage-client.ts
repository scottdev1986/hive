import { z } from "zod";
import {
  TokenUsageSessionCreatedSchema,
  type TokenUsageSnapshot,
  TokenUsageSnapshotSchema,
  TokenUsageSubjectCreatedSchema,
} from "../schemas/token-usage-schema";
import { isTestRunnerEnv } from "../cli/invoker";
import { UserDaemonClient } from "../cli/user-daemon-client";
import { type JsonValue, requireJsonValue } from "../shared/json";

async function request(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<JsonValue> {
  const response = await new UserDaemonClient({
    port,
    verifyIdentity: !isTestRunnerEnv(),
  }).request(path, init);
  const body = requireJsonValue(await response.json().catch(() => null), path);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new Error(
      error.success
        ? error.data.error
        : `token usage request failed with HTTP ${response.status}`,
    );
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
  const query =
    repoRoot === undefined ? "" : `?repoRoot=${encodeURIComponent(repoRoot)}`;
  return TokenUsageSnapshotSchema.parse(
    await request(port, `/token-usage${query}`),
  );
}

export async function startTokenUsageSession(
  port: number,
  repoRoot: string,
): Promise<string> {
  return TokenUsageSessionCreatedSchema.parse(
    await request(port, "/token-usage/sessions", post({ repoRoot })),
  ).sessionId;
}

export async function startOrchestratorTokenSubject(
  port: number,
  sessionId: string,
  provider: string,
  cwd: string,
): Promise<string> {
  return TokenUsageSubjectCreatedSchema.parse(
    await request(
      port,
      `/token-usage/sessions/${sessionId}/orchestrators`,
      post({ provider, cwd }),
    ),
  ).subjectId;
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
