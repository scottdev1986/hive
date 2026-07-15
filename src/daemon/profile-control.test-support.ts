// Shared conformance for the ProfileControl opacity contract.
//
// Both P1 (against the fake) and P3 (against the real ProfileCoordinator) run
// this. A caller who is not the active run's own profiler must receive EXACTLY
// `{ status: "unauthorized" }` from both run-bound tools — no code, message,
// lifecycle, run id, or owner. The type already forbids a leaky unauthorized
// variant at compile time; this proves the implementation actually routes such
// a caller down that path rather than answering with a catalog, a validation
// rejection, or — the subtle hole — a `{ status: "denied", code: "no-active-run" }`.
//
// TWO scenarios are REQUIRED, not one, because the result union legitimately
// permits a `denied`/`no-active-run` operational code: an implementation that
// answers "no active run ⇒ denied/no-active-run" for everyone would pass a
// single active-run+foreigner check while still telling a completed-run token
// holder that no run is active — leaking completed-vs-foreign state. Requiring
// the completed + former-owner scenario forces the binding check to come first,
// so that when no run is active EVERY caller (former owner included) gets the
// opaque refusal. Throws on the first violation.
import type { ProfileControl } from "./profile-control";

export interface ProfileControlOpacityScenarios {
  /** A control WITH an active profiling run, probed by a subject that is NOT its
   * profiler (a cross-project or otherwise foreign token). */
  readonly activeRunForeign: { control: ProfileControl; subject: string };
  /** A control with NO active run (the run completed), probed by the subject
   * that USED to own it — a once-valid, now-stale token. This is the strongest
   * case: the most legitimate-looking caller must still learn nothing. */
  readonly completedFormerOwner: { control: ProfileControl; subject: string };
}

export async function assertProfileControlOpacity(
  scenarios: ProfileControlOpacityScenarios,
): Promise<void> {
  await assertScenarioOpaque(
    "active run + foreign subject",
    scenarios.activeRunForeign,
  );
  await assertScenarioOpaque(
    "completed run + former-owner subject",
    scenarios.completedFormerOwner,
  );
}

async function assertScenarioOpaque(
  label: string,
  scenario: { control: ProfileControl; subject: string },
): Promise<void> {
  const { control, subject } = scenario;
  assertOpaque(`${label}: inventory`, await control.inventory(subject, {}));
  assertOpaque(`${label}: submit`, await control.submit(subject, { unknowns: [] }));
}

function assertOpaque(context: string, result: { status: string }): void {
  if (result.status !== "unauthorized") {
    throw new Error(
      `${context} leaked run state: expected an opaque ` +
        `{ status: "unauthorized" }, got status "${result.status}"`,
    );
  }
  const keys = Object.keys(result);
  if (keys.length !== 1) {
    throw new Error(
      `${context} unauthorized outcome carried extra fields ${JSON.stringify(keys)}; ` +
        `it must be exactly { status: "unauthorized" } so nothing about the run leaks`,
    );
  }
}
