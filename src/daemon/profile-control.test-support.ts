// Shared conformance for the ProfileControl opacity contract.
//
// Both P1 (against the fake) and P3 (against the real ProfileCoordinator) run
// this against a control that has an active run for SOME profiler, then pass a
// subject that is NOT that profiler. A caller who is not the active run's own
// profiler must receive EXACTLY `{ status: "unauthorized" }` from both run-bound
// tools — no code, message, lifecycle, run id, or owner. The type already
// forbids a leaky unauthorized variant at compile time; this proves the
// implementation actually routes a foreign caller down that path rather than
// answering with a catalog, a validation rejection, or a service message. An
// implementation cannot satisfy the interface while violating opacity if it
// also passes this. Throws on the first violation.
import type { ProfileControl } from "./profile-control";

export async function assertProfileControlOpacity(
  control: ProfileControl,
  foreignSubject: string,
): Promise<void> {
  assertOpaque("inventory", await control.inventory(foreignSubject, {}));
  assertOpaque("submit", await control.submit(foreignSubject, { unknowns: [] }));
}

function assertOpaque(tool: string, result: { status: string }): void {
  if (result.status !== "unauthorized") {
    throw new Error(
      `${tool} leaked run state to a foreign subject: expected an opaque ` +
        `{ status: "unauthorized" }, got status "${result.status}"`,
    );
  }
  const keys = Object.keys(result);
  if (keys.length !== 1) {
    throw new Error(
      `${tool} unauthorized outcome carried extra fields ${JSON.stringify(keys)}; ` +
        `it must be exactly { status: "unauthorized" } so nothing about the run leaks`,
    );
  }
}
