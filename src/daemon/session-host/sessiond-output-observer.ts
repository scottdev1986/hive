import type { TerminalGeometry } from "../../schemas/session-protocol";
import type { SessionHost, SessionLocator } from "./contract";
import { SessiondViewerAttachClient } from "./sessiond-viewer-attach";

export type SessiondOutputObservation = Readonly<{
  locator: SessionLocator;
  outputThrough: string;
  text: string;
  completeness: "complete" | "gap";
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
  } catch {
    return {
      locator,
      outputThrough: grant.outputSeq,
      text: "",
      completeness: "gap",
    };
  }
}
