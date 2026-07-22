// Cross-project pitfall promotion (HiveMemory plan D3, board #71/#119 §5):
// the ONLY way memory crosses a project boundary. A human/queen-approved copy
// of a generalized REPO-scope pitfall lands in the GLOBAL wiki as a new
// article with `origin_project` provenance. Facts and raw events are never
// promoted, no scope is ever shared, and the copy happens only after a
// redaction check — a repo-scope article is written for one project's eyes
// and routinely carries paths, hostnames, and tokens that must not leak into
// the scope every project reads.
import type { MemoryFact } from "../schemas";

export interface PromotionFinding {
  kind:
    | "repo-path"
    | "home-path"
    | "absolute-path"
    | "hostname"
    | "token-like";
  /** The offending text, verbatim, so the operator can find and edit it. */
  match: string;
}

// Private/LAN hostnames are what leaks a home or office network layout;
// public domains in prose (github.com and the like) are not a leak.
const HOSTNAME_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:local|lan|internal|intranet|corp|home|localdomain)\b/gi;

// macOS and Linux home-directory shapes. The caller's own repo root and home
// directory are checked separately (exact-string), because a pitfall written
// in this repo cites this repo's layout constantly.
const ABSOLUTE_PATH_PATTERN = /\/(?:Users|home)\/[^\s)"'\]`]+/g;

const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  // Long hex runs: API keys, webhook secrets, commit-pinned tokens.
  /\b[0-9a-f]{32,}\b/gi,
  // Long base64 runs: bearer tokens, encoded keys.
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
  // The vendor prefixes everybody recognizes on sight.
  /\b(?:sk|ghp|gho|ghu|ghs|ghr|xox[bpoas]|glpat)-[A-Za-z0-9_-]{12,}\b/g,
  // An inline bearer header is a credential wherever it appears.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
];

/**
 * Scan a candidate pitfall body for content that must not cross into the
 * global scope. Returns every finding (deduplicated by kind+match); an empty
 * list is the only pass. This is a gate for a human-operated tool, not a
 * guarantee — it exists to catch the leaks that are mechanical to detect.
 */
export function scanPromotionRedaction(
  body: string,
  context: { repoRoot: string; home: string },
): PromotionFinding[] {
  const findings: PromotionFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: PromotionFinding["kind"], match: string): void => {
    const key = `${kind}:${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ kind, match });
  };

  if (context.repoRoot.length > 1 && body.includes(context.repoRoot)) {
    add("repo-path", context.repoRoot);
  }
  if (context.home.length > 1 && body.includes(context.home)) {
    add("home-path", context.home);
  }
  for (const match of body.match(ABSOLUTE_PATH_PATTERN) ?? []) {
    add("absolute-path", match);
  }
  for (const match of body.match(HOSTNAME_PATTERN) ?? []) {
    add("hostname", match);
  }
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of body.match(pattern) ?? []) {
      add("token-like", match);
    }
  }
  return findings;
}

/**
 * The `origin_project` provenance block appended to the promoted copy's body
 * (D3: project hiveUuid + original repo-scope id + promotion date), so a
 * global article always names the project and article it was generalized
 * from.
 */
export function promotionProvenanceBlock(
  origin: { hiveUuid: string; id: string; date: string },
): string {
  return [
    "",
    "## Origin",
    "",
    `Promoted to global scope from project ${origin.hiveUuid}, repo-scope ` +
    `article \`${origin.id}\`, on ${origin.date}.`,
  ].join("\n");
}

/** The writer-schema source for the promoted copy: the wiki's source enum
 * admits "legacy", the write path's does not, so a legacy-sourced original
 * promotes as a human-curated copy. */
export function promotionSource(
  fact: MemoryFact,
): "init" | "agent" | "orchestrator" | "human" {
  return fact.source === "legacy" ? "human" : fact.source;
}
