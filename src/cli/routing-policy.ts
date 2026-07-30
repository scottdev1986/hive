import { canonicalRoutingPolicyJson } from "../daemon/routing-policy-store";
import {
  type CandidateEffort,
  type CapabilityProvider,
  CapabilityProviderSchema,
  type RouteCandidate,
  type RouterMode,
  RouterModeSchema,
  type RoutingCategory,
  RoutingCategorySchema,
  type RoutingPolicy,
  type RoutingPolicyMutation,
  RoutingPolicySchema,
} from "../schemas";
import { requireDaemonPort } from "./control";
import { operatorFetch } from "./credential";

/**
 * `hive routing policy` / `set-provider` / `set-model` / `set-effort` /
 * `set-route` / `export` — the Model Control Center's contract. The UI is a
 * separate AppKit process that shells out to these commands; every read and
 * write goes through the daemon (the store's sole writer), and every mutation
 * carries the revision the caller read, so concurrent edits conflict loudly
 * instead of clobbering.
 *
 * Enablement here IS consent to spend, so
 * these commands are a safety surface: they validate locally, the daemon
 * validates again, and success prints the full updated document — the UI
 * never has to guess what state it produced.
 */

const policyUrl = (port: number): string =>
  `http://127.0.0.1:${port}/routing/policy`;

async function fetchPolicy(port: number): Promise<RoutingPolicy> {
  const response = await operatorFetch(policyUrl(port));
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (body as { error?: string } | null)?.error ??
        `routing policy read failed (HTTP ${response.status})`,
    );
  }
  return RoutingPolicySchema.parse(body);
}

async function applyPolicyMutation(
  port: number,
  mutation: RoutingPolicyMutation,
): Promise<RoutingPolicy> {
  const response = await operatorFetch(policyUrl(port), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (body as { error?: string } | null)?.error ??
        `routing policy write failed (HTTP ${response.status})`,
    );
  }
  return RoutingPolicySchema.parse(body);
}

const printPolicy = (policy: RoutingPolicy): void => {
  console.log(JSON.stringify(policy, null, 2));
};

function parseExpectedRevision(raw: string): number {
  const revision = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(
      `--expect-revision must be the non-negative revision you read, got ${JSON.stringify(raw)}`,
    );
  }
  return revision;
}

function parseProvider(raw: string): CapabilityProvider {
  const parsed = CapabilityProviderSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `unknown provider ${JSON.stringify(raw)}; Hive knows ${CapabilityProviderSchema.options.join(
        ", ",
      )}`,
    );
  }
  return parsed.data;
}

function parseRouteScope(raw: string): RoutingCategory | "global" {
  if (raw === "global") return "global";
  const parsed = RoutingCategorySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `unknown route scope ${JSON.stringify(raw)}; scopes are global, ${RoutingCategorySchema.options.join(
        ", ",
      )}`,
    );
  }
  return parsed.data;
}

function parseState(raw: string): "enabled" | "disabled" | "unset" {
  if (raw === "enabled" || raw === "disabled" || raw === "unset") return raw;
  throw new Error(
    `state must be enabled, disabled, or unset; got ${JSON.stringify(raw)}`,
  );
}

/** Explicit effort intent. "none" means the vendor's stated no-effort axis;
 * "provider-controlled" omits the flag without claiming to know the default,
 * and "hive-decides" selects only from source-ordered advertised levels. */
export function parseEffortTargetArg(
  raw: string,
): CandidateEffort | { mode: "never-configured" } {
  if (raw === "never-configured") return { mode: "never-configured" };
  if (raw === "hive-decides") return { mode: "hive-decides" };
  if (raw === "none") return { mode: "none" };
  if (raw === "provider-controlled") return { mode: "provider-controlled" };
  if (raw.startsWith("exact:")) {
    const value = raw.slice("exact:".length);
    if (value.length > 0) return { mode: "exact", value };
  }
  throw new Error(
    `effort must be hive-decides, never-configured, exact:LEVEL, none, or provider-controlled; got ${JSON.stringify(raw)}`,
  );
}

/**
 * One route candidate: `provider/model` (effort provider-controlled, weight
 * 1), `provider/model@LEVEL` (exact effort), `provider/model@none` (the
 * vendor's stated no-effort axis), each optionally suffixed `=WEIGHT` with an
 * integer 1–100. The model is always a specific id — there is deliberately no
 * way to write "whatever the vendor picks", and a bare "default" model id is
 * rejected downstream by the schema.
 */
export function parseRouteCandidateArg(raw: string): RouteCandidate {
  const equals = raw.lastIndexOf("=");
  const target = equals === -1 ? raw : raw.slice(0, equals);
  let weight = 1;
  if (equals !== -1) {
    weight = Number.parseInt(raw.slice(equals + 1), 10);
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 100) {
      throw new Error(
        `a candidate weight is an integer 1–100; got ${JSON.stringify(raw.slice(equals + 1))}`,
      );
    }
  }
  const at = target.lastIndexOf("@");
  const body = at === -1 ? target : target.slice(0, at);
  const level = at === -1 ? null : target.slice(at + 1);
  const effort: CandidateEffort =
    level === null
      ? { mode: "provider-controlled" }
      : level === "none"
        ? { mode: "none" }
        : level === "hive-decides"
          ? { mode: "hive-decides" }
          : { mode: "exact", value: level };
  const slash = body.indexOf("/");
  if (slash === -1 || slash === body.length - 1 || level === "") {
    throw new Error(
      `a route candidate is provider/model[@LEVEL|@none][=WEIGHT]; got ${JSON.stringify(
        raw,
      )}`,
    );
  }
  return {
    provider: parseProvider(body.slice(0, slash)),
    model: body.slice(slash + 1),
    effort,
    weight,
  };
}

export async function printRoutingPolicy(port?: number): Promise<void> {
  printPolicy(await fetchPolicy(requireDaemonPort(port)));
}

/** Deterministic dump: stable key and row order, byte-identical for identical
 * policy — the inspectability half of the SQLite ruling. */
export async function exportRoutingPolicy(port?: number): Promise<void> {
  process.stdout.write(
    canonicalRoutingPolicyJson(await fetchPolicy(requireDaemonPort(port))),
  );
}

export async function setProviderPolicy(
  provider: string,
  state: string,
  expectRevision: string,
  port?: number,
): Promise<void> {
  printPolicy(
    await applyPolicyMutation(requireDaemonPort(port), {
      op: "set-provider",
      expectedRevision: parseExpectedRevision(expectRevision),
      provider: parseProvider(provider),
      state: parseState(state),
    }),
  );
}

export async function setModelPolicy(
  provider: string,
  model: string,
  state: string,
  expectRevision: string,
  port?: number,
): Promise<void> {
  printPolicy(
    await applyPolicyMutation(requireDaemonPort(port), {
      op: "set-model",
      expectedRevision: parseExpectedRevision(expectRevision),
      provider: parseProvider(provider),
      model,
      state: parseState(state),
    }),
  );
}

export async function setModelEffort(
  provider: string,
  model: string,
  effort: string,
  expectRevision: string,
  port?: number,
): Promise<void> {
  printPolicy(
    await applyPolicyMutation(requireDaemonPort(port), {
      op: "set-effort",
      expectedRevision: parseExpectedRevision(expectRevision),
      provider: parseProvider(provider),
      model,
      effort: effort === "unset" ? "unset" : parseEffortTargetArg(effort),
    }),
  );
}

function parseRouterMode(raw: string): RouterMode {
  const parsed = RouterModeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `route mode must be ${RouterModeSchema.options.join(" or ")}; got ${JSON.stringify(raw)}`,
    );
  }
  return parsed.data;
}

/** Replace one scope's route. Zero candidates clears the scope back to
 * unconfigured (`global` cleared refuses automatic routing). */
export async function setRoute(
  scope: string,
  mode: string,
  candidates: string[],
  expectRevision: string,
  port?: number,
): Promise<void> {
  printPolicy(
    await applyPolicyMutation(requireDaemonPort(port), {
      op: "set-route",
      expectedRevision: parseExpectedRevision(expectRevision),
      scope: parseRouteScope(scope),
      route:
        candidates.length === 0
          ? null
          : {
              mode: parseRouterMode(mode),
              candidates: candidates.map(parseRouteCandidateArg),
            },
    }),
  );
}
