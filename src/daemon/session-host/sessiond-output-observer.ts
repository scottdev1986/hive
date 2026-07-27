import type { TerminalGeometry } from "../../schemas/session-protocol";
import type { SessionHost, SessionLocator } from "./contract";
import { SessiondViewerAttachClient } from "./sessiond-viewer-attach";

export type SessiondOutputObservation = Readonly<{
  locator: SessionLocator;
  outputThrough: string;
  text: string;
  completeness: "complete" | "gap";
  /** Why the observation is empty, when it is. Absent on success. */
  failure?: string;
}>;

export async function observeSessiondOutput(
  host: Pick<SessionHost, "issueAttach">,
  locator: SessionLocator,
  geometry: TerminalGeometry,
  viewerId: string,
): Promise<SessiondOutputObservation | null> {
  const grant = await host.issueAttach(locator, {
    viewerId,
    geometry,
    operations: ["view"],
  });
  try {
    const observed = await SessiondViewerAttachClient.observeOutput({
      locator,
      grant,
      geometry,
      viewerId,
    });
    return { locator, ...observed };
  } catch (error) {
    // SAY WHY. This catch used to return empty text and nothing else, which is
    // how "the queen cannot read the pane" reached an operator as the single
    // digit `outputThrough: 0` — no error, no log, no clue which of attach,
    // replay, or decode had failed. An observation that could not be taken is
    // reportable; a silent one is a capability that disappears without notice.
    return {
      locator,
      outputThrough: grant.outputSeq,
      text: "",
      completeness: "gap",
      failure:
        error instanceof Error ? error.message : "unknown attach failure",
    };
  }
}
