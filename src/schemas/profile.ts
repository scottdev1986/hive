import { z } from "zod";

// The repo profile is Hive's portability seam (SPEC.md decision 14): the doc
// names, commands, and shape of *this* repo, so every mechanism that would
// otherwise assume hive's own layout reads a per-repo answer instead of a
// hardcoded guess. It is *structured* truth read deterministically by product
// code — never parsed out of prose, never a memory fact (decision 5's boundary:
// memory holds narrative truth, the profile holds structured truth, and neither
// stores the other's).
//
// The profile is *derived*, not authored. Everything below is recoverable from
// the tree in tens of milliseconds with zero model tokens, which is why it lives
// in Hive's own per-project state directory rather than in the repo: it is a
// cache, and a cache that a human must maintain is not a cache. The one part a
// human *does* own is the override (bottom of this file), which is committed.
export const PROFILE_SCHEMA_VERSION = 2;

// The briefable doc set and which doc earns the bare-name `§`-selector rule that
// `brief.ts` used to hardcode for "SPEC". `primary` is null when the repo has no
// single most-cited design doc — the special case simply drops away.
export const ProfileDocsSchema = z.object({
  briefable: z.array(z.string()),
  briefableDirectories: z.array(z.string()),
  primary: z.string().nullable(),
});
export type ProfileDocs = z.infer<typeof ProfileDocsSchema>;

// The concrete commands the landing gate, category router, and `hive init` need in
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

// The staleness signal, recomputed on every start (SPEC §14): a hash over the
// inputs that actually *determine* the profile — the doc inventory, the
// manifests, the lockfiles, the file count. A mismatch means the profile is
// genuinely wrong, so Hive regenerates it in place and says nothing.
//
// It deliberately does *not* hash the Git tree. It used to, and that single line
// made every commit to any file in the repo — a test fixture, a typo in a
// comment — mark the profile stale, which is how a profile whose every derived
// field was still correct came to nag the user to refresh it by hand.
export const ProfileFingerprintSchema = z.object({
  generated: z.iso.date(),
  hiveVersion: z.string(),
  commit: z.string().nullable(),
  inputsHash: z.string(),
});
export type ProfileFingerprint = z.infer<typeof ProfileFingerprintSchema>;

// Everything below is read by product code. That is the whole membership rule,
// and it is load-bearing: the profile used to also carry an `index_budget` — a
// repo file count and a derived `map_tokens` cap, aider's `--map-tokens`
// analogue — that nothing ever read. A cached number nobody consumes is not free.
// It went stale on every commit that added a file, which invalidated the cache
// and, back when staleness was something a human was told about, was one of the
// things that told them. A field with no reader can only cost.
export const RepoProfileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  docs: ProfileDocsSchema,
  commands: ProfileCommandsSchema,
  conventions: ProfileConventionsSchema,
  entryPoints: z.array(z.string()),
  fingerprint: ProfileFingerprintSchema,
});
export type RepoProfile = z.infer<typeof RepoProfileSchema>;

// ---------------------------------------------------------------------------
// The override — the only half of the profile a human owns.
//
// Detection is a heuristic, and a heuristic is sometimes wrong: a repo whose
// real test command is `make test-ci` will be read as `npm test` forever, and
// before this file there was nowhere to say otherwise that a regeneration would
// not erase. So the derived profile is a cache Hive rewrites at will, and
// `.hive/profile.override.toml` is a small, committed, hand-edited file that
// layers over it and is never written by Hive.
//
// It is committed on purpose, and it is the *only* part of the profile that
// should be: a correction is a team fact — the whole team's agents were reading
// the wrong test command — while everything it corrects is a derivation any
// clone reproduces in milliseconds. Absent file means no override; every field
// is optional, and an absent field means "your detection was right".
// ---------------------------------------------------------------------------

export const ProfileOverrideSchema = z.object({
  commands: z.object({
    build: z.string().optional(),
    test: z.string().optional(),
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    run: z.string().optional(),
  }).default({}),
  docs: z.object({
    /** Force the primary design doc when inbound-link ranking picks wrong. */
    primary: z.string().optional(),
    /** Docs to add to the briefable allowlist that the scan did not find. */
    briefableAdd: z.array(z.string()).default([]),
  }).default({ briefableAdd: [] }),
});
export type ProfileOverride = z.infer<typeof ProfileOverrideSchema>;
