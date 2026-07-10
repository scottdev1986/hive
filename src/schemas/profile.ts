import { z } from "zod";

// The repo profile is Hive's portability seam (SPEC.md decision 14): a single
// committed `.hive/profile.toml` that records this repo's doc names, commands,
// and shape, so every mechanism that assumed the hive repo's own layout reads a
// per-repo answer instead of a hardcoded guess. It is *structured* truth read
// deterministically by product code — never parsed out of prose, never a memory
// fact (decision 5's boundary: memory holds narrative truth, the profile holds
// structured truth, and neither stores the other's).
export const PROFILE_SCHEMA_VERSION = 1;

// The briefable doc set and which doc earns the bare-name `§`-selector rule that
// `brief.ts` used to hardcode for "SPEC". `primary` is null when the repo has no
// single most-cited design doc — the special case simply drops away.
export const ProfileDocsSchema = z.object({
  briefable: z.array(z.string()),
  briefableDirectories: z.array(z.string()),
  primary: z.string().nullable(),
});
export type ProfileDocs = z.infer<typeof ProfileDocsSchema>;

// The concrete commands the landing gate, tier router, and `hive init` need in
// an arbitrary repo. Any command Hive could not discover is null (its TOML key
// is omitted), never an invented default — an unknown command is unknown.
export const ProfileCommandsSchema = z.object({
  build: z.string().nullable(),
  test: z.string().nullable(),
  typecheck: z.string().nullable(),
  lint: z.string().nullable(),
  run: z.string().nullable(),
});
export type ProfileCommands = z.infer<typeof ProfileCommandsSchema>;

// A pointer to conventions, not the conventions themselves: those live in the
// repo's `AGENTS.md`/`CLAUDE.md`, loaded natively by the vendor (decision 5).
// The profile records only *that* such a file exists and where, plus the cheap
// language/package-manager/monorepo facts, so it never duplicates them.
export const ProfileConventionsSchema = z.object({
  agentsFile: z.string().nullable(),
  language: z.string().nullable(),
  packageManager: z.string().nullable(),
  monorepo: z.boolean(),
});
export type ProfileConventions = z.infer<typeof ProfileConventionsSchema>;

// aider's `--map-tokens` made explicit and scaled to the repo: a 200-file repo
// and a 20k-file monorepo cannot share one index budget or the big repo drowns
// every context it touches. `fileCount` is the size signal; `mapTokens` the
// derived cap. This is distinct from decision 5's memory-index cap, which is
// driven by fact count, not repo size.
export const ProfileIndexBudgetSchema = z.object({
  fileCount: z.number().int().nonnegative(),
  mapTokens: z.number().int().positive(),
});
export type ProfileIndexBudget = z.infer<typeof ProfileIndexBudgetSchema>;

// The cheap staleness signal recomputed every start (SPEC §14): a hash over the
// profile's declared inputs plus the commit and date that produced it. A match
// means fresh and start proceeds in silence; a mismatch means the tree drifted,
// and `commit` lets Hive report *how many commits* stale without re-profiling.
export const ProfileFingerprintSchema = z.object({
  generated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "generated must be YYYY-MM-DD"),
  hiveVersion: z.string(),
  commit: z.string().nullable(),
  inputsHash: z.string(),
});
export type ProfileFingerprint = z.infer<typeof ProfileFingerprintSchema>;

export const RepoProfileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  docs: ProfileDocsSchema,
  commands: ProfileCommandsSchema,
  conventions: ProfileConventionsSchema,
  entryPoints: z.array(z.string()),
  indexBudget: ProfileIndexBudgetSchema,
  fingerprint: ProfileFingerprintSchema,
});
export type RepoProfile = z.infer<typeof RepoProfileSchema>;
