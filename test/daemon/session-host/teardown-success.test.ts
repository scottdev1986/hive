import { describe, expect, test } from "bun:test";
import { sessiondTeardownSucceeded } from "../../../src/daemon/session-host/hive-terminal-host";

type Result = Parameters<typeof sessiondTeardownSucceeded>[0];

const escapeesUnaccounted = {
  phase: "neutral-control",
  code: "UNKNOWN",
  diagnosticId: "process-tree-escapees-unaccounted",
} as const;

const survivor = {
  pid: 4_100,
  startToken: "4100:123400",
  reason: "still running",
} as const;

const result = (overrides: Partial<Result> = {}): Result => ({
  state: "unknown",
  survivors: [],
  errors: [],
  ...overrides,
});

describe("the one teardown-success predicate", () => {
  // THE CASE THE PLATFORM ACTUALLY PRODUCES. process_inspector reports
  // `unknown` unconditionally for a process-tree target, so this — not
  // `terminated` — is what a clean kill looks like from here. A caller that
  // demanded `terminated` waited for a state that cannot occur.
  test("the documented floor is success: unknown, no survivors, escapees stated", () => {
    expect(
      sessiondTeardownSucceeded(
        result({ state: "unknown", errors: [escapeesUnaccounted] }),
      ),
    ).toBe(true);
  });

  test("positive termination with nothing left behind is success", () => {
    expect(sessiondTeardownSucceeded(result({ state: "terminated" }))).toBe(
      true,
    );
  });

  // The floor is a statement about what could not be observed, not a licence to
  // ignore what was. A survivor is a live process and no diagnostic excuses one.
  test("a survivor is never success, whatever the diagnostics say", () => {
    expect(
      sessiondTeardownSucceeded(
        result({
          state: "unknown",
          survivors: [survivor],
          errors: [escapeesUnaccounted],
        }),
      ),
    ).toBe(false);
    expect(
      sessiondTeardownSucceeded(
        result({ state: "terminated", survivors: [survivor] }),
      ),
    ).toBe(false);
    expect(
      sessiondTeardownSucceeded(
        result({ state: "survivors", survivors: [survivor] }),
      ),
    ).toBe(false);
  });

  // Without the diagnostic, `unknown` is an unexplained absence of evidence
  // rather than the documented floor, and it must not be read as success.
  test("bare unknown is not success: the floor requires the escapee gap stated", () => {
    expect(sessiondTeardownSucceeded(result({ state: "unknown" }))).toBe(false);
    expect(
      sessiondTeardownSucceeded(
        result({
          state: "unknown",
          errors: [{ ...escapeesUnaccounted, diagnosticId: "SOMETHING_ELSE" }],
        }),
      ),
    ).toBe(false);
  });
});
