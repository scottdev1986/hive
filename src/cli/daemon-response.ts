// Credential-free decoding shared by the user and pane HTTP clients. Keeping this module pure lets both clients agree on daemon error vocabulary without making either authentication path reachable from the other.

import type { JsonValue, JsonObject } from "../shared/json";
import { isRecord, isString } from "../shared/is-record";

export async function decodeJson(
  response: Response,
): Promise<JsonValue | null> {
  return await response.json().then(
    // SAFETY: The surrounding code already established this contract.
    (value) => value as JsonValue,
    () => null,
  );
}

export interface DaemonErrorDetail {
  message: string;
  reason?: string;
}

export function daemonErrorDetail<T>(
  body: T,
  fallback: string,
): DaemonErrorDetail {
  if (!isRecord(body) && !Array.isArray(body)) return { message: fallback };
  // SAFETY: The surrounding code already established this contract.
  const value = body as JsonObject;
  const detail: DaemonErrorDetail = {
    message: isString(value.error) ? value.error : fallback,
  };
  if (isString(value.reason)) detail.reason = value.reason;
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
