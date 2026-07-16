import { describe, expect, test } from "bun:test";
import {
  AuthorizedLaunch,
  type LaunchGateChecks,
  requireAuthorizedLaunch,
} from "./authorized-launch";

const pass = async (): Promise<string | null> => null;
const passingChecks = (): LaunchGateChecks => ({
  compatibility: pass,
  resolution: pass,
  enablement: pass,
  availability: pass,
  capabilityFloor: pass,
  effort: async (candidate) => ({ effort: candidate.effort, refusal: null }),
});

describe("AuthorizedLaunch", () => {
  if (false) {
    // @ts-expect-error The constructor is private; making it public breaks typecheck.
    new AuthorizedLaunch({ tool: "codex", model: "ungated" });
  }

  test("only the complete ordered gate can mint a launch", async () => {
    const order: string[] = [];
    const checks = passingChecks();
    for (const key of [
      "compatibility",
      "resolution",
      "enablement",
      "availability",
      "capabilityFloor",
    ] as const) {
      checks[key] = async () => (order.push(key), null);
    }
    checks.effort = async () => (order.push("effort"), { refusal: null });

    const result = await AuthorizedLaunch.gate(
      { tool: "codex", model: "gpt-test" },
      checks,
    );
    expect(result.authorized).toBeInstanceOf(AuthorizedLaunch);
    expect(order).toEqual([
      "compatibility",
      "resolution",
      "enablement",
      "availability",
      "capabilityFloor",
      "effort",
    ]);
  });

  test.each([
    ["compatibility", "compatibility"],
    ["resolution", "resolution"],
    ["enablement", "enablement"],
    ["availability", "availability"],
    ["capabilityFloor", "capability-floor"],
  ] as const)("%s refusal names its reason", async (guard, reason) => {
    const checks = passingChecks();
    checks[guard] = async () => `${reason} says no`;
    const result = await AuthorizedLaunch.gate(
      { tool: "codex", model: "gpt-test" },
      checks,
    );
    expect(result.refusal).toEqual({ reason, detail: `${reason} says no` });
  });

  test("effort refusal names its reason", async () => {
    const checks = passingChecks();
    checks.effort = async () => ({ refusal: "effort says no" });
    const result = await AuthorizedLaunch.gate(
      { tool: "codex", model: "gpt-test" },
      checks,
    );
    expect(result.refusal).toEqual({ reason: "effort", detail: "effort says no" });
  });

  test("a plain object cannot cross the runtime adapter boundary", () => {
    expect(() => requireAuthorizedLaunch({
      tool: "codex",
      model: "ungated",
    } as unknown as AuthorizedLaunch)).toThrow("requires an AuthorizedLaunch");
  });

  test("production code contains no cast around the private launch brand", async () => {
    const offenders: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.ts").scan(".")) {
      if (path.endsWith("authorized-launch.test.ts")) continue;
      const source = await Bun.file(path).text();
      if (/\bas\s+(?:unknown\s+as\s+)?AuthorizedLaunch\b/.test(source)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
