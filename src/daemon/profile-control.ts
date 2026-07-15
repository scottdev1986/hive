// The `ProfileControl` seam.
//
// The daemon server routes every profile MCP tool and gate/bypass route through
// this narrow interface. It exists so the server never reaches around it into
// `state.json` or `current.json`: the server authenticates, authorizes, and
// hands the call here; the implementation owns all profile lifecycle and
// storage. `ProfileCoordinator` (a later package) is the production
// implementation; P1 ships the seam, the tools, and the routes, and its tests
// inject a fake. Until the coordinator is wired, production construction simply
// omits the service — and then the server registers no profile tools or routes
// at all, rather than exposing surfaces that reach nowhere.
//
// `inventory` and `submit` take the authenticated `subject` because the profiler
// credential's authority is bound to the *active run*, not merely to the role:
// the implementation checks the subject against the live `{projectUuid, runId}`,
// so a token from another project, named instance, or completed run buys
// nothing. `submit`'s own subject-before-runId check (in the profile service) is
// preserved as defense in depth.
import type { ProjectProfile } from "../schemas/project-profile";
import type {
  ProfileInventoryRequest,
  ProfileInventoryResult,
  ProfileReprofileResult,
  ProfileSpawnGate,
  ProfileStatus,
  ProfileSubmitOutcome,
} from "../schemas/profile-tools";

/** A daemon-side reprofile command. The server assembles it from the
 * authenticated caller (never from the model): `source` is the caller's role,
 * `requestedBy` its subject, `guidance` the optional (normalized, capped)
 * investigation text. */
export interface ProfileReprofileCommand {
  source: string;
  requestedBy: string;
  guidance: string | null;
}

export interface ProfileControl {
  /** Lifecycle, current availability, exact paths/failure, active run, refresh
   * state, and the authoritative spawn gate. Operator/orchestrator read. */
  status(): Promise<ProfileStatus>;
  /** The validated current profile, or null — including null for a missing,
   * malformed, or otherwise unreadable `current.json`, never a thrown error. A
   * legacy profile is never returned. Operator/orchestrator read. */
  read(): Promise<ProjectProfile | null>;
  /** The authoritative spawn gate, derived from the validated read plus the
   * daemon-session bypass. Operator/orchestrator read. */
  gate(): Promise<ProfileSpawnGate>;
  /** Bounded catalog/content reads for the authenticated run. Profiler only;
   * the subject is bound to the active run. A caller who is not the run's own
   * profiler receives the opaque `{ status: "unauthorized" }` — never a
   * `denied` code, a catalog, or content — so an implementation cannot leak run
   * state down the refusal path while still satisfying this interface. */
  inventory(
    subject: string,
    request: ProfileInventoryRequest,
  ): Promise<ProfileInventoryResult>;
  /** Validate a candidate for the authenticated active run and atomically
   * commit only on success. Profiler only. The run binding is enforced HERE, not
   * merely deep in the service: a caller who is not the active run's profiler
   * MUST get `{ status: "unauthorized" }` and nothing else — no lifecycle, no
   * run id, no owner. Only the run's own profiler ever receives `accepted` or a
   * lossless `rejected`. This is the F2 opacity property, made a type-enforced
   * outcome of the seam so it survives per-caller. */
  submit(subject: string, candidate: unknown): Promise<ProfileSubmitOutcome>;
  /** Coalesce a refresh request and record requester/guidance provenance; never
   * a validation bypass. Operator/orchestrator request. */
  requestReprofile(
    command: ProfileReprofileCommand,
  ): Promise<ProfileReprofileResult>;
  /** Set the daemon-session bypass after the disclosure/failure UI. Operator
   * only; the act is audited by the caller. */
  continueWithoutProfile(requester: string): Promise<void>;
}
