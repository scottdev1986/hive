// Credential-free decoding shared by the user and pane HTTP clients. Keeping this module pure lets both clients agree on daemon error vocabulary without making either authentication path reachable from the other.

export async function decodeJson(response: Response): Promise<unknown | null> {
  return await response.json().catch(() => null);
}

export interface DaemonErrorDetail {
  message: string;
  reason?: string;
}

export function daemonErrorDetail(
  body: unknown,
  fallback: string,
): DaemonErrorDetail {
  if (typeof body !== "object" || body === null) return { message: fallback };
  const value = body as Record<string, unknown>;
  return {
    message: typeof value.error === "string" ? value.error : fallback,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

export async function responseErrorDetail(response: Response): Promise<string> {
  const body = await decodeJson(response.clone());
  const fallback = await response.text().catch(() => "");
  return daemonErrorDetail(
    body,
    fallback.length > 0 ? fallback : `HTTP ${response.status}`,
  ).message;
}
