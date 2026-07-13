# Distribution

Updated: 2026-07-13
Sources: Hive source tree, 2026-07-13; research/distribution-auto-update.md (2026-07-10, largely superseded)

## Summary

Why Hive ships a signed native installer rather than npm, Homebrew, or Sparkle — and what the shipped installer honestly does not do. The mechanism (versioning, signing, activation) is owned by [versioning-and-release.md](versioning-and-release.md), which is authoritative where this article and it disagree; what survives here is the *survey* and the *reasoning*, which the code cannot express.

## The one thing code cites this document for

`src/update/source.ts:4-8` and `src/update/check.ts:102-108` both cite the distribution research by name as the recorded rationale for a knowing deviation, and this article inherits that role. The deviation:

> GitHub Releases should hold immutable bytes; a small CDN-backed endpoint should express mutable channel and rollout policy. Do not make every client scrape the GitHub "latest" API or trust a moving asset without a signed policy document.

**The shipped updater does exactly what that sentence forbids.** It reads `releases/latest` and the `hive-release.json` asset attached to it (`update/source.ts:105-154`, `update/check.ts:102-142`). There is no channel endpoint. The choice was between a knowing deviation and no updater at all, and it is confined to `src/update/source.ts`, which exists as the seam — introducing the channel document changes that file and nothing else.

The deviation is **recorded, not rationalized**. Until it closes: channel and rollout policy are inferred from a mutable API, and the manifest's `channel` field is written but never read. What stands between a compromised release and an installed Hive is TLS, GitHub's immutable-release guarantee, and — since 0.0.6 — the Ed25519 manifest signature that the research doc argued for and that now exists. The signature is the part that closed; the channel document is the part that did not.

## What the installer actually verifies — and does not

`install.sh` downloads a published release, checks every artifact's SHA-256 against the release manifest, proves the binary runs, and only then points `~/.local/bin/hive` at it. **That is the whole of its verification** (`install.sh:73-118`).

The design called for the installer to verify the manifest signature, the Developer ID signature, and the Team ID. **It does none of those.** The script says so itself (`install.sh:77-79`): the manifest is served over TLS from an immutable release, and "when a Hive release key exists, `hive update` additionally verifies its Ed25519 signature." So the first install is anchored on TLS + GitHub immutability + SHA-256 against an *unverified* manifest; every subsequent update through `hive update` is anchored on the embedded key and is fail-closed. **This is a real gap, not a rounding error**: an attacker who can serve a forged manifest *and* the matching bytes defeats the installer, because the digest it checks comes from the same document it did not authenticate.

The reason it has not been closed is the one the research doc gave: portable POSIX shell cannot reliably verify Ed25519 on every supported macOS. The stated options are a tiny notarized installer binary, or a pinned Apple-native signature check plus a SHA from a versioned HTTPS script. Neither is built. `curl | sh` is convenient, not a trust argument; the script is short enough to audit, which is the only reason it is acceptable at all.

## Claims from the design that were never implemented

Recorded so nobody re-derives them from the research doc as though they were behavior:

- **Manifest fields** "artifact URL, supported macOS, minimum updater version, rollout percentage" — absent. The real field list is `release/manifest.ts:49-75`.
- **The health check** was specified to open the database read/write, bind the MCP endpoint, and perform a no-op transaction, keeping a DB snapshot and a grace period. It is `hive --version`, checked for the string `hive` (`cli/update.ts:87-92`). Retention is three version directories (`update/install.ts:408-468`), not a database snapshot.
- **An external updater helper** asking the old daemon to "prepare for update" (checkpoint WAL, record state, close listeners, exit) — not built. A stale, provably idle daemon is simply SIGTERM'd and waited on (`update/daemon.ts:150-199`).
- **Background fetch and stage, jittered background checks, and a deterministic 5% → 25% → 100% rollout** keyed on an anonymous install ID — none built. There is one ring.
- **Homebrew tap formula updates from release CI** — not built. Hive detects a Homebrew-owned install and refuses to rewrite it; that is all.
- **A LaunchAgent for dormant machines** — deliberately out. The promise is Claude Code's promise: updates happen while you use the tool. SPEC's "launchd is v2 polish" line stays true.

## Why a native installer, measured against four precedents

**rustup.** Bootstraps with `curl … | sh`, installs one binary, exposes `rustup self update`; `enable`/`disable`/`check-only`. Self-update downloads a new `rustup-init`, runs it in self-upgrade mode, then copies and hard-links tools into place. Separate production and beta update roots function as two channels. **Rollback means explicitly installing an older known version — there is no automatic post-activation health rollback.** Bootstrap-plus-in-binary-update is mature; it does not solve Hive's running-daemon problem.

**Deno.** Shell installer, `deno upgrade`, channels (`stable`, `alpha`, `beta`, `rc`, `canary`) and exact versions. Caches downloads, **verifies published SHA-256, verifies both delta patches and their resulting binaries**, falls back from a failed delta to a full archive, and **runs a downloaded binary before replacing the current executable**. Its update check is delayed 500 ms so it can never affect startup. Rollback is `deno upgrade <older>`; no retained last-known-good. Lesson taken: verify the artifact and smoke-test before activation; treat delta delivery as later polish.

**Bun.** Shell installer, `bun upgrade`, stable/canary. Downloads into a temporary version directory, **executes the candidate with `--version`/`--revision` and compares against the expected version**, and only then moves it over the running executable. On Unix it preserves no automatic last-known-good sibling. **It tells Homebrew users to run `brew upgrade bun` instead of self-updating** — the ownership rule, verified. Hive's staged-binary probe is directly this.

**Claude Code.** The strongest model. Native installer recommended; exact version or `latest`/`stable`; checks at startup and periodically; installs in the background; activates on next start. Retains binaries under **`~/.local/share/claude/versions/VERSION`** with `~/.local/bin/claude` in front — which is exactly Hive's layout. Each release has a **SHA-256 manifest signed by Anthropic's GPG key**, and its macOS binaries are Developer ID signed and notarized. `stable` is ≈ one week behind and skips releases with major regressions. And the warning: **[issue #24117](https://github.com/anthropics/claude-code/issues/24117)** — a real 2026 packaging bug left downloaded versions present while **the active symlink still targeted an old release**. Versioned activation is recoverable, but it is not magically correct; that bug is why Hive's installer re-reads the link and re-resolves `current` after the rename (`install.sh:100-108`) and why `contract.test.ts:133-170` proves `mv -fh` against the live filesystem.

**None of the four provides a documented transactional rollback after a newly activated binary starts and fails.** They provide pre-activation verification and an explicit old-version path. Hive goes one step further — health check with automatic revert — because it has a daemon that can be health-checked and durable state that a broken control plane strands.

## Why registry-global (npm/Bun) loses

Good notification quality; poor automatic-update quality. The notifier cannot reliably *apply* an update: the global prefix may not be writable; the install may be owned by npm, Bun, nvm, mise, Volta, or a system Node; lifecycle scripts may be disabled; and **modifying the native binary behind the package manager makes its receipt lie**. npm needs a dedicated EACCES recovery guide and recommends a version manager or a user-owned prefix. Bun's global default is user-owned but is a different directory and package database, and it does not run lifecycle scripts unless the package is trusted — supporting both multiplies detection and repair paths.

**`update-notifier` intentionally stopped auto-installing** after automatic mutation proved unpopular. That is the ecosystem's own verdict on this route.

Claude Code makes the weakness concrete: its npm package now installs the same native binary through per-platform optional dependencies, yet the native installer remains recommended, global npm updates can fail when the prefix is not writable, and the documented update command must explicitly request `@latest` because an ordinary global update can respect the old semver range. **Moving the runtime into the package did not give npm native-install update semantics.**

For Hive it would also contradict SPEC's "single binary, no runtime prerequisite" story unless it were a bootstrap wrapper — and a bootstrap wrapper adds a registry supply-chain and lifecycle-script layer without improving the final install.

## Why Homebrew cannot make the promise

Two operations that are easy to conflate. **Homebrew's built-in auto-update refreshes Homebrew and formula *metadata* before selected commands; it does not upgrade installed formulae.** `brew upgrade` does that, and only when a user runs it. The metadata refresh interval is 24 hours — and only when the user invokes a triggering command. `brew livecheck` finds a newer upstream version *for maintainers*; it neither changes the formula nor upgrades a machine.

The separate `brew autoupdate` project can install a launchd job and, with flags, run `brew upgrade`. It requires the user to install and trust an external tap command, opt in, and accept Homebrew-wide behavior — and **it moved out of the Homebrew organization in 2023** to reduce Homebrew's maintenance burden. Its failure modes are the interesting part: a sleeping or offline Mac, stale tap metadata, formula lag after the upstream release, pins and environment opt-outs, bottle gaps, permissions, unrelated dependency upgrades, and **a running daemon the formula knows nothing about.**

Homebrew stays a strong *secondary* route — users trust its receipts, its uninstall model, and its prefix management — and a weak primary answer. Hive detects a Homebrew-owned path and says `brew upgrade hive` rather than rewriting the Cellar (`update/paths.ts:56-79`, `cli/update.ts:96-101`).

## Why Sparkle loses

Sparkle is an excellent macOS *application* updater: appcasts, Ed25519 archive signatures, signed feeds, delta updates, key rotation, installer helpers, a mature consent/relaunch UI. Its entire model is shaped around a Cocoa `.app` or another bundle with an `Info.plist`, a `CFBundleVersion`, an updater object, and helper executables. Tailscale uses it — sensibly, because Tailscale already ships a GUI app and a system extension.

Hive is a CLI and an unprivileged user daemon. Wrapping it in a menu-bar app *solely to gain Sparkle* would import Swift/Xcode build infrastructure, an app lifecycle, helper signing, App Management permissions, and a second control plane. There is no macOS framework that makes a bare CLI daemon update sane for free. A LaunchAgent can *schedule* Hive's own updater, but scheduling is not an update framework. Sparkle becomes reasonable only if Hive later wants a real menu-bar supervisor.

## A daemon restart is a product event

The desktop precedents agree, and this is why activation is gated on quiescence rather than treated as a file copy.

**Docker.** Desktop checks automatically, can download in the background, and rolls out gradually — but full Desktop updates remain **restart-oriented**; only components like Compose, Scout, and the CLI update independently. Docker Engine's **`live-restore` preserves containers across *some patch* daemon upgrades — but not major upgrades, not skipped releases, and not incompatible daemon configuration**, and management is unavailable while the daemon is down. The most permissive live-upgrade mechanism in the field explicitly does not cover the case that matters.

**Tailscale.** Stages stable client updates for roughly a week, schedules them around node activity, and **accelerates critical security releases**. Managed macOS package upgrades require an explicit `down-for-update` before replacement and a post-install restart.

**OrbStack.** Owns both the app and its bundled CLIs, linking them from an app-managed directory. Evidence for single-owner bundling; *not* evidence that daemon restarts are safe — its docs specify no no-interruption contract.

The consequence for Hive is the one the code implements: a Unix process keeps executing its already-open image after a symlink changes, so atomic activation does **not** update a running daemon. Download and signed staging are safe while teams run; activation is a separate machine-wide event under the mutation lease and refuses until every instance is observable and idle; restarting a stale daemon is a third event. The handshake refuses to attach a new CLI to an old build. The all-instance gate is in `src/cli/update.ts:281-367`; the stale/foreign/busy triage and restart path are in [versioning-and-release.md](versioning-and-release.md); what restart must not corrupt is in [Database resilience](../daemon/database-resilience.md).

Two further rules from the design still stand as intent even though nothing enforces them yet. **Database migrations must follow expand/contract**: an automatically activated release may add compatible tables, columns, or indexes, but must not destroy state the previous binary needs for rollback; destructive migrations wait for a later release or an explicit user-confirmed upgrade. And **agent hooks are another client**: a live team should keep using the session's recorded executable path rather than whatever `hive` resolves to on `PATH`, so a team has one control-plane version from birth to quiescence.

## The trust burden

The honest risk in choosing a native installer is **supply-chain concentration**: compromise of Hive's update signing process reaches every opted-in installation faster than a compromised manual channel would. The mitigation list, in the order it was argued:

- an **offline** manifest key (private half never in the repo, only a CI secret, touching exactly one script);
- a protected Apple signing identity;
- two-person release approval;
- immutable releases and provenance attestations;
- deterministic/staged rollout;
- an emergency channel freeze;
- user-visible logs;
- a hard disable switch (`HIVE_DISABLE_UPDATES=1`, which blocks even manual updates).

Of these, the offline key, the protected identity, immutable releases, and the disable switch exist. Two-person approval, staged rollout, and a channel freeze do not — the last two both wait on the channel document.

**Automatic delivery should be the default; invisible, unaccountable mutation should not be.** That sentence is the whole argument for why the notice names its three checks and why `hive update` never activates over a live team.

## See Also

- [versioning-and-release.md](versioning-and-release.md) — the contract, the pipeline, signing, and activation; authoritative on conflict
- [update-experience.md](update-experience.md) — the notice, the commands, and the ecosystem notice survey
- [../daemon/database-resilience.md](../daemon/database-resilience.md) — the state a daemon restart at activation must preserve
- [../../SPEC.md](../../SPEC.md) — single binary, no runtime prerequisite; launchd deferred
