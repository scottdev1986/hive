import {
  QueenCompactReloadSchema,
  queenPinPresent,
} from "../../daemon/queen-provider-service/queen-pin";
import type { PaneDaemonClient } from "./pane-daemon-client";

/** The pane is a pipe: the daemon owns the pin and the live board. A body that
 * dropped the pin is refused rather than submitted — that would be a rewrite
 * without the one constraint compaction exists to restore. */
export async function fetchQueenCompactReload(
  client: Pick<PaneDaemonClient, "request" | "errorDetail">,
): Promise<string> {
  const response = await client.request("/queen/compact-reload");
  if (!response.ok) {
    throw new Error(await client.errorDetail(response));
  }
  const parsed = QueenCompactReloadSchema.parse(await response.json());
  if (!queenPinPresent(parsed.text)) {
    throw new Error("compact reload omitted the queen pin");
  }
  return parsed.text;
}
