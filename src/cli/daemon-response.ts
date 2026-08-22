import type { JsonValue } from "../shared/json";

export async function decodeJson(
  response: Response,
): Promise<JsonValue | null> {
  return await response.json().then(
    (value) => value as JsonValue,
    () => null,
  );
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
  const detail: DaemonErrorDetail = {
    message: typeof value.error === "string" ? value.error : fallback,
  };
  if (typeof value.reason === "string") detail.reason = value.reason;
  return detail;
}

export async function responseErrorDetail(response: Response): Promise<string> {
  const body = await decodeJson(response.clone());
  const fallback = await response.text().catch(() => "");
  return daemonErrorDetail(
    body,
    fallback.length > 0 ? fallback : `HTTP ${response.status}`,
  ).message;
}
