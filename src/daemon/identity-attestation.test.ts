import { describe, expect, test } from "bun:test";
import type { ExecutionIdentity } from "../schemas/agent";
import type { CodexIdentityObservation } from "./tool-telemetry";
import { reconcileCodexIdentity } from "./identity-attestation";

const LAUNCH: ExecutionIdentity = {
  tool: "codex",
  model: "gpt-5.6-sol",
  effort: "xhigh",
};

const observed = (
  model: string,
  effort: string,
): CodexIdentityObservation => ({
  status: "observed",
  model,
  effort,
  turnId: "turn-2",
  sessionId: "session-1",
  observedAt: "2026-07-15T18:00:00.000Z",
});

describe("reconcileCodexIdentity", () => {
  test("matching when observed model and effort equal the launch identity", () => {
    expect(reconcileCodexIdentity(LAUNCH, observed("gpt-5.6-sol", "xhigh")))
      .toEqual({
        identityState: "matching",
        observedIdentity: {
          model: "gpt-5.6-sol",
          effort: "xhigh",
          sessionId: "session-1",
          turnId: "turn-2",
          source: "codex-rollout",
          observedAt: "2026-07-15T18:00:00.000Z",
        },
        liveModel: "gpt-5.6-sol",
        liveEffort: "xhigh",
      });
  });

  test("drift on a wrong model, and records the observation verbatim", () => {
    const result = reconcileCodexIdentity(LAUNCH, observed("gpt-5.6-luna", "low"));
    expect(result.identityState).toEqual("drift");
    expect(result.observedIdentity).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "low",
    });
    expect(result.liveModel).toEqual("gpt-5.6-luna");
  });

  test("drift on a wrong effort even when the model matches", () => {
    expect(reconcileCodexIdentity(LAUNCH, observed("gpt-5.6-sol", "low"))
      .identityState).toEqual("drift");
  });

  test("unknown never fabricates an observation", () => {
    expect(reconcileCodexIdentity(LAUNCH, { status: "unknown" })).toEqual({
      identityState: "unknown",
      observedIdentity: null,
      liveModel: null,
      liveEffort: null,
    });
  });

  test("absent stays unattested and synthesizes nothing from the launch", () => {
    const result = reconcileCodexIdentity(LAUNCH, { status: "absent" });
    expect(result).toEqual({
      identityState: "unattested",
      observedIdentity: null,
      liveModel: null,
      liveEffort: null,
    });
    // The launch model never leaks into the observation.
    expect(result.liveModel).not.toEqual(LAUNCH.model);
  });

  test("carries the app-server source through when supplied", () => {
    const result = reconcileCodexIdentity(
      LAUNCH,
      observed("gpt-5.6-sol", "xhigh"),
      "codex-app-server",
    );
    expect(result.observedIdentity?.source).toEqual("codex-app-server");
  });
});
