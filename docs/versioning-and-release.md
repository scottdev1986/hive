# Versioning, release, and update

Hive's version is a fact about what a user is running, not a label someone remembers to change. One push to `main` publishes exactly one release, one patch above the last, and that release is the only thing `hive`, `hive start`, and `hive update` ever talk about. Nobody types a version number, and no commit contains one.

This document owns the versioning contract. [distribution-auto-update.md](../research/distribution-auto-update.md) owns *how* releases reach machines; [update-experience.md](../research/update-experience.md) owns *what the user sees*. Where this document and those disagree, this one is the implementation and they are the design; fix whichever is wrong.

## The contract

Hive is `0.0.x`. Patch-only. The first release is `0.0.1`.

One push to `main` bumps the patch by exactly one. A push carrying a hundred local commits is still one push, so it is still one release — the bump is a function of the tip commit and the existing tags, never of how many commits arrived. The GitHub `push` event fires once per push, so nothing needs to deduplicate anything.

A commit that already carries a release tag is never released again. That single rule is what makes the pipeline idempotent: re-running the workflow, re-triggering it by hand, or force-pushing a tip that is already tagged all resolve to "nothing to do". The tag push itself is a compare-and-swap — `git push` of a ref that exists fails — so two concurrent runs can never both mint `v0.0.7`.

Everything above lives in `src/release/plan.ts` as a pure function, is tested in `plan.test.ts`, and is called by CI through `plan-cli.ts`. The rule is not written in YAML, where nothing could test it. `contract.test.ts` fails the build if the workflow stops calling the planner, if the bump is reimplemented in shell, if `package.json` starts carrying a release version, or if any module declares a version string of its own. The contract is enforced by the automation, not by memory — which is the point, because memory is exactly what failed when four copies of `"0.1.0"` drifted apart across the daemon, the MCP clients, the channel bridge, and the Codex handshake.

Staying patch-only is a deliberate refusal to decide something we cannot yet decide. We are a long way from knowing what a minor bump would mean for Hive, and a scheme with one moving part cannot drift. The alternative was conventional commits — read intent from commit messages, bump minor on `feat:`. It loses because it makes the version a function of prose nobody proofreads, and it mints `0.1.0` the first time someone types the wrong prefix. A version tag outside `v0.0.x` is therefore not noise to skip but a contract violation: `planRelease` throws rather than mint `v0.0.8` *behind* a stray `v0.1.0` and hand two builds a descending version order. When Hive is ready for `0.1.0`, that is a deliberate edit to this document and to `plan.ts`, together.

## What a version is

`src/version.ts` is the only module that names a version, and it names it exactly once. `bun build --compile --define 'process.env.HIVE_BUILD_VERSION="0.0.7"'` rewrites that expression into a string literal before the bundle is written, so a release binary cannot be relabelled by exporting an environment variable at it. Running from a checkout leaves the defines unset and the module falls back to `0.0.0-dev`, which never claims a release version, never nags about updates, and refuses to self-update.

Five constants ride along: the semver, the short commit, the build date, the content-addressed build hash, and the release public key. Two of them are load-bearing.

**The build hash** is what the daemon presents in its handshake, and it is a content address of the build's *inputs* — source tree, version, commit, target triple — not of its output. It cannot be a hash of the output, because the output embeds the hash. Addressing the inputs preserves the only property that matters: two different releases always disagree, and a rebuild of one release always agrees with itself. A release binary carries the hash inlined; a checkout hashes the source tree it is actually executing, which is what makes edit-and-rerun reject the daemon still running pre-edit code. This is deliberately not the marketing version: a rebuilt `0.0.7` with different code is a different daemon, and a version-only check would silently adopt it.

**The release public key** is absent until an offline Ed25519 key exists. Its absence is not a silent downgrade. `hive update` verifies every artifact's SHA-256 against the release manifest and then says out loud that the manifest carries no Hive signature, so the trust anchor is GitHub's immutable release plus TLS. The moment a key is embedded, `verifyManifest` becomes mandatory and fail-closed — a stripped signature is a refusal, not a downgrade — with no other code change. That is why the signature field exists before the key does.

## The pipeline

`.github/workflows/release.yml`, on push to `main`, serialized by a concurrency group so two pushes cannot race:

1. Typecheck and test. Nothing is released from a red tree.
2. Plan: `plan-cli.ts` reads the tags and the tip's tags, and prints `{action, version, tag}`.
3. Build, if the action is `release`: two Bun-compiled CLI slices (`darwin-arm64`, `darwin-x64`, cross-compiled from one macOS runner) and one universal Workspace application built with `swift build -c release --arch arm64 --arch x86_64`. The universal bundle is duplicated across both manifest entries rather than sliced, because a 3 MB duplicate is cheaper than a second bundle to sign and notarize.
4. Prove the built binary reports its own version.
5. Tag, then publish the GitHub Release with both binaries, the app tarball, and `hive-release.json`.

Building *before* tagging is the interesting ordering. A failed build must not burn a version number, so the tag is minted only once there are artifacts to attach to it. The cost is that two racing runs may both build and only one may tag; a wasted build is cheaper than a gap in the series.

`hive-release.json` is the manifest: version, commit, channel, `securityCritical`, wire-protocol and schema ranges, and for each artifact a name, size, SHA-256, and build hash. It is the one document the updater trusts. Apple's Developer ID signature would authenticate the executable to macOS; the manifest signature authenticates *update policy* to Hive — which version is current, which bytes are it, whether it is urgent. A notarized binary served from the wrong manifest is still the wrong update, so neither signature substitutes for the other.

## Install, update, launch

`~/.local/share/hive/versions/<version>/` holds an immutable tree per release: the `hive` binary and `HiveWorkspace.app` together, so the CLI and the app can never skew. `current` is a symlink at one of them and `~/.local/bin/hive` points at `current/hive` forever. Activation is one `rename(2)` over `current`, which is atomic, so there is no instant at which `current` names a half-installed tree.

`hive update` always does the safe half immediately — check, download, verify the digest, run the candidate binary and make it say its own version, stage it — and then tells the truth about activation. It activates only when the daemon is provably idle. There is no `--now` flag that forces activation over a live team: the daemon owns landing authority and approvals, so "force" would mean killing agents mid-write, and a user who genuinely wants that has an honest spelling already in `hive stop && hive update`. Making destruction a deliberate two-command act rather than a flag is the point. After activation, the health check runs; if the new binary cannot say its own name, `current` goes back and the failed version stays on disk for diagnosis. None of rustup, Deno, Bun, or Claude Code does a post-activation revert — they verify before activating and leave recovery to an explicit reinstall. Hive can go further because the thing it activates has a health check, and because a broken control plane strands a team rather than merely failing a command.

Ownership decides who may write. A Homebrew-owned install is told `brew upgrade hive` and is never rewritten, because two owners for one install is how a package receipt starts lying; Codex does the same thing, dispatching to the package manager that installed it. A binary sitting somewhere Hive did not put it is `unmanaged` and refused rather than guessed at. A source checkout is a source checkout wherever it sits, including inside the install root.

The daemon is the reason activation is not a file copy. A Unix process keeps executing its already-open image after the symlink moves, so after an update the old daemon is still serving, still presenting the old build hash. The handshake refuses to adopt it — that is detection, and detection alone is a dead end, leaving the user with a new `hive` that will not speak to the daemon it just updated past. So `hive update` and `hive start` both close the loop: they stop a daemon that is provably *ours* (same `HiveUUID`) and provably *idle* (no live agents), and the next start spawns the new binary. Three distinctions do all the work here, and conflating any two is a bug:

- **stale** — same project, different build. Ours to restart.
- **foreign** — a different project's daemon on our port. Never ours to kill.
- **busy** — stale, but a team is live. Ours to leave alone until quiescence.

`handshakeMismatch` reports only the first field that differs, in an order that puts product version ahead of project identity. Trusting that string alone would let a version bump masquerade as permission to kill a stranger's daemon, so identity is compared first and explicitly. An agent list that cannot be read is treated as a live team, not an idle one: refusing to activate costs a retry, and guessing costs an agent mid-write.

`hive` with no arguments opens the installed release Workspace. There is deliberately no development fallback — no symlink into `workspace/.build`, no `swift run`, no environment variable that quietly prefers a debug bundle. A `hive` that sometimes launches a debug build is a `hive` whose bug reports cannot be trusted, and the one thing worse than "Workspace is not installed" is "Workspace launched, and nobody can say which one".

`hive start` checks for updates and prints one line before doing anything else. It is the session boundary, and the last moment Hive owns the terminal. The check is best-effort and never blocks: a machine with no network prints `could not check for updates (…)` and starts anyway. It never prints "up to date" on a failed check, because that sentence is a claim about the world and we would not have looked. A cached answer is still evidence — we observed that version exist — so an offline machine keeps telling the truth it last learned. But a stale cache saying "you are current" is downgraded to "could not check", because "nothing was newer yesterday" is not evidence that nothing is newer today.

## What Scott still has to do

The pipeline runs on `GITHUB_TOKEN` alone and needs no repository secret to publish its first release. Four things are not automatable, and three of them are gaps a user can feel.

**Verify workflow write permissions.** The repository default for `GITHUB_TOKEN` is read-only. The workflow raises itself to `contents: write`, which is permitted — a workflow may exceed the default, though not what the token can be granted. If the first run fails with a 403 on the tag push, flip Settings → Actions → General → Workflow permissions to "Read and write".

**Apple Developer ID and notarization.** The artifacts are currently unsigned and un-notarized, so macOS quarantines them on first run and the user must clear Gatekeeper by hand. This is the largest gap. It needs a Developer ID Application certificate in CI, a hardened-runtime entitlement set *proved* to pass notarization on a real compiled Bun binary (Bun's JavaScriptCore may require JIT and library-validation entitlements, which is an unverified risk, not a formality), `notarytool` submission, and Gatekeeper verification on a clean account.

**The offline Ed25519 release key.** Generate it off-CI, keep the private half offline, sign `hive-release.json` in the release job, publish `hive-release.json.sig`, and pass the public half to `build.ts --public-key`. Verification is already written and already fails closed; it is inert only because no key exists. Until then `hive update` prints an unsigned-release warning on every update, which is the honest thing to print and not a thing to leave printing for long.

**A `hive` Homebrew tap**, if the secondary channel is wanted. Hive already detects a Homebrew-owned install and refuses to rewrite it; nothing else is built.

## Open questions

**Who checks in the background.** [update-experience.md](../research/update-experience.md) argues the daemon should own checking on a jittered ~24-hour timer while the CLI owns telling, which is Hive's structural advantage over `gh` and `npm`: checks happen every 24 hours of use rather than once per invocation burst. Today the check runs in `hive start` against a 24-hour cache, and `checkForUpdate` is written so the daemon can call it unchanged. Until it does, a long-running daemon learns about a release only when someone types `hive start`. The passive one-line notice on `hive status`, `hive claude`, and the rest is built and tested but wired to nothing.

**Automatic activation at quiescence.** A staged update currently waits for a human to run `hive update` again. The design says the daemon should activate it itself when the team drains. That needs a daemon-side quiescence hook, and it is the difference between "updates happen while you use the tool" and "updates happen when you ask twice".

**Where the channel document lives.** The updater reads GitHub's `releases/latest`, which the distribution research explicitly argues against: channel and rollout policy should come from a small signed document on a CDN, not be inferred from a mutable API. `src/update/source.ts` is the seam, and swapping it changes that file and nothing else. This is a deviation taken knowingly to ship, not a decision.

**How a release earns the `securityCritical` flag.** The flag overrides every notice rate limit and the skip list on every install; today it is read out of the release notes and is one person's judgment. Whether that should require a second approver or a linked advisory is a process question, still open, and owned by [update-experience.md](../research/update-experience.md).
