---
name: hive-versioning
description: Hive's versioning, release, and update contract. Use before changing any version string, the release workflow, src/version.ts, src/release/*, src/update/*, install.sh, or anything that touches the daemon handshake's build hash — and before adding a version number anywhere.
---

# Hive versioning contract

Read [docs/versioning-and-release.md](../../../docs/versioning-and-release.md) before changing anything this skill covers. It is the owning document; this skill is the short form of its rules, and the rules are enforced by `src/release/contract.test.ts`, not by anyone remembering them.

## The rules

**Never write a version number.** `src/version.ts` is the only module allowed to name one, and it names `0.0.0-dev` as a fallback. Everything else imports `HIVE_VERSION`. `package.json` stays at `0.0.0`. Releases are git tags; a version committed to a file is a second source of truth that drifts. This is not hypothetical — four copies of `"0.1.0"` drifted apart across the daemon, the three MCP clients, the channel bridge, and the Codex handshake before this rule existed.

**The version is derived, never chosen.** One push to `main` publishes one release, one patch above the last, regardless of how many commits the push carries. A commit that already carries a release tag is never released again. Both rules live in `planRelease()` in `src/release/plan.ts` — a pure function under test. If you need to change how the version is computed, change that function; do not add shell to the workflow. `contract.test.ts` fails if you do.

**Hive is `0.0.x`, patch-only.** A tag outside the series is a contract violation and `planRelease` throws on it. Going to `0.1.0` is a deliberate edit to `plan.ts` and to `docs/versioning-and-release.md`, in the same change, with the reasoning written down.

**The build hash is not the version.** It content-addresses the build's *inputs*. A rebuilt `0.0.7` with different code is a different daemon and must be rejected by the handshake. Never compare product versions where a build hash is meant, and never derive the hash from the compiled output — the output embeds it.

**Never fake "up to date".** A failed update check returns `unavailable` with a reason. A stale cache saying "you are current" is downgraded to "could not check", because "nothing was newer yesterday" is not evidence about today. Only a successful check, or a fresh cache, may say the user is current.

**Never launch a dev build from `hive`.** Bare `hive` opens the installed release Workspace or refuses. No symlink into `workspace/.build`, no `swift run`, no environment escape hatch.

**Respect the install's owner.** Hive rewrites only installs its own installer created. Homebrew installs are told `brew upgrade hive`. Unrecognized locations are refused, never guessed at.

**Never kill a daemon you have not proven is yours and idle.** `handshakeMismatch` reports the *first* differing field, and product version sorts before project identity — so acting on that string alone can kill another project's daemon. Compare `hiveUuid` first, explicitly. An unreadable agent list means the team is live, not idle.

**Signature verification fails closed.** Once a release public key is embedded, a missing signature is a refusal, never a downgrade to "unsigned is fine".

## Before you finish

- `bun run typecheck && bun test` — `contract.test.ts` is the enforcement; if it goes red you broke a rule above, not the test.
- Changed a decision? Update `docs/versioning-and-release.md` in the same turn, per the `karpathy-docs` skill: the old choice becomes a rejected alternative with why it lost.
