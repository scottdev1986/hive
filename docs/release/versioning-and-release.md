# Versioning and release

Updated: 2026-07-14
Sources: Hive source tree, 2026-07-14; `src/release/contract.test.ts`

## Summary

Hive's version is a fact about what a user is running, not a label someone remembers to change: one push to `main` publishes exactly one release, one patch above the last, nobody types a version number, and no commit contains one. This document owns the versioning contract; every rule below that a human could break with a plausible edit is asserted in `src/release/contract.test.ts`, which runs in the same `bun test` step the release workflow gates on.

This document is authoritative. [distribution.md](distribution.md) owns *how* releases reach machines; [update-experience.md](update-experience.md) owns *what the user sees*. Where they disagree with this document, this one is the implementation and they are the design — fix whichever is wrong. `src/release/plan.ts:47-58` raises an error that names this document by path: a minor or major bump "must update docs/release/versioning-and-release.md and src/release/plan.ts together." Editing a rule here without editing the code, or the reverse, is the failure both are designed to prevent.

## The contract

Hive is `0.0.x`. Patch-only. The first release is `0.0.1`.

One push to `main` bumps the patch by exactly one. A push carrying a hundred local commits is still one push, so it is still one release — **the bump is a function of the tip commit and the existing tags**, never of how many commits arrived. The GitHub `push` event fires once per push, so nothing needs to deduplicate anything. The workflow therefore checks out with `fetch-depth: 0` and `fetch-tags: true`, because the tags *are* the input (`contract.test.ts:83-86`).

A commit that already carries a release tag is never released again. That single rule is what makes the pipeline idempotent: re-running the workflow, re-triggering it by hand, or force-pushing a tip that is already tagged all resolve to "nothing to do" (`plan.ts:94-107`). The tag push itself is a compare-and-swap — `git push` of a ref that exists fails — so two concurrent runs can never both mint `v0.0.7`.

Everything above lives in `src/release/plan.ts` as a pure function, is tested in `plan.test.ts`, and is called by CI through `plan-cli.ts`. **The rule is not written in YAML**, where nothing could test it; `contract.test.ts:88-91` fails the build if the workflow stops calling the planner or reimplements the bump in shell (`git tag | sort | tail`). It also fails the build if `package.json` starts carrying a release version, or if any module declares a version string of its own. The contract is enforced by the automation, not by memory — which is the point, because memory is exactly what failed when four copies of `"0.1.0"` drifted apart across the daemon, the MCP clients, the channel bridge, and the Codex handshake (`contract.test.ts:56-64` names all four).

Staying patch-only is a deliberate refusal to decide something we cannot yet decide. We are a long way from knowing what a minor bump would mean for Hive, and a scheme with one moving part cannot drift. The alternative was conventional commits — read intent from commit messages, bump minor on `feat:`. It loses because it makes the version a function of prose nobody proofreads, and it mints `0.1.0` the first time someone types the wrong prefix. A version tag outside `v0.0.x` is therefore not noise to skip but a contract violation: `planRelease` **throws** rather than mint `v0.0.8` *behind* a stray `v0.1.0` and hand two builds a descending version order (`plan.ts:42-59`). `v0.0.007` is refused for the same reason — a second name for one release (`plan.ts:38-39`). Comparison is numeric, not lexicographic, so `v0.0.9` does not outrank `v0.0.10` (`plan.ts:64-68`). When Hive is ready for `0.1.0`, that is a deliberate edit to this document and to `plan.ts`, together.

## What a version is

`src/version.ts` is the only module that names a version. **No commit contains a release version:** `package.json` carries `"0.0.0"`, and a checkout renders itself as `0.0.0-dev` (`src/version.ts:19-30`). `bun build --compile --define 'process.env.HIVE_BUILD_VERSION="0.0.7"'` rewrites the member expression into a string literal before the bundle is written, so a release binary cannot be relabelled by exporting an environment variable at it.

The checkout fallbacks are intentional identity states, not release facts. The version is `0.0.0-dev`; commit and build date are `unknown`; the compiled build hash and embedded release key are `null` (`src/version.ts:23-58`). Code must branch on those states. In particular, `IS_RELEASE_BUILD` is true only when the compiled build hash exists; a checkout never checks for releases and `hive update` refuses it with the instruction to pull and rebuild.

The release builder inlines version, commit, date, and build hash unconditionally, and the public key when configured (`src/release/build.ts:130-160`). `HIVE_UPDATE_REPO` is not inlined; it remains a runtime value with the default `scottdev1986/hive` (`src/version.ts:54-55`).

**The build hash** is what the daemon presents in its handshake, and it is a content address of the build's *inputs* — source tree, version, commit, target triple — not of its output. It cannot hash the output because the output embeds the hash. A release binary carries the inlined value; a checkout computes a source-tree hash when it needs a handshake. This is deliberately not the marketing version: two builds labelled `0.0.7` but containing different code must refuse one another.

**The release public key** is the offline Ed25519 key's public half, inlined at build time. A release binary's trust anchor therefore cannot be swapped through its environment. The lower-level verifier can describe an unsigned manifest for first-install reporting, but the updater has no unsigned path: staging requires `verified && signed`, so a missing key, missing signature, altered manifest, or foreign signature is a refusal (`src/update/install.ts:158-173`, `:327-341`). `hive update status` reports a missing key as “this build cannot verify a release signature”; it never implies verification happened.

The key value is a comma-separated list, which permits rotation without a flag day. Any listed key may vouch for a manifest, so one release can trust {old, new}, that trust can propagate, and a later release can begin signing with new (`src/release/manifest.ts:181-234`). Rotation does not revoke a compromised old private key from binaries that still trust it; that requires an out-of-band reinstall.

## The pipeline

`.github/workflows/release.yml`, on **push to `main`** (`branches: [main]`), **serialized by a concurrency group** (`group: hive-release`, `cancel-in-progress: false`) so two pushes cannot race, and **raising itself to `contents: write`** because the repository default for `GITHUB_TOKEN` is read-only. All three are asserted in `contract.test.ts:70-81`.

1. Typecheck and test. **Nothing is released from a red tree** — `bun test` runs ahead of the planner, and `contract.test.ts:100-104` fails the build if that order is ever inverted.
2. Plan: `plan-cli.ts` reads the tags and the tip's tags, and prints `{action, version, tag}`.
3. Build, if the action is `release`: two Bun-compiled CLI slices (`darwin-arm64`, `darwin-x64`, cross-compiled from one macOS runner) and one universal Workspace application built with `swift build -c release --arch arm64 --arch x86_64`. The universal bundle is duplicated across both manifest entries rather than sliced, because a 3 MB duplicate is cheaper than a second bundle to sign and notarize.
4. Sign, if a Developer ID certificate is configured: a Developer ID Application signature with the hardened runtime and a secure timestamp on both CLI slices and the app, one `notarytool` submission for all three, and a stapled ticket on the app. With no certificate configured the artifacts stay unsigned and the release notes say so. **The switch is the presence of the certificate secret, not a flag anyone flips** (`release.yml:79-114`).
5. Prove the built binary reports its own version; sign `hive-release.json` with the offline key if one exists; verify the manifest signature *with the client's own `verifyManifest` against the key that was actually embedded*; and verify every Apple signature — `codesign --verify --strict` on everything, `codesign --check-notarization` on the CLI slices, `spctl --assess` and a stapled-ticket check on the app — failing the release on any defect. All of this is *before* the tag.
6. Tag, then publish the GitHub Release with both binaries, the app tarball, `hive-release.json`, and — when a key is configured — `hive-release.json.sig`.

**Building *before* tagging is the interesting ordering, and it is a bound rule** (`contract.test.ts:93-98`). A failed build must not burn a version number, so the tag is minted only once there are artifacts to attach to it. The cost is that two racing runs may both build and only one may tag; a wasted build is cheaper than a gap in the series. Signing and its verification sit inside that same before-the-tag window for the same reason: a certificate problem or a notarization rejection must fail the release, not ship a broken signature under a fresh version number. The client-side manifest verification in step 5 exists for the sharpest version of this: verification is fail-closed, so a public/private pair that disagree — a bad paste into a secret, a half-finished rotation — would publish a release that *every installed Hive refuses*, including the ones that would have carried the fix. Silent at build time, total at update time. Running the client's verifier before the tag costs a build instead of a version.

**The pinned Bun version equals `packageManager`** — both `bun@1.3.14` — and `contract.test.ts:106-112` reads the workflow's `bun-version` and `package.json`'s `packageManager` and asserts they agree. The release binary embeds this Bun's runtime; a floating version would silently change what every user runs.

### Signing a Bun binary: two sharp edges found by testing, not by reading

First, `bun build --compile` writes its own ad-hoc "linker-signed" signature, and on Bun ≥ 1.3.12 that signature **reserves too little room in `__LINKEDIT`** for a real one ([oven-sh/bun#29120](https://github.com/oven-sh/bun/issues/29120)); re-signing on top of it produces a truncated signature that fails `codesign --verify --strict` with "main executable failed strict validation". The build sets **`BUN_NO_CODESIGN_MACHO_BINARY=1`** whenever it is going to sign (`build.ts:159`, `release.yml:185`), which is the only way measured to yield a strict-valid Developer ID signature. Proven locally on both arm64 and cross-compiled x64: the no-codesign build signs strict-clean, the default build does not (`sign.ts:17-30`).

Second, a compiled binary embeds JavaScriptCore — a JIT — and the hardened runtime kills a JIT that lacks `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`. Hive grants **exactly those two**, in `scripts/signing/entitlements.plist`. Bun's own guide prints three more — `disable-library-validation`, `disable-executable-page-protection`, `allow-dyld-environment-variables` — and Hive omits all three: a self-contained binary loads no foreign libraries, needs no `DYLD_*` overrides, and does not need executable-page-protection disabled once JIT is allowed. Each entitlement is attack surface, so the rejected alternative — sign with Bun's full set because it is what the guide shows — trades security for nothing. `scripts/signing/dry-run.sh` proves the choice against a real certificate before CI is trusted, and `sign.test.ts:94-110` pins the plist (both the two granted keys and the absence of the omitted ones) so the proof and the shipped file cannot drift.

### Stapling, and the `spctl` trap

Stapling is where the CLI and the app diverge. A notarization ticket staples into a bundle but not into a bare Mach-O — `notarytool` and `stapler` accept only zips, packages, and bundles. So the app carries a stapled ticket and clears Gatekeeper offline, while the CLI slices are notarized inside a zip (which registers their code hash with Apple) and rely on Gatekeeper's online ticket lookup the first time they run. That is Apple's model for command-line tools, honestly documented rather than papered over: a machine that is offline the very first time it runs a freshly downloaded `hive` binary is the one case the ticket cannot cover, and the SHA-256 in the manifest plus the embedded signature are what stand behind it there.

The divergence extends to how CI proves notarization, and this is the measured finding worth carrying forward. The app is a bundle, so `spctl --assess` renders Gatekeeper's actual verdict on it. But **`spctl --assess --type execute` rejects *any* bare Mach-O** — Anthropic's and Docker's notarized CLIs included — with "does not seem to be an app". Using it on the CLI slices was the rejected first attempt, and **it failed a release whose notarization had in fact been accepted**. It proves nothing. The slices are instead checked with `codesign --check-notarization -R="notarized"`, which resolves the binary's CDHash against Apple's ticket service and does reject a signed-but-unnotarized binary.

### The manifest

`hive-release.json` is the manifest: `schema`, `version`, `tag`, `channel`, `commit`, `publishedAt`, `securityCritical`, `wireProtocol {min,max}`, `schemaEpoch`, and for each artifact a `name`, `kind`, `platform`, `arch`, `size`, `sha256`, and `buildHash` (`src/release/manifest.ts:42-75` — that is the complete field list). It is the one document the updater trusts, and the SHA-256 it records is of the final signed, stapled bytes — the exact bytes `hive update` re-hashes on the way in — because signing is done before any digest is taken.

Two independent signatures protect a release and neither substitutes for the other. **Apple's Developer ID signature authenticates the executable to macOS; the manifest signature authenticates *update policy* to Hive** — which version is current, which bytes are it, whether it is urgent. A notarized binary served from the wrong manifest is still the wrong update.

## Install, update, launch

`~/.local/share/hive/versions/<version>/` holds an immutable tree per release: the `hive` binary and `HiveWorkspace.app`, plus `release-verification.json` containing the exact manifest bytes and signature needed to prove an offline rollback target. The shell installer refuses a release whose signature asset is missing or empty, so every shell-installed version carries that sidecar. `current` is a symlink at one version directory and `~/.local/bin/hive` points at `current/hive` forever (`install.sh:74-109`, `src/update/install.ts:54-83`, `:215-250`).

**Activation is one `rename(2)` over `current`, which is atomic**, so there is no instant at which `current` names a half-installed tree (`src/update/install.ts:366-378`, `paths.ts:1-14`). The in-binary updater creates a temporary sibling symlink and renames that directory entry over `current`; it never resolves or follows the existing link. In the shell installer this is `replace_symlink` (`install.sh:26-36`), and the flag is load-bearing: **BSD `mv` needs `-h`**. `contract.test.ts:133-170` proves both halves against the live filesystem on macOS:

- plain `/bin/mv -f current.tmp current` **follows** the `current` symlink, moves the temporary link *inside the old version directory*, exits **0**, and leaves `current` still pointing at the old release — a silent missed activation;
- `/bin/mv -fh current.tmp current` replaces the symlink itself and leaves nothing behind.

The installer is Darwin-guarded, verifies every artifact's digest **before it ever runs the binary** (`src/release/contract.test.ts:118-120`), runs the staged binary and makes it state its own version before it can be `current`, and after activation re-reads the link and re-resolves `current` to confirm it landed on the intended directory (`install.sh:74-128`). It requires and preserves signed rollback provenance but does not verify Ed25519 itself; the real-shell regressions prove that a signed fresh install survives update and rollback, changed retained bytes are refused, and missing or empty signature material is refused before installation (`src/release/install.test.ts:212-275`). `install.sh` must also be executable (`src/release/contract.test.ts:172-174`). It is short on purpose: short enough to audit is the only reason `curl | sh` is acceptable.

`hive update` always does the safe half immediately — check, verify the signed manifest, download, hash, probe, and stage — and then tells the truth about activation. It activates only while holding the machine mutation lease and after a final enumeration proves that every instance has an empty observable team. An unobservable instance refuses activation. Spawn and landing register operations with the same coordinator, closing the race between that final check and the `current` change (`src/cli/update.ts:291-365`, `src/daemon/mutation-lease.ts:162-305`). **There is no `--now` flag** that forces activation over a live team; `hive stop && hive update` is the explicit destructive spelling.

After activation, the health check runs; if the new binary cannot say its own name, `current` goes back and the failed version stays on disk for diagnosis (`src/update/install.ts:487-533`). Three versions are retained — active, rollback target, and the next most recent (`src/update/install.ts:408-468`). None of rustup, Deno, Bun, or Claude Code does a post-activation revert. Hive can because the thing it activates has a bounded health check, and a broken control plane strands a team rather than merely failing a command.

"Already staged" is not a shortcut. Existing bytes re-enter through the signed-manifest gate, are re-hashed against the selected artifact, and must report their version again. A bad inactive copy is deleted and fetched again; a bad active copy is preserved and refused rather than deleting the running install (`src/update/install.ts:263-364`, `src/cli/update.ts:336-350`).

Rollback is equally fail-closed. Before moving `current`, it re-verifies `release-verification.json`, checks that the signed manifest names the requested version and current architecture, and hashes the retained CLI. Versions staged before this proof existed, or whose sidecar or binary was altered, are refused with an exact-version reinstall remedy (`src/update/install.ts:536-618`).

Ownership decides who may write. A Homebrew-owned install is told `brew upgrade hive` and is never rewritten, because two owners for one install is how a package receipt starts lying; Codex does the same thing, dispatching to the package manager that installed it. A binary sitting somewhere Hive did not put it is `unmanaged` and refused rather than guessed at. A source checkout is a source checkout *wherever it sits*, including inside the install root — identified by what it is (`IS_RELEASE_BUILD`), not by where it lives (`paths.ts:58-74`).

### The daemon is why activation is not a file copy

A Unix process keeps executing its already-open image after the symlink moves, so after activation an old daemon may still be serving and presenting the old build hash. Before that can happen, the update command's machine-wide gate has already proved that every discovered instance is observable and has no live team (`src/cli/update.ts:291-325`). The local stale-daemon path then decides whether the selected instance's daemon is safe to stop. The handshake refuses to adopt an old build; stopping a daemon that is provably ours and idle closes the loop so the next start uses the new binary. Three distinctions do the local work, and conflating any two is a bug (`update/daemon.ts:12-21, 37-47`):

- **stale** — same project, different build. Ours to restart.
- **foreign** — a different project's daemon on our port. Never ours to kill.
- **busy** — stale, but a team is live. Ours to leave alone until quiescence.

`handshakeMismatch` reports only the first field that differs, in an order that puts product version ahead of project identity. Trusting that string alone would let a version bump masquerade as permission to kill a stranger's daemon, so identity is compared first and explicitly (`update/daemon.ts:100-114`). **An agent list that cannot be read is treated as a live team, not an idle one:** refusing to activate costs a retry, and guessing costs an agent mid-write (`update/daemon.ts:117-125`). We stop rather than hot-swap because the daemon owns SQLite state, approvals, and landing authority; SIGTERM lets its normal shutdown path capture and reap the team and orchestrator before removing lifecycle files. See [Database resilience](../daemon/database-resilience.md) for the state that shutdown protects.

`hive` with no arguments opens the installed release Workspace. There is deliberately no development fallback — no symlink into `workspace/.build`, no `swift run`, no environment variable that quietly prefers a debug bundle. A `hive` that sometimes launches a debug build is a `hive` whose bug reports cannot be trusted, and the one thing worse than "Workspace is not installed" is "Workspace launched, and nobody can say which one".

`hive init` checks for updates and prints one line before doing anything else. It is the session boundary, and the last moment Hive owns the terminal. The check is best-effort and never blocks: a machine with no network prints `could not check for updates (…)` and starts anyway. It **never prints "up to date" on a failed check**, because that sentence is a claim about the world and we would not have looked. A cached answer is still evidence — we observed that version exist — so an offline machine keeps telling the truth it last learned. But a stale cache saying "you are current" is downgraded to "could not check", because "nothing was newer yesterday" is not evidence that nothing is newer today (`update/check.ts:178-196`).

## The signing credentials

Both signatures are live. Releases from 0.0.6 are Developer ID-signed, notarized, and carry an Ed25519 signature over the manifest; the secrets below are set on the repository and the pipeline turns each capability on by the *presence* of its secret, with no flag to flip. A fork with neither signing secret can still publish artifacts and release notes that identify them as unsigned, but the native updater will not install them: it requires an embedded Hive release key and a matching manifest signature. Unsigned publication is pipeline degradation for forks, not a supported update trust mode.

This section is therefore the recreate-and-rotate procedure, not a to-do list.

**Verify workflow write permissions.** The repository default for `GITHUB_TOKEN` is read-only. The workflow raises itself to `contents: write`, which is permitted — a workflow may exceed the default, though not what the token can be granted. If the first run fails with a 403 on the tag push, flip Settings → Actions → General → Workflow permissions to "Read and write".

**Set up Developer ID signing and notarization.** One-time setup on Apple's side, then a set of GitHub secrets the pipeline reads automatically. In order:

1. **Create a Developer ID Application certificate.** This requires the **Account Holder** role. In Xcode: Settings → Accounts → your team → Manage Certificates → **+** → Developer ID Application. (Or the developer portal: Certificates, Identifiers & Profiles → Certificates → **+** → Developer ID → Developer ID Application.) You may hold up to five.
2. **Export it as a `.p12`.** In Keychain Access, find the `Developer ID Application: …` entry, expand it to confirm the private key hangs under it, select the certificate and its key, right-click → Export, choose Personal Information Exchange (`.p12`), and set a strong password. That password becomes `MACOS_CERT_PASSWORD`. Export *with* the "Developer ID Certification Authority" intermediate: a `.p12` carrying only the leaf imports fine and then holds no valid identity, and the workflow fails with exactly that diagnosis rather than codesign's bare "no identity found" (`release.yml:158-168`).
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

   There is deliberately **no identity secret**. The workflow reads the signing identity out of the certificate it just imported and fails loudly if the keychain holds no valid `Developer ID Application` identity. The alternative — a `MACOS_SIGN_IDENTITY` secret holding the identity string — was rejected because codesign matches the certificate's common name exactly, and a hand-typed copy of that name can only ever agree with the certificate or break the build with a bare "no identity found".

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

**The Ed25519 release key.** Generate it away from the source checkout and never commit either private material or its encoded value:

```sh
openssl genpkey -algorithm ed25519 -out hive-release-private.pem
openssl pkey -in hive-release-private.pem -pubout -outform DER | base64   # -> HIVE_RELEASE_PUBLIC_KEY
openssl pkey -in hive-release-private.pem -outform DER | base64           # -> HIVE_RELEASE_PRIVATE_KEY
```

Both halves are GitHub Actions secrets. The private half is therefore available to release CI; this is not offline signing. **Set both or neither:** the pipeline hard-errors on a half-configured key (`release.yml:100-108`), because embedding the public half without signing with the private half flips `hive update` fail-closed and then refuses the very release it shipped in. The public half is inlined into every binary via `build.ts --public-key`; the private half signs `hive-release.json` in the release job through `scripts/signing/sign-manifest.ts` and touches nothing else in the pipeline.

**To rotate the key**, exploit the fact that `HIVE_RELEASE_PUBLIC_KEY` is a comma-separated list and any listed key may vouch for a manifest. Generate the new pair, then take it in **three releases, never fewer**:

1. Set `HIVE_RELEASE_PUBLIC_KEY` to `<old>,<new>` and leave `HIVE_RELEASE_PRIVATE_KEY` as the old half. This release still signs with the old key but *trusts* both. Nothing breaks, and the new key starts propagating into installed binaries.
2. Wait until installations have picked that release up. This is the step with no shortcut — a binary that never learned the new key cannot verify a release signed with it.
3. Swap `HIVE_RELEASE_PRIVATE_KEY` to the new half, and once you are willing to strand anything older than step 1, drop `<old>` from the list.

Skipping step 1 is the flag day: the release that introduces the key is the release that every installation must already have, and the ones that don't are stranded with no upgrade path but a manual reinstall. Note what rotation does **not** fix — a **compromised** private key. Whoever holds it can sign for every binary still listing the matching public half, and no release you publish can revoke that, because the attacker's manifest verifies against a key those binaries already trust. The answer there is out-of-band: a new install script, announced through a channel the attacker does not control.

**Confirming it end to end.** On a clean Mac or a fresh user account that has never trusted the certificate:

- Download `hive-darwin-arm64` from the release page and run `./hive-darwin-arm64 --version`. It must run with no "Apple could not verify … is free of malware" dialog, and `codesign --verify --check-notarization -R="notarized" -v ./hive-darwin-arm64` must exit 0. (**Not `spctl --assess`** — it rejects every bare Mach-O, notarized or not.)
- Download and unpack `HiveWorkspace.tar.gz` and open `HiveWorkspace.app`. It must open with no Gatekeeper prompt, and `xcrun stapler validate HiveWorkspace.app` must confirm a stapled ticket.
- Run `hive update status`. `signature key:` must read `embedded (1 key) — a valid signature is required to install`. A binary that says `none` cannot verify anything, and is either a checkout or a release from before 0.0.6.
- Run `hive update`. It must name what it checked — `verified: Ed25519 signature, SHA-256, binary probed` — and must never print the UNSIGNED banner.

**A `hive` Homebrew tap**, if the secondary channel is wanted. Hive already detects a Homebrew-owned install and refuses to rewrite it; nothing else is built.

## Open questions

**Who checks in the background.** [update-experience.md](update-experience.md) argues the daemon should own checking on a jittered ~24-hour timer while the CLI owns telling — Hive's structural advantage over `gh` and `npm`, since checks would happen every 24 hours of use rather than once per invocation burst. That is **not what shipped**: no daemon calls `checkForUpdate` (`update/check.ts:11-13` says so in as many words), and every check today is a CLI check against a 24-hour on-disk cache — `hive init`/bare `hive` at the session boundary, and the trailing notice on a short 300 ms network budget. A long-running daemon still learns about a release only when a human types a command.

**Automatic activation at quiescence.** A staged update currently waits for a human to run `hive update` again. The design says the daemon should activate it itself when the team drains. That needs a daemon-side quiescence hook, and it is the difference between "updates happen while you use the tool" and "updates happen when you ask twice".

**Where the channel document lives.** The updater reads GitHub's `releases/latest`, which the distribution research explicitly argues against: channel and rollout policy should come from a small signed document on a CDN, not be inferred from a mutable API. The manifest carries a `channel` enum (`src/release/manifest.ts:61-75`) but **nothing reads it** — `src/update/source.ts:112-116` resolves `releases/latest` unconditionally. That file is the seam, and swapping it changes that file and nothing else. This is a deviation taken knowingly to ship, not a decision; see [distribution.md](distribution.md).

**How a release earns the `securityCritical` flag.** The flag overrides every notice rate limit and the skip list on every install; today it is grepped out of the GitHub release notes (`update/check.ts:135-138`) and is one person's judgment. Whether that should require a second approver or a linked advisory is a process question, still open, and owned by [update-experience.md](update-experience.md).

## See Also

- [update-experience.md](update-experience.md) — the notice surfaces, the opt-outs, and the ecosystem survey behind them
- [distribution.md](distribution.md) — why a native installer, why not npm/Homebrew/Sparkle, and the honest gaps in the installer
- [../daemon/database-resilience.md](../daemon/database-resilience.md) — what a daemon restart at activation has to protect
- [../../SPEC.md](../../SPEC.md) — the product contract the release pipeline serves
