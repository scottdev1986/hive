# The update experience

Updated: 2026-07-13
Sources: Hive source tree, 2026-07-13; research/update-experience.md (2026-07-10, partially stale)

## Summary

What a user sees when a new Hive exists: at most one dim line at the end of a command, never a popup, never an interruption — plus `hive update`, which always does the safe half and tells the truth about the rest. This article owns the notice-surface design and the measured ecosystem survey behind it; [versioning-and-release.md](versioning-and-release.md) is authoritative where they conflict.

## The shape, as shipped

The check runs **in the CLI**, not the daemon. `withTrailingUpdateNotice(wantsUpdateNotice(argv), …)` wraps the whole command in `src/cli.ts:819-825`: the check starts when the command starts and runs concurrently, the line prints only after the command finishes *normally* (a failed command's error is the last thing the user reads, not a version advertisement), and a failed or slow check is silence, never an error.

The network budget is **300 ms** (`cli/update-notice.ts:33`, `:99-109`): a cold fetch aborts fast rather than keeping the process alive after the command is done, and the result still lands in the on-disk cache so the *next* command shows it instantly. `checkForUpdate` itself allows 2.5 s (`update/check.ts:23`) on the surfaces that can afford it.

This contradicts the original design, and the contradiction is the most important thing to know about this article. The research doc's central thesis was that **the daemon owns checking and the CLI owns telling** — the daemon fetching a signed channel manifest on a jittered ~24-hour timer, recording `{latestVersion, stagedVersion, checkedAt, securityCritical}` in the `meta` table, and the CLI "never touching the network for update purposes." None of that is built. No daemon code calls `checkForUpdate`; `update/check.ts:11-13` admits the daemon-owned background check "is not built yet" and says the module is written so the daemon *can* call it unchanged. State lives in two JSON files under `~/.hive`, not in `meta`:

- `update-check.json` — `{latestVersion, checkedAt, securityCritical, dismissedVersion}` (`update/check.ts:25-34`): what we know about releases.
- `update-notice.json` — `{lastNoticeAt}` (`cli/update-notice.ts:53-54`): when we last interrupted the user. **Deliberately a separate file**: one records the world, the other records our own rudeness, and they change on different schedules.

The consequence, stated plainly: a long-running daemon learns about a release only when a human types a command. The structural advantage of having a resident process is designed but unclaimed.

## Where the notice surfaces, and where it deliberately does not

Hive has three possible surfaces and only one is right by default. The daemon has no UI. The orchestrator terminal belongs to a running Claude Code or Codex session, and injecting Hive chrome into it mid-session is both technically awkward and exactly the interruption this design forbids. That leaves the CLI.

The passive trailing notice appears on exactly eight commands (`cli/update-notice.ts:38-47`):

```
status  quota  autonomy  memory  watch  layout  stop  recover
```

**`claude`, `codex`, `init`, and bare `hive` are excluded on purpose** (`cli/update-notice.ts:13-16`). They are **session boundaries**, and they already print the richer *start* notice through `startSession` → `printStartNotice` (`cli/start.ts:51-70`, `cli/start.ts:118`) and, for the standalone Workspace launch, `cli/workspace.ts:176-190`. Two version lines on one command is one too many, and the start notice is strictly better on those surfaces: it is the last moment Hive owns the terminal before an orchestrator takes it, so it always says *something* — including `could not check for updates (…)`, which is the whole point of asking. Everything not on either list — `hive event`, the hidden app-server host, hooks, bridges — never speaks at all, because a surprise stderr line inside an agent turn corrupts a protocol.

The gate is **stdout is a TTY** and `CI` is unset (`cli/update-notice.ts:80-88`); the line itself is written to **stderr** (`cli/update-notice.ts:143-144`). The research doc said "stderr is a TTY" and even `notice.ts:100` still carries that comment; the code gates on stdout. The practical difference is real — `hive status | jq` prints no notice (stdout is a pipe), which is the behavior you want.

The line, dim, one line, ending the command:

```
hive 0.0.9 available (you have 0.0.7) — run hive update
```

When the version is already staged and this is a native install, the line says what is actually true (`update/notice.ts:48-53`): `hive 0.0.9 downloaded — run hive update to activate`, or `— activates when the current team finishes, or run hive update now` when agents are live. On a Homebrew-owned path the command in the line becomes `brew upgrade hive` (`update/paths.ts:77-79`), per the ownership rule.

### Rate limit, dismissal, and the security escalation

Silence is the common case and the correct default — `renderUpdateNotice` returns `null` unless there is genuinely something to do (`update/notice.ts:109-134`). For an ordinary release the notice is suppressed if the version was dismissed (`hive update skip`) or if a notice was shown within the last 24 hours.

**A `securityCritical` release bypasses both** — the skip list *and* the rate limit — and prints in yellow rather than dim, on every eligible command (`update/notice.ts:116-123`, `:44-47`): `hive 0.0.9 available — security release, run hive update`. The code says why in the comment, and it is worth repeating because it is a claim about the field, not about Hive: **there is essentially no CLI precedent for a security-urgent update notice.** Tailscale accelerates security releases and marks them with a red arrow — in its admin console, not in a CLI. npm's red-for-major coloring signals semver breakage, not security. Hive is an agent-control daemon; it sets the precedent rather than inheriting a wrong default.

A **"you are N versions behind" counter** was considered (npm colors by semver distance) and **rejected** (`update/notice.ts:10-12`): at a patch-per-push cadence the number is noise, and the security flag plus the staged-and-waiting line already say everything the count would imply.

### Opt-outs

Two levels of off, mirroring Claude Code, plus the ecosystem variable (`update/check.ts:65-77`):

| variable | effect |
|---|---|
| `HIVE_NO_UPDATE_CHECK=1` | background checks and notices off; `hive update` still works |
| `HIVE_DISABLE_UPDATES=1` | blocks even a manual `hive update` (`cli/update.ts:84-88`) |
| `NO_UPDATE_NOTIFIER` | honored, any value. Costs one `||` and respects a convention users already export |

Per-version dismissal is `hive update skip`, Codex's politest-rate-limit-in-the-survey, one field in a cache file.

## The commands

The real command family (`src/cli.ts:293-315`):

```
hive update                  check, download, verify, stage; activate if the team is idle
hive update check            check and report; exit 0 up-to-date, 10 update available
hive update status           version, commit, install method, key posture, retained versions, last check
hive update 0.0.4            stage and activate an exact version (also the downgrade path)
hive update rollback         reactivate the retained previous version
hive update skip             silence notices for the currently offered version
```

`hive update channel stable` and `hive update off | on` **do not exist** — the research doc listed both. Channels: the manifest carries a `channel` enum (`release/manifest.ts:58`) but **nothing reads it**; `update/source.ts:112-116` resolves `releases/latest` unconditionally. `off`/`on` are the environment variables above.

Claude Code splits pinning into a separate `claude install`; Hive folds it into `hive update <version>` because a second installer-flavored verb earns its keep only when install and update genuinely differ, and under versioned directories they are the same operation: fetch, verify, stage, activate. `rollback` is sugar for `hive update <previous>` that requires no version lookup and is guaranteed local — the moment you want it is the moment you distrust the network's newest offering.

### The three checks, named out loud

`hive update` prints what it actually verified (`cli/update.ts:216-242`):

```
hive 0.0.9 staged — verified: Ed25519 signature, SHA-256, binary probed
```

Hive performs three independent integrity checks on every update — the Ed25519 signature over the manifest, the SHA-256 of each artifact against that signed manifest, and executing the staged binary to make it state its own version before it can ever be `current` — and for a long time told the user about none of them. **"Downloaded and verified" names no check and so cannot be wrong, which is exactly what was wrong with it**: it neither earns trust nor risks anything. The answer to a trust complaint is not a stronger adjective; it is saying plainly what already happens. The rejected alternative was to keep the vague line and let `hive update status` carry the detail — it loses because the moment of the claim is the moment the user is deciding, and nobody audits an install afterwards. The unsigned branch is the inverse and must never read as a footnote, so it prints `UNSIGNED RELEASE:` on a line of its own (`cli/update.ts:244-248`).

The download is **visible**: a binary that asks to replace itself, over tens of megabytes, on a connection the user cannot see, has to earn that. The signed manifest already carries the size, so it is on screen before the connection opens. It degrades twice — no `Content-Length` means bytes and rate but no invented percentage, and off a TTY it prints one plain line and no ANSI, because a `\r`-redrawn bar in a log file is a single unreadable 400 KB line.

### What `hive update` will not do

**No `--now` flag.** Not built, and not an omission: the daemon owns landing authority and approvals, "force" means killing agents mid-write, and the honest spelling already exists — `hive stop && hive update` (`cli/update.ts:1-11`). Making destruction a deliberate two-command act rather than a flag is the point.

**A Homebrew-owned install is refused, not rewritten** (`cli/update.ts:96-101`), and so is an `unmanaged` binary Hive did not place. Two owners for one install is how a package receipt starts lying.

**Daemon auto-activation at quiescence is not built.** A staged update waits for a human to re-run `hive update`. The one-shot `hive updated to 0.0.9` line that was supposed to close that loop does not exist. What *is* built is the refusal message, which names the one thing the user can do about it (`update/daemon.ts:212-224`): `3 agent(s) still working (leo, maya, sam); the running daemon and team are unaffected` / `Fix: run \`hive stop\` to activate now`.

**Wire compatibility is not N/N−1.** The research doc promised "N/N−1 wire compatibility by policy"; `daemon/handshake.ts:11` is `{min: 1, max: 1}` — one wire version, refuse on mismatch. That is the conservative half of the contract and not yet the useful half.

## The ecosystem survey

Measured from source and live docs on 2026-07-10. This is the survey the design above is derived from, and it exists nowhere else in the repo.

**`gh` (GitHub CLI).** Checks in a **goroutine launched at command start** and prints to stderr **after the command finishes**, at most once per 24 hours via a persisted state file; skips CI, non-TTY output, and Codespaces entirely; silenced by `GH_NO_UPDATE_NOTIFIER`. The detail worth stealing: it **delays the notice for Homebrew installs when the release is under 24 hours old**, so the cask has time to land before the user is told to run `brew upgrade`.

**npm.** Fires an unawaited best-effort check and saves the message "for printing at **process exit** so it will not get lost"; weekly for stable versions; **color-codes the notice by semver distance** (red major, yellow minor, cyan patch) and always prints the exact upgrade command. The `update-notifier` config key turns it off.

**`update-notifier`** (the package that set the convention). Checks in a **detached, unref'd child process** and shows the result on the **next** run; one-day default interval; `NO_UPDATE_NOTIFIER`, a `--no-update-notifier` flag, and automatic CI/test-env suppression. It **intentionally stopped auto-installing** after automatic mutation proved unpopular — see [distribution.md](distribution.md).

**Deno.** Delays its startup check by **500 ms** so it can never affect startup latency; caches 24 h; prints to stderr **only when stderr is a terminal**; `DENO_NO_UPDATE_CHECK`.

**Homebrew.** The contrast case: it **acts instead of notifying** — refreshing its own metadata (not formulae) before some commands, default every 86400 seconds.

**Codex CLI.** A `version.json` in the Codex home stores `latest_version`, `last_checked_at`, and an optional `dismissed_version`, refreshed at most every **20 hours**; the network fetch is spawned in the background so startup always renders the previous cached answer. The update action is **install-method-aware**: npm/bun/pnpm equivalents, `brew upgrade --cask codex` for Homebrew, the installer script with `CODEX_NON_INTERACTIVE=1` for standalone, and *nothing at all* when the method is unrecognized — the same respect-the-owner rule Hive follows, verified in a second vendor. And: **Homebrew installs check `formulae.brew.sh`, not GitHub**, so the notice never precedes cask availability. Two notice forms: an interactive "Update available!" popup with "Update now / Skip / Skip until next version" (a persistent per-version dismissal), and a passive history line. One config key, `check_for_update_on_startup`, disables the lot.

**Claude Code.** Native install checks at startup and periodically while running; downloads and installs in the background; takes effect the next time you start. Two channels (`latest`, and `stable` ≈ one week behind, skipping releases with major regressions). **Two levels of off**: `DISABLE_AUTOUPDATER=1` stops background updates while manual `claude update` still works; `DISABLE_UPDATES=1` blocks everything, for organizations distributing through their own channels. And the detail worth copying outright: the managed-settings-only `requiredMinimumVersion`/`requiredMaximumVersion` gate startup and **deliberately fail open on invalid values, so a bad policy push cannot brick the tool.** Failure handling is modest: downloads retry up to **three attempts** on drops, stalls, and checksum failures, with a **ten-minute total deadline**; recovery is rerunning `claude update` or `claude install <version>`.

**The consensus, and the one gap.** Check asynchronously so the user's command is never slower; cache the answer for about a day; print one line to stderr at a natural boundary; gate on TTY and skip CI; name the exact upgrade command *for the user's install method*; provide one dedicated opt-out. **No vendor in this survey performs an automatic post-activation rollback** — they verify before activating and leave recovery to an explicit reinstall. Hive does revert on a failed health check, which is going beyond the precedent, justified because a daemon can be health-checked and a TUI cannot, and because a broken control plane strands a team rather than merely failing a command.

## Rejected alternatives

**A startup popup**, Codex-style. Codex owns its TUI and can ask a question. **Hive does not own the orchestrator terminal** — it belongs to Claude Code or Codex — and interrupting an agent session with Hive chrome is exactly the annoyance this design exists to avoid.

**A "you're N versions behind" counter.** Noise at a patch-per-push cadence.

**A vague "downloaded and verified" line.** Names no check, so it cannot be wrong; that is the defect, not the feature.

**Trust on first use.** Rejected outright: a pinned key is the entire point, and TOFU on an updater means the first fetch decides who owns the machine. See [versioning-and-release.md](versioning-and-release.md).

**`CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE`-style opt-in brew automation.** Say `brew upgrade hive` and stop.

## Open decisions

1. **Security-notice severity source.** `securityCritical` is release-author judgment, grepped out of the GitHub release notes (`update/check.ts:135-138`), with no external check — and it overrides every rate limit and the skip list on every install. A second approver or a linked advisory is plausible; it is a process decision, not a code one.
2. **Beta-channel population.** The manifest carries `beta` from day one but nothing reads `channel`. Publishing a channel with one subscriber is ceremony; not publishing means the first channel switch happens untested.
3. **Post-activation confirmation placement.** The one-shot `hive updated to X` line assumes the next command comes soon after quiescent activation. Neither the line nor the quiescent activation exists yet.

## See Also

- [versioning-and-release.md](versioning-and-release.md) — the versioning contract; authoritative where this article and it disagree
- [distribution.md](distribution.md) — how the bytes get here, and why not npm/Homebrew/Sparkle
- [../daemon/database-resilience.md](../daemon/database-resilience.md) — what the daemon restart behind an activation must survive
- [../../SPEC.md](../../SPEC.md)
