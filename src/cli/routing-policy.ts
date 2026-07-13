import {
  CapabilityProviderSchema,
  RoutingCategorySchema,
  RoutingPolicySchema,
  type CapabilityProvider,
  type ChainEntry,
  type EffortTarget,
  type RoutingCategory,
  type RoutingPolicy,
  type RoutingPolicyMutation,
} from "../schemas";
import { canonicalRoutingPolicyJson } from "../daemon/routing-policy-store";
import { requireDaemonPort } from "./control";
import { operatorFetch } from "./credential";

/**
 * `hive routing policy` / `set-provider` / `set-model` / `set-effort` /
 * `set-chain` / `export` — the Model Control Center's contract. The UI is a
 * separate AppKit process that shells out to these commands; every read and
 * write goes through the daemon (the store's sole writer), and every mutation
 * carries the revision the caller read, so concurrent edits conflict loudly
 * instead of clobbering.
 *
 * Enablement here IS consent to spend (the approval prompts are retired), so
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
      `unknown provider ${JSON.stringify(raw)}; Hive knows ${
        CapabilityProviderSchema.options.join(", ")
      }`,
    );
  }
  return parsed.data;
}

function parseCategory(raw: string): RoutingCategory {
  const parsed = RoutingCategorySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `unknown category ${JSON.stringify(raw)}; categories are ${
        RoutingCategorySchema.options.join(", ")
      }`,
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

/** `exact:LEVEL` | `none` | `provider-controlled` (optionally `unset` where
 * the caller allows it). "none" means the vendor's stated no-effort axis;
 * "provider-controlled" omits the flag without claiming to know the default. */
export function parseEffortTargetArg(raw: string): EffortTarget {
  if (raw === "none") return { mode: "none" };
  if (raw === "provider-controlled") return { mode: "provider-controlled" };
  if (raw.startsWith("exact:")) {
    const value = raw.slice("exact:".length);
    if (value.length > 0) return { mode: "exact", value };
  }
  throw new Error(
    `effort must be exact:LEVEL, none, or provider-controlled; got ${JSON.stringify(raw)}`,
  );
}

/**
 * One chain link: `provider/model` (effort provider-controlled),
 * `provider/model@LEVEL` (exact effort), or `provider/model@none` (the
 * vendor's stated no-effort axis). The model is always a specific id — there
 * is deliberately no way to write "whatever the vendor picks", and a bare
 * "default" model id is rejected downstream by the schema.
 */
export function parseChainEntryArg(raw: string): ChainEntry {
  const at = raw.lastIndexOf("@");
  const body = at === -1 ? raw : raw.slice(0, at);
  const level = at === -1 ? null : raw.slice(at + 1);
  const effort: EffortTarget = level === null
    ? { mode: "provider-controlled" }
    : level === "none"
    ? { mode: "none" }
    : { mode: "exact", value: level };
  const slash = body.indexOf("/");
  if (slash === -1 || slash === body.length - 1 || level === "") {
    throw new Error(
      `a chain entry is provider/model, provider/model@LEVEL, or provider/model@none; got ${
        JSON.stringify(raw)
      }`,
    );
  }
  return {
    provider: parseProvider(body.slice(0, slash)),
    model: body.slice(slash + 1),
    effort,
  };
}

export async function printRoutingPolicy(): Promise<void> {
  printPolicy(await fetchPolicy(requireDaemonPort()));
}

/** Deterministic dump: stable key and row order, byte-identical for identical
 * policy — the inspectability half of the SQLite ruling. */
export async function exportRoutingPolicy(): Promise<void> {
  process.stdout.write(
    canonicalRoutingPolicyJson(await fetchPolicy(requireDaemonPort())),
  );
}

export async function setProviderPolicy(
  provider: string,
  state: string,
  expectRevision: string,
): Promise<void> {
  printPolicy(await applyPolicyMutation(requireDaemonPort(), {
    op: "set-provider",
    expectedRevision: parseExpectedRevision(expectRevision),
    provider: parseProvider(provider),
    state: parseState(state),
  }));
}

export async function setModelPolicy(
  provider: string,
  model: string,
  state: string,
  expectRevision: string,
): Promise<void> {
  printPolicy(await applyPolicyMutation(requireDaemonPort(), {
    op: "set-model",
    expectedRevision: parseExpectedRevision(expectRevision),
    provider: parseProvider(provider),
    model,
    state: parseState(state),
  }));
}

export async function setModelEffort(
  provider: string,
  model: string,
  effort: string,
  expectRevision: string,
): Promise<void> {
  printPolicy(await applyPolicyMutation(requireDaemonPort(), {
    op: "set-effort",
    expectedRevision: parseExpectedRevision(expectRevision),
    provider: parseProvider(provider),
    model,
    effort: effort === "unset" ? "unset" : parseEffortTargetArg(effort),
  }));
}

export async function setSelectionMode(
  mode: string,
  options: { category?: string },
  expectRevision: string,
): Promise<void> {
  if (mode !== "spread" && mode !== "strict" && mode !== "unset") {
    throw new Error(
      `selection mode must be spread, strict, or unset; got ${JSON.stringify(mode)}`,
    );
  }
  printPolicy(await applyPolicyMutation(requireDaemonPort(), {
    op: "set-selection",
    expectedRevision: parseExpectedRevision(expectRevision),
    ...(options.category === undefined ? {} : { category: parseCategory(options.category) }),
    mode,
  }));
}

export async function setCategoryChain(
  category: string,
  entries: string[],
  expectRevision: string,
): Promise<void> {
  printPolicy(await applyPolicyMutation(requireDaemonPort(), {
    op: "set-chain",
    expectedRevision: parseExpectedRevision(expectRevision),
    category: parseCategory(category),
    entries: entries.map(parseChainEntryArg),
  }));
}
