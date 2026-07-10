# Versioning, release, and update

Hive's version is a fact about what a user is running, not a label someone remembers to change. One push to `main` publishes exactly one release, one patch above the last, and that release is the only thing `hive`, `hive init`, and `hive update` ever talk about. Nobody types a version number, and no commit contains one.

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
4. Sign, if a Developer ID certificate is configured: a Developer ID Application signature with the hardened runtime and a secure timestamp on both CLI slices and the app, one `notarytool` submission for all three, and a stapled ticket on the app. With no certificate configured the artifacts stay unsigned and the release notes say so. The switch is the presence of the certificate secret, not a flag anyone flips.
5. Prove the built binary reports its own version; sign `hive-release.json` with the offline key if one exists; and verify every signature — `codesign --verify --strict` on everything, `codesign --check-notarization` on the CLI slices, `spctl --assess` and a stapled-ticket check on the app — failing the release on any defect. All of this is *before* the tag, so a signing failure never burns a version.
6. Tag, then publish the GitHub Release with both binaries, the app tarball, `hive-release.json`, and — when a key is configured — `hive-release.json.sig`.

Building *before* tagging is the interesting ordering. A failed build must not burn a version number, so the tag is minted only once there are artifacts to attach to it. The cost is that two racing runs may both build and only one may tag; a wasted build is cheaper than a gap in the series. Signing and its verification sit inside that same before-the-tag window for the same reason: a certificate problem or a notarization rejection must fail the release, not ship a broken signature under a fresh version number.

Two sharp edges of signing a Bun binary were found by testing, not by reading. First, `bun build --compile` writes its own ad-hoc signature, and on Bun ≥ 1.3.12 that signature reserves too little room in the Mach-O for a real one ([oven-sh/bun#29120](https://github.com/oven-sh/bun/issues/29120)); re-signing on top of it produces a truncated signature that fails `codesign --verify --strict` with "main executable failed strict validation". The build sets `BUN_NO_CODESIGN_MACHO_BINARY=1` whenever it is going to sign, which is the only way measured to yield a strict-valid Developer ID signature. Second, a compiled binary embeds JavaScriptCore — a JIT — and the hardened runtime kills a JIT that lacks `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`. Hive grants exactly those two, in `scripts/signing/entitlements.plist`. Bun's own guide prints three more — `disable-library-validation`, `disable-executable-page-protection`, `allow-dyld-environment-variables` — and Hive omits all three: a self-contained binary loads no foreign libraries, needs no `DYLD_*` overrides, and does not need executable-page-protection disabled once JIT is allowed. Each entitlement is attack surface, so the rejected alternative — sign with Bun's full set because it is what the guide shows — trades security for nothing. `scripts/signing/dry-run.sh` proves the choice against a real certificate before CI is trusted, and `sign.test.ts` pins the plist so the proof and the shipped file cannot drift.

Stapling is where the CLI and the app diverge. A notarization ticket staples into a bundle but not into a bare Mach-O — `notarytool` and `stapler` accept only zips, packages, and bundles. So the app carries a stapled ticket and clears Gatekeeper offline, while the CLI slices are notarized inside a zip (which registers their code hash with Apple) and rely on Gatekeeper's online ticket lookup the first time they run. That is Apple's model for command-line tools, honestly documented rather than papered over: a machine that is offline the very first time it runs a freshly downloaded `hive` binary is the one case the ticket cannot cover, and the SHA-256 in the manifest plus the embedded signature are what stand behind it there. The divergence extends to how CI proves notarization: the app is a bundle, so `spctl --assess` renders Gatekeeper's actual verdict on it, but `spctl --assess --type execute` rejects *any* bare Mach-O — Anthropic's and Docker's notarized CLIs included — with "does not seem to be an app", so using it on the CLI slices (the rejected first attempt; it failed a release whose notarization had in fact been accepted) proves nothing. The slices are instead checked with `codesign --check-notarization -R="notarized"`, which resolves the binary's CDHash against Apple's ticket service and does reject a signed-but-unnotarized binary.

`hive-release.json` is the manifest: version, commit, channel, `securityCritical`, wire-protocol and schema ranges, and for each artifact a name, size, SHA-256, and build hash. It is the one document the updater trusts, and the SHA-256 it records is of the final signed, stapled bytes — the exact bytes `hive update` re-hashes on the way in — because signing is done before any digest is taken. Apple's Developer ID signature authenticates the executable to macOS; the manifest signature authenticates *update policy* to Hive — which version is current, which bytes are it, whether it is urgent. A notarized binary served from the wrong manifest is still the wrong update, so neither signature substitutes for the other.

## Install, update, launch

`~/.local/share/hive/versions/<version>/` holds an immutable tree per release: the `hive` binary and `HiveWorkspace.app` together, so the CLI and the app can never skew. `current` is a symlink at one of them and `~/.local/bin/hive` points at `current/hive` forever. Activation is one `rename(2)` over `current`, which is atomic, so there is no instant at which `current` names a half-installed tree.

`hive update` always does the safe half immediately — check, download, verify the digest, run the candidate binary and make it say its own version, stage it — and then tells the truth about activation. It activates only when the daemon is provably idle. There is no `--now` flag that forces activation over a live team: the daemon owns landing authority and approvals, so "force" would mean killing agents mid-write, and a user who genuinely wants that has an honest spelling already in `hive stop && hive update`. Making destruction a deliberate two-command act rather than a flag is the point. After activation, the health check runs; if the new binary cannot say its own name, `current` goes back and the failed version stays on disk for diagnosis. None of rustup, Deno, Bun, or Claude Code does a post-activation revert — they verify before activating and leave recovery to an explicit reinstall. Hive can go further because the thing it activates has a health check, and because a broken control plane strands a team rather than merely failing a command.

Ownership decides who may write. A Homebrew-owned install is told `brew upgrade hive` and is never rewritten, because two owners for one install is how a package receipt starts lying; Codex does the same thing, dispatching to the package manager that installed it. A binary sitting somewhere Hive did not put it is `unmanaged` and refused rather than guessed at. A source checkout is a source checkout wherever it sits, including inside the install root.

The daemon is the reason activation is not a file copy. A Unix process keeps executing its already-open image after the symlink moves, so after an update the old daemon is still serving, still presenting the old build hash. The handshake refuses to adopt it — that is detection, and detection alone is a dead end, leaving the user with a new `hive` that will not speak to the daemon it just updated past. So `hive update` and `hive init` both close the loop: they stop a daemon that is provably *ours* (same `HiveUUID`) and provably *idle* (no live agents), and the next start spawns the new binary. Three distinctions do all the work here, and conflating any two is a bug:

- **stale** — same project, different build. Ours to restart.
- **foreign** — a different project's daemon on our port. Never ours to kill.
- **busy** — stale, but a team is live. Ours to leave alone until quiescence.

`handshakeMismatch` reports only the first field that differs, in an order that puts product version ahead of project identity. Trusting that string alone would let a version bump masquerade as permission to kill a stranger's daemon, so identity is compared first and explicitly. An agent list that cannot be read is treated as a live team, not an idle one: refusing to activate costs a retry, and guessing costs an agent mid-write.

`hive` with no arguments opens the installed release Workspace. There is deliberately no development fallback — no symlink into `workspace/.build`, no `swift run`, no environment variable that quietly prefers a debug bundle. A `hive` that sometimes launches a debug build is a `hive` whose bug reports cannot be trusted, and the one thing worse than "Workspace is not installed" is "Workspace launched, and nobody can say which one".

`hive init` checks for updates and prints one line before doing anything else. It is the session boundary, and the last moment Hive owns the terminal. The check is best-effort and never blocks: a machine with no network prints `could not check for updates (…)` and starts anyway. It never prints "up to date" on a failed check, because that sentence is a claim about the world and we would not have looked. A cached answer is still evidence — we observed that version exist — so an offline machine keeps telling the truth it last learned. But a stale cache saying "you are current" is downgraded to "could not check", because "nothing was newer yesterday" is not evidence that nothing is newer today.

## What Scott still has to do

The pipeline is built and waits on credentials, not code. With no secrets set it publishes the unsigned release it always has; setting the secrets below turns Developer ID signing, notarization, and the manifest signature on with no other change and no flag to flip. Four things need a human, and each is a checklist you can follow top to bottom.

**Verify workflow write permissions.** The repository default for `GITHUB_TOKEN` is read-only. The workflow raises itself to `contents: write`, which is permitted — a workflow may exceed the default, though not what the token can be granted. If the first run fails with a 403 on the tag push, flip Settings → Actions → General → Workflow permissions to "Read and write".

**Set up Developer ID signing and notarization.** One-time setup on Apple's side, then a set of GitHub secrets the pipeline reads automatically. In order:

1. **Create a Developer ID Application certificate.** This requires the **Account Holder** role. In Xcode: Settings → Accounts → your team → Manage Certificates → **+** → Developer ID Application. (Or the developer portal: Certificates, Identifiers & Profiles → Certificates → **+** → Developer ID → Developer ID Application.) You may hold up to five.
2. **Export it as a `.p12`.** In Keychain Access, find the `Developer ID Application: …` entry, expand it to confirm the private key hangs under it, select the certificate and its key, right-click → Export, choose Personal Information Exchange (`.p12`), and set a strong password. That password becomes `MACOS_CERT_PASSWORD`.
3. **Create an App Store Connect API key for notarization.** App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → **+**, and give it the **Developer** role — that is all notarization needs, not Admin and not Account Holder. Download `AuthKey_XXXXXXXXXX.p8` (Apple lets you download it exactly once) and note the **Key ID** (10 characters) and the **Issuer ID** (the UUID at the top of the Keys page).
4. **Find your Team ID** — the 10-character code in parentheses in the certificate name, also shown under Membership at developer.apple.com/account.
5. **Set the repository secrets** (Settings → Secrets and variables → Actions → New repository secret). Base64 values must carry no trailing newline; the macOS commands below are correct as written.

   | secret | value |
   |---|---|
   | `MACOS_CERT_P12_BASE64` | `base64 -i DeveloperID.p12 \| pbcopy` |
   | `MACOS_CERT_PASSWORD` | the `.p12` password from step 2 |
   | `MACOS_TEAM_ID` | the 10-character Team ID |
   | `MACOS_NOTARY_KEY_P8_BASE64` | `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy` |
   | `MACOS_NOTARY_KEY_ID` | the 10-character Key ID |
   | `MACOS_NOTARY_ISSUER_ID` | the Issuer UUID |

   There is deliberately no identity secret. The workflow reads the signing identity out of the certificate it just imported and fails loudly if the keychain holds no valid `Developer ID Application` identity (the symptom of a `.p12` exported without its intermediate chain). The alternative — a `MACOS_SIGN_IDENTITY` secret holding the identity string — was rejected because codesign matches the certificate's common name exactly, and a hand-typed copy of that name can only ever agree with the certificate or break the build with a bare "no identity found".

6. **Prove your certificate works before trusting CI.** On your Mac, with the certificate in your login keychain, from a Hive checkout:

   ```sh
   scripts/signing/dry-run.sh
   ```

   It builds a real Hive CLI, signs it with your certificate and Hive's entitlements, *runs it*, and checks it with `codesign --verify --strict` — so a signing or entitlement mistake surfaces on your machine now, not on a user's after release. To prove the full Apple round trip including notarization and the app:

   ```sh
   export MACOS_NOTARY_KEY_PATH=~/AuthKey_XXXXXXXXXX.p8
   export MACOS_NOTARY_KEY_ID=XXXXXXXXXX
   export MACOS_NOTARY_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   scripts/signing/dry-run.sh --full
   ```

**Generate the offline Ed25519 release key.** Set both halves or neither — the pipeline hard-errors on a half-configured key, because embedding the public half without signing with the private half flips `hive update` fail-closed and then refuses the very release it shipped in. On an offline machine:

```sh
openssl genpkey -algorithm ed25519 -out hive-release-private.pem
openssl pkey -in hive-release-private.pem -pubout -outform DER | base64   # -> HIVE_RELEASE_PUBLIC_KEY
openssl pkey -in hive-release-private.pem -outform DER | base64           # -> HIVE_RELEASE_PRIVATE_KEY
```

Set `HIVE_RELEASE_PUBLIC_KEY` and `HIVE_RELEASE_PRIVATE_KEY` as repository secrets and keep `hive-release-private.pem` offline — a hardware token or an air-gapped password manager, never the repo. The public half is embedded in every binary via `build.ts --public-key`; the private half signs `hive-release.json` in the release job through `scripts/signing/sign-manifest.ts` and touches nothing else. From the first release with both set, the binary embeds the key, the job publishes `hive-release.json.sig`, and `hive update` stops printing the unsigned-release warning: verification is mandatory and fail-closed from then on.

**Confirm it end to end.** After the first signed release, on a clean Mac or a fresh user account that has never trusted your certificate:

- Download `hive-darwin-arm64` from the release page and run `./hive-darwin-arm64 --version`. It must run with no "Apple could not verify … is free of malware" dialog, and `codesign --verify --check-notarization -R="notarized" -v ./hive-darwin-arm64` must exit 0. (Not `spctl --assess` — it rejects every bare Mach-O, notarized or not.)
- Download and unpack `HiveWorkspace.tar.gz` and open `HiveWorkspace.app`. It must open with no Gatekeeper prompt, and `xcrun stapler validate HiveWorkspace.app` must confirm a stapled ticket.
- Run `hive update`. It must no longer print the unsigned-release warning, which proves the embedded key verified the manifest signature.

**A `hive` Homebrew tap**, if the secondary channel is wanted. Hive already detects a Homebrew-owned install and refuses to rewrite it; nothing else is built.

## Open questions

**Who checks in the background.** [update-experience.md](../research/update-experience.md) argues the daemon should own checking on a jittered ~24-hour timer while the CLI owns telling, which is Hive's structural advantage over `gh` and `npm`: checks happen every 24 hours of use rather than once per invocation burst. Today the check runs in `hive init` against a 24-hour cache, and `checkForUpdate` is written so the daemon can call it unchanged. Until it does, a long-running daemon learns about a release only when someone types `hive init`. The passive one-line notice on `hive status`, `hive claude`, and the rest is built and tested but wired to nothing.

**Automatic activation at quiescence.** A staged update currently waits for a human to run `hive update` again. The design says the daemon should activate it itself when the team drains. That needs a daemon-side quiescence hook, and it is the difference between "updates happen while you use the tool" and "updates happen when you ask twice".

**Where the channel document lives.** The updater reads GitHub's `releases/latest`, which the distribution research explicitly argues against: channel and rollout policy should come from a small signed document on a CDN, not be inferred from a mutable API. `src/update/source.ts` is the seam, and swapping it changes that file and nothing else. This is a deviation taken knowingly to ship, not a decision.

**How a release earns the `securityCritical` flag.** The flag overrides every notice rate limit and the skip list on every install; today it is read out of the release notes and is one person's judgment. Whether that should require a second approver or a linked advisory is a process question, still open, and owned by [update-experience.md](../research/update-experience.md).
