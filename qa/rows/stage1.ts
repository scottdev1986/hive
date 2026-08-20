// Stage 1 rows T1-01..T1-09 of the QA plan of record (qa-plan-v2.md §4). Every
// row drives a real product door — the qa-control gate for UI, the installed
// CLI for export — and reads an independent oracle: GET /routing/policy and
// GET /model-control/snapshot over the observe clients, or `hive routing
// export` as a second process. Driving and reading never share a code path.
//
// The Task Router edits one CATEGORY route: the membership, weight and effort
// controls act on the route of the category the screen shows, and Apply POSTs
// that category's route. A category with no configured route has its member
// checkboxes disabled, so every mutating row first ensures the category route
// exists (mode select creates the draft) — an unplantable precondition is NO
// MEASUREMENT by plan rule 6.
//
// Three disciplines hold the stage together:
// - A row that cannot reach its oracle is NO MEASUREMENT, never FAIL; only the
//   row's own assertion leg can FAIL.
// - The negative rows (T1-04, T1-08) are meaningless unless the revision is
//   proven to move in the same run, so each names its positive control.
// - Every mutating row restores what it changed, so the suite is convergent:
//   T1-09 can then promise that a second consecutive run diffs empty.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Exec,
  type GateCommand,
  type GateResponse,
  gate,
  type ObserveClients,
  type RowResult,
  waitFor,
} from "../runner";

export interface Stage1Context {
  exec: Exec;
  qaBin: string;
  observe: ObserveClients | null;
  sleep: (ms: number) => Promise<void>;
  baselinePath: string;
  /** The rig daemon's instance home: `hive routing export` resolves its daemon port from HIVE_HOME, so the runner points it here. */
  instanceHome: string;
  boundMs?: number;
  /** How long a drive waits for the app to answer the gate at all. The router screen's first render blocks the app's main thread far longer than the gate's own 5s request timeout, so "did not answer" is retried, not reported. */
  gatePatienceMs?: number;
}

interface Candidate {
  provider: string;
  model: string;
  weight: number;
  effort: unknown;
}

interface RouteDoc {
  mode: string;
  candidates: Candidate[];
}

interface PolicyDoc {
  revision: number;
  providers: Record<string, string>;
  categories: Record<string, RouteDoc>;
}

interface CatalogEntry {
  provider: string;
  model: string;
  effortOptions: Array<{ argument: string; label: string; effort: unknown }>;
}

interface SnapshotDoc {
  observedAt: string;
  routing: {
    catalog: CatalogEntry[];
    modes: Array<{ id: string; label: string; weightEditable: boolean }>;
    categories: Array<{ id: string; label: string }>;
    providers: Record<string, { state: string }>;
  };
}

type Drive =
  | { ok: true }
  | {
      ok: false;
      status: "FAIL" | "NO MEASUREMENT";
      reason: string;
    };

const bound = (ctx: Stage1Context): number => ctx.boundMs ?? 5_000;

const keyOf = (entry: { provider: string; model: string }): string =>
  `${entry.provider}/${entry.model}`;

const candidateOf = (
  policy: PolicyDoc,
  category: string,
  key: { provider: string; model: string },
): Candidate | null =>
  policy.categories[category]?.candidates.find(
    (candidate) =>
      candidate.provider === key.provider && candidate.model === key.model,
  ) ?? null;

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical comparison for the rig baseline: revision and updatedAt move on every accepted write, so repeatability is judged on policy content alone. */
export function normalizePolicyExport(exportText: string): string {
  const doc = JSON.parse(exportText) as Record<string, unknown>;
  delete doc.revision;
  delete doc.updatedAt;
  return stable(doc);
}

// Oracles. Any failure to READ is thrown; the row maps it to NO MEASUREMENT,
// because a row that cannot reach its oracle was not measured.
async function policyViaHttp(ctx: Stage1Context): Promise<PolicyDoc> {
  const result = await (ctx.observe as ObserveClients).httpJson(
    "/routing/policy",
  );
  if (result.status !== 200) {
    throw new Error(`GET /routing/policy answered ${result.status}`);
  }
  return result.body as PolicyDoc;
}

async function snapshotViaHttp(ctx: Stage1Context): Promise<SnapshotDoc> {
  const result = await (ctx.observe as ObserveClients).httpJson(
    "/model-control/snapshot",
  );
  if (result.status !== 200) {
    throw new Error(`GET /model-control/snapshot answered ${result.status}`);
  }
  return result.body as SnapshotDoc;
}

async function exportViaCli(ctx: Stage1Context): Promise<string> {
  const result = await ctx.exec([ctx.qaBin, "routing", "export"], {
    env: { ...process.env, HIVE_HOME: ctx.instanceHome },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `hive routing export exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

async function exportDoc(ctx: Stage1Context): Promise<PolicyDoc> {
  return JSON.parse(await exportViaCli(ctx)) as PolicyDoc;
}

/** One qa-control drive. Exit 1 with the app's reason is a measured door failure (FAIL); exit 2 or garbage is a rig fact (NO MEASUREMENT). */
/** One qa-control drive. Exit 1 with the app's reason is a measured door failure (FAIL); exit 2 or garbage is a rig fact (NO MEASUREMENT). Two answers are rig timing, not verdicts, and are retried within the gate patience: "did not answer" (the app's main thread is busy, e.g. the router screen's first render) and "control is not actionable" right after a successful drivable wait (the screen is mid-rebuild after a draft change or an apply — the control is momentarily dead, and the drivable-then-invoke pair has an inherent TOCTOU window). Only outlasting the patience is reported. */
async function drive(ctx: Stage1Context, command: GateCommand): Promise<Drive> {
  const patience = ctx.gatePatienceMs ?? 60_000;
  const deadline = Date.now() + patience;
  for (;;) {
    const answer = await gate(ctx.exec, ctx.qaBin, command);
    if (
      answer.outcome === "no-measurement" &&
      answer.reason.includes("did not answer") &&
      Date.now() < deadline
    ) {
      await ctx.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
      continue;
    }
    if (answer.outcome === "answered" && answer.exitCode !== 0) {
      const name =
        command.verb === "enumerate"
          ? "enumerate"
          : `${command.verb} ${command.identifier}`;
      if (
        answer.response.reason === "control is not actionable" &&
        Date.now() < deadline
      ) {
        await ctx.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
        continue;
      }
      return {
        ok: false,
        status: "FAIL",
        reason: `${name}: ${answer.response.reason ?? "reported a failure"}`,
      };
    }
    if (answer.outcome === "no-measurement") {
      return { ok: false, status: "NO MEASUREMENT", reason: answer.reason };
    }
    return { ok: true };
  }
}

type Poll<T> =
  | { kind: "met"; value: T }
  | { kind: "fail" }
  | { kind: "unreachable" };

/** Poll a wire oracle until the predicate holds. Distinguishes "answered but never true" (a measured FAIL) from "never answered" (NO MEASUREMENT). */
async function pollOracle<T>(
  ctx: Stage1Context,
  probe: () => Promise<T | null>,
): Promise<Poll<T>> {
  let answered = false;
  const result = await waitFor(
    async () => {
      try {
        const value = await probe();
        answered = true;
        return value;
      } catch {
        return null;
      }
    },
    bound(ctx),
    ctx.sleep,
    250,
  );
  if (result.state === "met") return { kind: "met", value: result.value };
  return answered ? { kind: "fail" } : { kind: "unreachable" };
}

/** Poll the gate's enumerate until the predicate holds; "dead" means the app stayed silent past the gate patience. */
async function pollGate<T>(
  ctx: Stage1Context,
  pick: (response: GateResponse) => T | null,
): Promise<Poll<T> | { kind: "dead" }> {
  let alive = true;
  const result = await waitFor(
    async () => {
      const answer = await gate(ctx.exec, ctx.qaBin, { verb: "enumerate" });
      if (answer.outcome === "no-measurement") {
        alive = false;
        return null;
      }
      alive = true;
      return pick(answer.response);
    },
    ctx.gatePatienceMs ?? bound(ctx),
    ctx.sleep,
    250,
  );
  if (result.state === "met") return { kind: "met", value: result.value };
  return alive ? { kind: "fail" } : { kind: "dead" };
}

const pollOutcome = <T>(
  poll: Poll<T> | { kind: "dead" },
  failReason: string,
  unreachableReason: string,
): Drive =>
  poll.kind === "met"
    ? { ok: true }
    : poll.kind === "fail"
      ? { ok: false, status: "FAIL", reason: failReason }
      : { ok: false, status: "NO MEASUREMENT", reason: unreachableReason };

/** Show the router screen on the suite's category. Setup failure is NO MEASUREMENT (unplantable precondition), not a row failure. */
async function showRouterCategory(
  ctx: Stage1Context,
  categoryLabel: string,
): Promise<Drive> {
  const nav = await drive(ctx, {
    verb: "invoke",
    identifier: "shell-nav-router",
  });
  if (!nav.ok) {
    return {
      ok: false,
      status: "NO MEASUREMENT",
      reason: `could not reach the router screen: ${nav.reason}`,
    };
  }
  const select = await drive(ctx, {
    verb: "select",
    identifier: "task-router-category",
    title: categoryLabel,
  });
  if (!select.ok) {
    return {
      ok: false,
      status: "NO MEASUREMENT",
      reason: `could not select category ${categoryLabel}: ${select.reason}`,
    };
  }
  return { ok: true };
}

/** Wait until a control is on screen and enabled before driving it. After a mode select or an apply the screen rebuilds, and a control invoked mid-rebuild reads as disabled ("control is not actionable") or absent — a rig-timing fact, so outlasting the bound is NO MEASUREMENT, never a FAIL. */
async function drivable(
  ctx: Stage1Context,
  identifier: string,
): Promise<Drive> {
  const poll = await pollGate(ctx, (response) => {
    const control = response.controls?.find(
      (candidate) => candidate.identifier === identifier,
    );
    return control?.enabled && control.functionallyPresent ? true : null;
  });
  if (poll.kind === "met") return { ok: true };
  return {
    ok: false,
    status: "NO MEASUREMENT",
    reason: `control ${identifier} never became drivable within the bound`,
  };
}

/** Apply the current draft, waiting first for Apply to come up enabled. A policy-refusal banner means the product gave a definite answer before the row reached its oracle, so it is NO MEASUREMENT. An enabled edit control with no refusal banner is a product regression, not a condition the runner may retry. */
async function applyDraft(ctx: Stage1Context): Promise<Drive> {
  let lastSeen = "no enumerate answered";
  const poll = await pollGate<"ready" | "refusal">(ctx, (response) => {
    const controls = response.controls ?? [];
    const refusal = controls.some(
      (control) =>
        control.identifier === "shell-banner-policy-write-refusal" &&
        control.functionallyPresent,
    );
    const apply = controls.find(
      (control) => control.identifier === "task-router-apply",
    );
    const draft = controls.some(
      (control) =>
        control.identifier === "task-router-draft" &&
        control.functionallyPresent,
    );
    const conflict = controls.some(
      (control) =>
        control.identifier === "task-router-conflict" &&
        control.functionallyPresent,
    );
    lastSeen = `apply present=${apply?.functionallyPresent ?? false} enabled=${apply?.enabled ?? false} draft=${draft} conflict=${conflict} refusal=${refusal}`;
    if (refusal) return "refusal";
    return apply?.enabled && apply.functionallyPresent ? "ready" : null;
  });
  if (poll.kind === "met" && poll.value === "refusal") {
    return {
      ok: false,
      status: "NO MEASUREMENT",
      reason:
        "shell-banner-policy-write-refusal observed before task-router-apply became drivable",
    };
  }
  if (poll.kind === "met") {
    return await drive(ctx, {
      verb: "invoke",
      identifier: "task-router-apply",
    });
  }
  if (poll.kind === "fail") {
    return {
      ok: false,
      status: "FAIL",
      reason:
        "task-router-apply stayed disabled without shell-banner-policy-write-refusal " +
        `(last seen: ${lastSeen})`,
    };
  }
  return {
    ok: false,
    status: "NO MEASUREMENT",
    reason: `task-router-apply never became drivable within the bound (last seen: ${lastSeen})`,
  };
}

/** Set a weight field and apply. */
async function driveWeightInput(
  ctx: Stage1Context,
  name: string,
  value: number,
): Promise<Drive> {
  const command: GateCommand = {
    verb: "invoke",
    identifier: `task-router-weight-${name}`,
    input: String(value),
  };
  const set = await drive(ctx, command);
  if (!set.ok) return set;
  return await applyDraft(ctx);
}

/** Toggle a membership checkbox and apply. */
async function driveMemberToggle(
  ctx: Stage1Context,
  name: string,
): Promise<Drive> {
  const ready = await drivable(ctx, `task-router-member-${name}`);
  if (!ready.ok) return ready;
  const toggle = await drive(ctx, {
    verb: "invoke",
    identifier: `task-router-member-${name}`,
  });
  if (!toggle.ok) return toggle;
  return await applyDraft(ctx);
}

/** Plant a member of the category route through the membership door, creating the route (Weighted split) when the category has none. An unplantable precondition is NO MEASUREMENT by plan rule 6, whatever the door said. */
async function plantMember(
  ctx: Stage1Context,
  category: string,
  categoryLabel: string,
  key: { provider: string; model: string },
): Promise<Drive> {
  const name = keyOf(key);
  const shown = await showRouterCategory(ctx, categoryLabel);
  if (!shown.ok) return shown;
  // Idempotent: an already-present member is the planted state, not a toggle.
  try {
    if (candidateOf(await exportDoc(ctx), category, key) !== null) {
      return { ok: true };
    }
  } catch (error) {
    return {
      ok: false,
      status: "NO MEASUREMENT",
      reason: (error as Error).message,
    };
  }
  let routeExists: boolean;
  try {
    routeExists = (await exportDoc(ctx)).categories[category] !== undefined;
  } catch (error) {
    return {
      ok: false,
      status: "NO MEASUREMENT",
      reason: (error as Error).message,
    };
  }
  if (!routeExists) {
    const mode = await drive(ctx, {
      verb: "select",
      identifier: "task-router-mode",
      title: "Weighted split",
    });
    if (!mode.ok) {
      return {
        ok: false,
        status: "NO MEASUREMENT",
        reason: `could not create the ${category} route: ${mode.reason}`,
      };
    }
  }
  const applied = await driveMemberToggle(ctx, name);
  if (!applied.ok) {
    return {
      ok: false,
      status: "NO MEASUREMENT",
      reason: `could not plant member ${name}: ${applied.reason}`,
    };
  }
  const poll = await pollOracle(ctx, async () =>
    candidateOf(await exportDoc(ctx), category, key) !== null ? true : null,
  );
  if (poll.kind !== "met") {
    return {
      ok: false,
      status: "NO MEASUREMENT",
      reason: `could not plant member ${name}: export never showed it`,
    };
  }
  return { ok: true };
}

/** Remove a planted member and prove the export converged. A restore that does not converge is a FAIL: it leaves the rig dirty and breaks T1-09's repeatability promise. */
async function unplantMember(
  ctx: Stage1Context,
  category: string,
  categoryLabel: string,
  key: { provider: string; model: string },
): Promise<Drive> {
  const name = keyOf(key);
  const shown = await showRouterCategory(ctx, categoryLabel);
  if (!shown.ok) {
    return { ok: false, status: "FAIL", reason: shown.reason };
  }
  const applied = await driveMemberToggle(ctx, name);
  if (!applied.ok) return applied;
  const poll = await pollOracle(ctx, async () =>
    candidateOf(await exportDoc(ctx), category, key) === null ? true : null,
  );
  return pollOutcome(
    poll,
    `restore of ${name} did not converge; rig left dirty`,
    `restore of ${name} could not be read back`,
  );
}

export async function rowT101RouterReachable(
  ctx: Stage1Context,
): Promise<RowResult> {
  const id = "T1-01";
  const nav = await drive(ctx, {
    verb: "invoke",
    identifier: "shell-nav-router",
  });
  if (!nav.ok) return { id, status: nav.status, reason: nav.reason };
  const poll = await pollGate(ctx, (response) => {
    if (response.route !== "router") return null;
    const apply = response.controls?.find(
      (control) => control.identifier === "task-router-apply",
    );
    return apply?.functionallyPresent === true ? true : null;
  });
  if (poll.kind === "met") {
    return {
      id,
      status: "PASS",
      reason: "second enumerate shows route=router with task-router-apply",
    };
  }
  return {
    id,
    status: poll.kind === "dead" ? "NO MEASUREMENT" : "FAIL",
    reason:
      poll.kind === "dead"
        ? "the gate stopped answering after shell-nav-router"
        : "after shell-nav-router the screen never showed route=router with task-router-apply",
  };
}

export async function rowT102MemberApplyWrites(
  ctx: Stage1Context,
  category: string,
  categoryLabel: string,
  key: { provider: string; model: string },
): Promise<RowResult> {
  const id = "T1-02";
  const name = keyOf(key);
  let revBefore: number;
  try {
    revBefore = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  const shown = await showRouterCategory(ctx, categoryLabel);
  if (!shown.ok) return { id, status: "NO MEASUREMENT", reason: shown.reason };
  // The suite plants k0 into this route before T1-02 runs (the screen refuses
  // to apply an empty route, so the route must already stand for the restore
  // to be possible); its absence here is an unplantable precondition.
  try {
    if ((await exportDoc(ctx)).categories[category] === undefined) {
      return {
        id,
        status: "NO MEASUREMENT",
        reason: `the ${category} route does not exist (k0 was not planted)`,
      };
    }
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  const applied = await driveMemberToggle(ctx, name);
  if (!applied.ok) {
    return { id, status: applied.status, reason: applied.reason };
  }
  // The poll must see the write, not the pre-write state: requiring the
  // candidate AND a revision bump in one condition is the only shape that
  // cannot pass on a snapshot from before the apply landed.
  let sawCandidate = false;
  const poll = await pollOracle(ctx, async () => {
    const present = candidateOf(await exportDoc(ctx), category, key) !== null;
    sawCandidate = present;
    const revision = (await policyViaHttp(ctx)).revision;
    return present && revision > revBefore ? true : null;
  });
  const written = pollOutcome(
    poll,
    sawCandidate
      ? `apply wrote ${name} but the revision stayed ${revBefore}`
      : `apply reported ok but export shows no candidate ${name}`,
    `export unreadable after apply of ${name}`,
  );
  if (!written.ok) {
    return { id, status: written.status, reason: written.reason };
  }
  const restored = await unplantMember(ctx, category, categoryLabel, key);
  if (!restored.ok) {
    return { id, status: restored.status, reason: restored.reason };
  }
  let revAfter: number;
  try {
    revAfter = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  return {
    id,
    status: "PASS",
    reason: `candidate ${name} added through apply in ${category} (rev ${revBefore} -> ${revAfter}) and removed again`,
  };
}

export async function rowT103WeightWritesThrough(
  ctx: Stage1Context,
  category: string,
  categoryLabel: string,
  key: { provider: string; model: string },
): Promise<RowResult> {
  const id = "T1-03";
  const name = keyOf(key);
  const planted = await plantMember(ctx, category, categoryLabel, key);
  if (!planted.ok) {
    return { id, status: planted.status, reason: planted.reason };
  }
  let weightBefore: number;
  let revBefore: number;
  try {
    const candidate = candidateOf(await exportDoc(ctx), category, key);
    if (candidate === null) throw new Error(`export lost ${name} after plant`);
    weightBefore = candidate.weight;
    revBefore = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  const target = weightBefore === 3 ? 4 : 3;
  const fieldReady = await drivable(ctx, `task-router-weight-${name}`);
  if (!fieldReady.ok) {
    return { id, status: fieldReady.status, reason: fieldReady.reason };
  }
  const set = await driveWeightInput(ctx, name, target);
  if (!set.ok) return { id, status: set.status, reason: set.reason };
  const poll = await pollOracle(ctx, async () => {
    const candidate = candidateOf(await exportDoc(ctx), category, key);
    return candidate?.weight === target ? true : null;
  });
  const written = pollOutcome(
    poll,
    `apply reported ok but export shows weight ${target} never landed on ${name}`,
    `export unreadable after weight apply on ${name}`,
  );
  if (!written.ok) {
    return { id, status: written.status, reason: written.reason };
  }
  let revAfter: number;
  try {
    revAfter = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  if (revAfter <= revBefore) {
    return {
      id,
      status: "FAIL",
      reason: `weight ${target} landed but the revision stayed ${revBefore}`,
    };
  }
  const reset = await driveWeightInput(ctx, name, weightBefore);
  if (!reset.ok) return { id, status: reset.status, reason: reset.reason };
  const restored = await pollOracle(ctx, async () => {
    const candidate = candidateOf(await exportDoc(ctx), category, key);
    return candidate?.weight === weightBefore ? true : null;
  });
  const converged = pollOutcome(
    restored,
    `weight restore to ${weightBefore} did not converge; rig left dirty`,
    `weight restore on ${name} could not be read back`,
  );
  if (!converged.ok) {
    return { id, status: converged.status, reason: converged.reason };
  }
  const unplanted = await unplantMember(ctx, category, categoryLabel, key);
  if (!unplanted.ok) {
    return { id, status: unplanted.status, reason: unplanted.reason };
  }
  return {
    id,
    status: "PASS",
    reason: `weight ${weightBefore} -> ${target} -> ${weightBefore} through apply (rev ${revBefore} -> ${revAfter})`,
  };
}

export async function rowT104IllegalWeightRefused(
  ctx: Stage1Context,
  category: string,
  categoryLabel: string,
  key: { provider: string; model: string },
): Promise<RowResult> {
  const id = "T1-04";
  const name = keyOf(key);
  let revControlBefore: number;
  try {
    revControlBefore = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  // The positive control: planting the member must move the revision, or the
  // unchanged-revision assertion below measures nothing.
  const planted = await plantMember(ctx, category, categoryLabel, key);
  if (!planted.ok) {
    return { id, status: planted.status, reason: planted.reason };
  }
  let revBefore: number;
  try {
    revBefore = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  if (revBefore <= revControlBefore) {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: `positive control failed: planting ${name} did not move the revision past ${revControlBefore}`,
    };
  }
  const fieldReady = await drivable(ctx, `task-router-weight-${name}`);
  if (!fieldReady.ok) {
    return { id, status: fieldReady.status, reason: fieldReady.reason };
  }
  const set = await drive(ctx, {
    verb: "invoke",
    identifier: `task-router-weight-${name}`,
    input: "0",
  });
  if (!set.ok) return { id, status: set.status, reason: set.reason };
  const poll = await pollGate(ctx, (response) => {
    const apply = response.controls?.find(
      (control) => control.identifier === "task-router-apply",
    );
    return apply !== undefined && apply.enabled === false ? true : null;
  });
  if (poll.kind === "dead") {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: "the gate stopped answering after the illegal weight",
    };
  }
  if (poll.kind === "fail") {
    return {
      id,
      status: "FAIL",
      reason: "task-router-apply stayed enabled with weight 0 in the field",
    };
  }
  let revAfter: number;
  try {
    revAfter = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  if (revAfter !== revBefore) {
    return {
      id,
      status: "FAIL",
      reason: `the revision moved ${revBefore} -> ${revAfter} on a refused weight`,
    };
  }
  // Cleanup: a legal value back in the field (no apply), then unplant.
  await drive(ctx, {
    verb: "invoke",
    identifier: `task-router-weight-${name}`,
    input: "1",
  });
  const unplanted = await unplantMember(ctx, category, categoryLabel, key);
  if (!unplanted.ok) {
    return { id, status: unplanted.status, reason: unplanted.reason };
  }
  return {
    id,
    status: "PASS",
    reason: `apply disabled and revision unchanged at ${revBefore} with weight 0 (control: plant moved ${revControlBefore} -> ${revBefore})`,
  };
}

export async function rowT105ModeEffortWriteThrough(
  ctx: Stage1Context,
  category: string,
  categoryLabel: string,
  key: { provider: string; model: string },
): Promise<RowResult> {
  const id = "T1-05";
  const name = keyOf(key);
  const planted = await plantMember(ctx, category, categoryLabel, key);
  if (!planted.ok) {
    return { id, status: planted.status, reason: planted.reason };
  }
  let snapshot: SnapshotDoc;
  let exported: PolicyDoc;
  let revBefore: number;
  try {
    snapshot = await snapshotViaHttp(ctx);
    exported = await exportDoc(ctx);
    revBefore = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  const modeBefore = exported.categories[category]?.mode ?? null;
  if (modeBefore === null) {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: `the ${category} route has no mode after planting`,
    };
  }
  const modeTarget = snapshot.routing.modes.find(
    (mode) => mode.id !== modeBefore,
  );
  if (modeTarget === undefined) {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: "the snapshot offers no second mode to select",
    };
  }
  const candidateBefore = candidateOf(exported, category, key);
  const entry = snapshot.routing.catalog.find(
    (catalogEntry) =>
      catalogEntry.provider === key.provider &&
      catalogEntry.model === key.model,
  );
  const options = entry?.effortOptions ?? [];
  if (options.length < 2) {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: `catalog offers ${options.length} effort options for ${name}; cannot change effort`,
    };
  }
  const effortIndexBefore = options.findIndex((option) =>
    sameJson(option.effort, candidateBefore?.effort),
  );
  const effortIndexTarget = (effortIndexBefore + 1) % options.length;
  const selectMode = await drive(ctx, {
    verb: "select",
    identifier: "task-router-mode",
    title: modeTarget.label,
  });
  if (!selectMode.ok) {
    return { id, status: selectMode.status, reason: selectMode.reason };
  }
  const effortReady = await drivable(ctx, `task-router-effort-${name}`);
  if (!effortReady.ok) {
    return { id, status: effortReady.status, reason: effortReady.reason };
  }
  const selectEffort = await drive(ctx, {
    verb: "select",
    identifier: `task-router-effort-${name}`,
    index: effortIndexTarget,
  });
  if (!selectEffort.ok) {
    return { id, status: selectEffort.status, reason: selectEffort.reason };
  }
  const apply = await applyDraft(ctx);
  if (!apply.ok) return { id, status: apply.status, reason: apply.reason };
  const poll = await pollOracle(ctx, async () => {
    const doc = await exportDoc(ctx);
    const candidate = candidateOf(doc, category, key);
    return doc.categories[category]?.mode === modeTarget.id &&
      sameJson(candidate?.effort, options[effortIndexTarget]?.effort)
      ? true
      : null;
  });
  const written = pollOutcome(
    poll,
    `apply reported ok but export shows neither mode ${modeTarget.id} nor the selected effort on ${name}`,
    "export unreadable after mode/effort apply",
  );
  if (!written.ok) {
    return { id, status: written.status, reason: written.reason };
  }
  let revAfter: number;
  try {
    revAfter = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  if (revAfter <= revBefore) {
    return {
      id,
      status: "FAIL",
      reason: `mode/effort landed but the revision stayed ${revBefore}`,
    };
  }
  // Restore mode and effort so the run converges, then unplant.
  const modeLabel = snapshot.routing.modes.find(
    (mode) => mode.id === modeBefore,
  )?.label;
  if (modeLabel === undefined) {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: `no label for the pre-row mode ${modeBefore}`,
    };
  }
  const modeRestore = await drive(ctx, {
    verb: "select",
    identifier: "task-router-mode",
    title: modeLabel,
  });
  if (!modeRestore.ok) {
    return { id, status: modeRestore.status, reason: modeRestore.reason };
  }
  if (effortIndexBefore >= 0) {
    const effortRestore = await drive(ctx, {
      verb: "select",
      identifier: `task-router-effort-${name}`,
      index: effortIndexBefore,
    });
    if (!effortRestore.ok) {
      return { id, status: effortRestore.status, reason: effortRestore.reason };
    }
  }
  const reapply = await applyDraft(ctx);
  if (!reapply.ok) {
    return { id, status: reapply.status, reason: reapply.reason };
  }
  const restored = await pollOracle(ctx, async () => {
    const doc = await exportDoc(ctx);
    return doc.categories[category]?.mode === modeBefore ? true : null;
  });
  const converged = pollOutcome(
    restored,
    `mode restore to ${modeBefore} did not converge; rig left dirty`,
    "mode restore could not be read back",
  );
  if (!converged.ok) {
    return { id, status: converged.status, reason: converged.reason };
  }
  const unplanted = await unplantMember(ctx, category, categoryLabel, key);
  if (!unplanted.ok) {
    return { id, status: unplanted.status, reason: unplanted.reason };
  }
  return {
    id,
    status: "PASS",
    reason: `mode ${modeBefore} -> ${modeTarget.id} and effort option ${effortIndexTarget} wrote through apply (rev ${revBefore} -> ${revAfter}), then restored`,
  };
}

export async function rowT106ApplyIsTheOnlyWrite(
  ctx: Stage1Context,
  category: string,
  categoryLabel: string,
  key: { provider: string; model: string },
): Promise<RowResult> {
  const id = "T1-06";
  const name = keyOf(key);
  const shown = await showRouterCategory(ctx, categoryLabel);
  if (!shown.ok) return { id, status: "NO MEASUREMENT", reason: shown.reason };
  let revBefore: number;
  try {
    revBefore = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  const ready = await drivable(ctx, `task-router-member-${name}`);
  if (!ready.ok) return { id, status: ready.status, reason: ready.reason };
  const toggle = await drive(ctx, {
    verb: "invoke",
    identifier: `task-router-member-${name}`,
  });
  if (!toggle.ok) return { id, status: toggle.status, reason: toggle.reason };
  let revDraft: number;
  try {
    revDraft = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  if (revDraft !== revBefore) {
    return {
      id,
      status: "FAIL",
      reason: `a draft edit moved the revision ${revBefore} -> ${revDraft} without apply`,
    };
  }
  const applied = await applyDraft(ctx);
  if (!applied.ok) {
    return { id, status: applied.status, reason: applied.reason };
  }
  const poll = await pollOracle(ctx, async () => {
    const present = candidateOf(await exportDoc(ctx), category, key) !== null;
    const revision = (await policyViaHttp(ctx)).revision;
    return present && revision > revBefore ? true : null;
  });
  const written = pollOutcome(
    poll,
    `apply reported ok but neither the candidate ${name} nor a revision bump appeared`,
    "oracles unreadable after apply",
  );
  if (!written.ok) {
    return { id, status: written.status, reason: written.reason };
  }
  const unplanted = await unplantMember(ctx, category, categoryLabel, key);
  if (!unplanted.ok) {
    return { id, status: unplanted.status, reason: unplanted.reason };
  }
  return {
    id,
    status: "PASS",
    reason: `draft edit left revision ${revBefore} untouched; apply moved it and wrote ${name}`,
  };
}

export async function rowT107ProviderToggleIsSpendConsent(
  ctx: Stage1Context,
  provider: string,
): Promise<RowResult> {
  const id = "T1-07";
  const nav = await drive(ctx, {
    verb: "invoke",
    identifier: "shell-nav-models",
  });
  if (!nav.ok) return { id, status: nav.status, reason: nav.reason };
  const routed = await pollGate(ctx, (response) =>
    response.route === "models" ? true : null,
  );
  if (routed.kind !== "met") {
    return {
      id,
      status: routed.kind === "dead" ? "NO MEASUREMENT" : "FAIL",
      reason:
        routed.kind === "dead"
          ? "the gate stopped answering after shell-nav-models"
          : "the models screen never came up after shell-nav-models",
    };
  }
  let stateBefore: string;
  let revBefore: number;
  try {
    const state = (await snapshotViaHttp(ctx)).routing.providers[provider]
      ?.state;
    if (state === undefined) {
      return {
        id,
        status: "NO MEASUREMENT",
        reason: `provider ${provider} is absent from the snapshot`,
      };
    }
    stateBefore = state;
    revBefore = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  // The export lists only configured providers: an unconfigured provider's
  // first flip configures it enabled, and its restore lands on disabled —
  // which is the state the next run starts from, so it is the state the row
  // must restore to for the suite to converge.
  const wanted = stateBefore === "enabled" ? "disabled" : "enabled";
  const restoreTo = stateBefore === "unconfigured" ? "disabled" : stateBefore;
  const ready = await drivable(ctx, `models-quota-provider-${provider}`);
  if (!ready.ok) return { id, status: ready.status, reason: ready.reason };
  const toggle = await drive(ctx, {
    verb: "invoke",
    identifier: `models-quota-provider-${provider}`,
  });
  if (!toggle.ok) return { id, status: toggle.status, reason: toggle.reason };
  const poll = await pollOracle(ctx, async () => {
    const doc = await exportDoc(ctx);
    const revision = (await policyViaHttp(ctx)).revision;
    return doc.providers[provider] === wanted && revision > revBefore
      ? true
      : null;
  });
  const flipped = pollOutcome(
    poll,
    `provider toggle reported ok but export never showed ${provider}=${wanted} with a revision bump`,
    "oracles unreadable after the provider toggle",
  );
  if (!flipped.ok) {
    return { id, status: flipped.status, reason: flipped.reason };
  }
  let revFlipped: number;
  try {
    revFlipped = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  const backReady = await drivable(ctx, `models-quota-provider-${provider}`);
  if (!backReady.ok) {
    return { id, status: backReady.status, reason: backReady.reason };
  }
  const back = await drive(ctx, {
    verb: "invoke",
    identifier: `models-quota-provider-${provider}`,
  });
  if (!back.ok) return { id, status: back.status, reason: back.reason };
  const restored = await pollOracle(ctx, async () =>
    (await exportDoc(ctx)).providers[provider] === restoreTo ? true : null,
  );
  const converged = pollOutcome(
    restored,
    `provider restore to ${restoreTo} did not converge; rig left dirty`,
    "provider restore could not be read back",
  );
  if (!converged.ok) {
    return { id, status: converged.status, reason: converged.reason };
  }
  return {
    id,
    status: "PASS",
    reason: `${provider} ${stateBefore} -> ${wanted} -> ${restoreTo} with revision ${revBefore} -> ${revFlipped} on the flip`,
  };
}

export async function rowT108ProbeRefreshIsARead(
  ctx: Stage1Context,
  control: string | null,
): Promise<RowResult> {
  const id = "T1-08";
  if (control === null) {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: "no positive control in this run (T1-07 did not pass)",
    };
  }
  const nav = await drive(ctx, {
    verb: "invoke",
    identifier: "shell-nav-models",
  });
  if (!nav.ok) {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: `could not reach the models screen: ${nav.reason}`,
    };
  }
  let observedBefore: string;
  let revBefore: number;
  try {
    observedBefore = (await snapshotViaHttp(ctx)).observedAt;
    revBefore = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  const ready = await drivable(ctx, "models-quota-probe-refresh");
  if (!ready.ok) return { id, status: ready.status, reason: ready.reason };
  const refresh = await drive(ctx, {
    verb: "invoke",
    identifier: "models-quota-probe-refresh",
  });
  if (!refresh.ok) {
    return { id, status: refresh.status, reason: refresh.reason };
  }
  const poll = await pollOracle(ctx, async () =>
    (await snapshotViaHttp(ctx)).observedAt !== observedBefore ? true : null,
  );
  if (poll.kind === "unreachable") {
    return {
      id,
      status: "NO MEASUREMENT",
      reason: "snapshot unreadable after probe refresh",
    };
  }
  if (poll.kind === "fail") {
    return {
      id,
      status: "FAIL",
      reason: "probe refresh never advanced the snapshot's observedAt",
    };
  }
  let revAfter: number;
  try {
    revAfter = (await policyViaHttp(ctx)).revision;
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  if (revAfter !== revBefore) {
    return {
      id,
      status: "FAIL",
      reason: `probe refresh moved the revision ${revBefore} -> ${revAfter}`,
    };
  }
  return {
    id,
    status: "PASS",
    reason: `snapshot observedAt advanced, revision unchanged at ${revBefore} (control: ${control})`,
  };
}

export async function rowT109RigBaseline(
  ctx: Stage1Context,
  category: string,
  categoryLabel: string,
  key: { provider: string; model: string },
): Promise<RowResult> {
  const id = "T1-09";
  const name = keyOf(key);
  let planted: Drive = { ok: true };
  try {
    if (candidateOf(await exportDoc(ctx), category, key) === null) {
      planted = await plantMember(ctx, category, categoryLabel, key);
      if (!planted.ok) {
        return { id, status: planted.status, reason: planted.reason };
      }
    }
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  let normalized: string;
  try {
    normalized = normalizePolicyExport(await exportViaCli(ctx));
  } catch (error) {
    return { id, status: "NO MEASUREMENT", reason: (error as Error).message };
  }
  if (!existsSync(ctx.baselinePath)) {
    mkdirSync(dirname(ctx.baselinePath), { recursive: true });
    writeFileSync(ctx.baselinePath, `${normalized}\n`, { mode: 0o600 });
    return {
      id,
      status: "PASS",
      reason: `rig baseline recorded at ${ctx.baselinePath} with ${name} selected in ${category} (the rig's deterministic catalog-first provider)`,
    };
  }
  const baseline = readFileSync(ctx.baselinePath, "utf8").trim();
  if (baseline !== normalized) {
    return {
      id,
      status: "FAIL",
      reason:
        "this run's export differs from the recorded baseline (revision/updatedAt excluded); the suite is not repeatable",
    };
  }
  return {
    id,
    status: "PASS",
    reason: "second consecutive run diffs empty against the rig baseline",
  };
}

const noMeasurement = (id: string, reason: string): RowResult => ({
  id,
  status: "NO MEASUREMENT",
  reason,
});

/** The stage, in plan order, against a shared rig. The suite works one category route (the catalog's first): k0 is the deterministic catalog-first provider/model the suite leaves selected there (T1-09); k1 is the throwaway every mutating row plants and restores. */
export async function runStage1Rows(ctx: Stage1Context): Promise<RowResult[]> {
  const ids = [
    "T1-01",
    "T1-02",
    "T1-03",
    "T1-04",
    "T1-05",
    "T1-06",
    "T1-07",
    "T1-08",
    "T1-09",
  ];
  if (ctx.observe === null) {
    return ids.map((id) =>
      noMeasurement(id, "no daemon port or user credential readable"),
    );
  }
  const rows: RowResult[] = [await rowT101RouterReachable(ctx)];
  let k0: CatalogEntry | undefined;
  let k1: CatalogEntry | undefined;
  let category = "light_research";
  let categoryLabel = "Light research";
  try {
    const snapshot = await snapshotViaHttp(ctx);
    k0 = snapshot.routing.catalog[0];
    k1 = snapshot.routing.catalog[1];
    const first = snapshot.routing.categories[0];
    if (first !== undefined) {
      category = first.id;
      categoryLabel = first.label;
    }
  } catch {
    // k0/k1 stay undefined; the rows that need them report NO MEASUREMENT.
  }
  if (k0 === undefined || k1 === undefined) {
    rows.push(
      ...["T1-02", "T1-03", "T1-04", "T1-05", "T1-06"].map((id) =>
        noMeasurement(
          id,
          "the routing catalog offers fewer than two probed models",
        ),
      ),
    );
  } else {
    // The suite's standing precondition: k0 sits in the category route for the
    // whole stage. The screen refuses to apply an empty route, so without k0
    // already there, T1-02's restore could never remove k1 again.
    const standing = await plantMember(ctx, category, categoryLabel, k0);
    if (!standing.ok) {
      rows.push(
        ...["T1-02", "T1-03", "T1-04", "T1-05", "T1-06"].map((id) =>
          noMeasurement(id, standing.reason),
        ),
      );
    } else {
      rows.push(
        await rowT102MemberApplyWrites(ctx, category, categoryLabel, k1),
      );
      rows.push(
        await rowT103WeightWritesThrough(ctx, category, categoryLabel, k1),
      );
      rows.push(
        await rowT104IllegalWeightRefused(ctx, category, categoryLabel, k1),
      );
      rows.push(
        await rowT105ModeEffortWriteThrough(ctx, category, categoryLabel, k1),
      );
      rows.push(
        await rowT106ApplyIsTheOnlyWrite(ctx, category, categoryLabel, k1),
      );
    }
  }
  let flipProvider: string | null = null;
  try {
    const providers = Object.keys(
      (await snapshotViaHttp(ctx)).routing.providers,
    );
    flipProvider =
      providers.find((provider) => provider !== k0?.provider) ??
      providers[0] ??
      null;
  } catch {
    // Stays null.
  }
  const t107 =
    flipProvider === null
      ? noMeasurement("T1-07", "no provider in the snapshot to toggle")
      : await rowT107ProviderToggleIsSpendConsent(ctx, flipProvider);
  rows.push(t107);
  const control =
    t107.status === "PASS" ? `T1-07 moved the revision (${t107.reason})` : null;
  rows.push(await rowT108ProbeRefreshIsARead(ctx, control));
  rows.push(
    k0 === undefined
      ? noMeasurement(
          "T1-09",
          "the routing catalog offers fewer than two probed models",
        )
      : await rowT109RigBaseline(ctx, category, categoryLabel, k0),
  );
  return rows;
}
