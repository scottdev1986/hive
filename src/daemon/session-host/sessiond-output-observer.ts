import type { TerminalGeometry } from "../../schemas/session-protocol";
import type { SessionHost, SessionLocator } from "./contract";
import { SessiondViewerAttachClient } from "./sessiond-viewer-attach";

export type SessiondOutputObservation = Readonly<{
  locator: SessionLocator;
  outputThrough: string;
  /**
   * What the pane is SHOWING — the reconstructed screen, not the tail of the
   * byte stream that produced it. Every vendor TUI revises what it has already
   * printed, so the two differ by everything the terminal has overwritten.
   */
  screen: string;
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
    // Report why observation failed; empty text alone cannot distinguish an
    // attach, replay, or decode failure from a genuinely empty pane.
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
