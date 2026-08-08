import type { TerminalGeometry } from "../../schemas/session-protocol";
import type { SessionHost, SessionLocator } from "./session-host-contract";
import { SessiondViewerAttachClient } from "./sessiond-viewer-attach";

export type SessiondOutputObservation = Readonly<{
  locator: SessionLocator;
  outputThrough: string;
  screen: string;
  completeness: "complete" | "gap";
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
    // Report why observation failed; empty text alone cannot distinguish an attach, replay, or decode failure from a genuinely empty pane.
    return {
      locator,
      outputThrough: grant.outputSeq,
      screen: "",
      completeness: "gap",
      failure:
        error instanceof Error ? error.message : "unknown attach failure",
    };
  }
}
