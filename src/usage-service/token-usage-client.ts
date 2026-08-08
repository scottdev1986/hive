import { z } from "zod";
import {
  type TokenUsageEventIngest,
  TokenUsageSessionCreatedSchema,
  type TokenUsageSnapshot,
  TokenUsageSnapshotSchema,
  TokenUsageSubjectCreatedSchema,
} from "../schemas/token-usage-schema";
import { isTestRunnerEnv } from "../cli/invoker";
import { UserDaemonClient } from "../cli/user-daemon-client";

async function request(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await new UserDaemonClient({
    port,
    verifyIdentity: !isTestRunnerEnv(),
  }).request(path, init);
  const body = await response.json().catch(() => null);
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

export async function recordTokenUsageEvents(
  port: number,
  subjectId: string,
  events: readonly TokenUsageEventIngest[],
): Promise<void> {
  await request(
    port,
    `/token-usage/subjects/${subjectId}/events`,
    post({ events }),
  );
}

export async function endTokenUsageSession(
  port: number,
  sessionId: string,
): Promise<void> {
  await request(port, `/token-usage/sessions/${sessionId}/end`, post({}));
}
