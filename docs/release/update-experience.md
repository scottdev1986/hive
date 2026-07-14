# The update experience

Updated: 2026-07-14
Source: Hive source tree, 2026-07-14

## Summary

What a user sees when a new Hive exists: at most one dim line at the end of a command, never a popup, never an interruption — plus `hive update`, which always does the safe half and tells the truth about the rest. This article owns the notice-surface design and the measured ecosystem survey behind it; [versioning-and-release.md](versioning-and-release.md) is authoritative where they conflict.

## The shape, as shipped

The check runs **in the CLI**, not the daemon. `withTrailingUpdateNotice(wantsUpdateNotice(argv), …)` wraps the whole command in `src/cli.ts:843-853`: the check starts when the command starts and runs concurrently, the line prints only after the command finishes *normally* (a failed command's error is the last thing the user reads, not a version advertisement), and a failed or slow check is silence, never an error.

The network budget is **300 ms** (`src/cli/update-notice.ts:33`, `:96-109`): a cold fetch aborts fast rather than keeping the process alive after the command is done, and the result still lands in the on-disk cache so the *next* command shows it instantly. `checkForUpdate` itself allows 2.5 s (`src/update/check.ts:23`) on the surfaces that can afford it.

This contradicts the original design, and the contradiction is the most important thing to know about this article. The research doc's central thesis was that **the daemon owns checking and the CLI owns telling** — the daemon fetching a signed channel manifest on a jittered ~24-hour timer, recording `{latestVersion, stagedVersion, checkedAt, securityCritical}` in the `meta` table, and the CLI "never touching the network for update purposes." None of that is built. No daemon code calls `checkForUpdate`; `src/update/check.ts:10-13` admits the daemon-owned background check "is not built yet" and says the module is written so the daemon *can* call it unchanged. State lives in two JSON files under `~/.hive`, not in `meta`:

- `update-check.json` — `{latestVersion, checkedAt, securityCritical, dismissedVersion}` (`src/update/check.ts:25-34`): what we know about releases.
- `update-notice.json` — `{lastNoticeAt}` (`src/cli/update-notice.ts:49-54`): when we last interrupted the user. **Deliberately a separate file**: one records the world, the other records our own rudeness, and they change on different schedules.

The consequence, stated plainly: a long-running daemon learns about a release only when a human types a command. The structural advantage of having a resident process is designed but unclaimed. Both cache files live below the selected `HIVE_HOME`; `~/.hive` is the default instance.

## Where the notice surfaces, and where it deliberately does not

Hive has three possible surfaces and only one is right by default. The daemon has no UI. The orchestrator terminal belongs to a running Claude Code or Codex session, and injecting Hive chrome into it mid-session is both technically awkward and exactly the interruption this design forbids. That leaves the CLI.

The passive trailing notice appears only on the human-facing commands in `USER_FACING_COMMANDS` (`src/cli/update-notice.ts:35-47`). Session boundaries and machine-facing protocol commands are deliberately absent from that allowlist.

**`claude`, `codex`, `init`, and bare `hive` are excluded on purpose** (`src/cli/update-notice.ts:13-16`). Repo-backed session boundaries already print the richer *start* notice through `startSession` → `printStartNotice` (`src/cli/start.ts:53-72`, `:108-122`). Two version lines on one command is one too many, and that start notice is strictly better: it is the last moment Hive owns the terminal before an orchestrator takes it, so it says what the check found, including `could not check for updates (…)`. A standalone Workspace launch has no repo session to start; it performs its own forced check and prints only when a non-dismissed update is available (`src/cli/workspace.ts:191-208`). Everything not on either list—`hive event`, the hidden app-server host, hooks, and helpers—never speaks at all, because a surprise stderr line inside an agent turn corrupts a protocol.

The gate is **stdout is a TTY** and `CI` is unset (`src/cli/update-notice.ts:78-88`); the line itself is written to **stderr** (`src/cli/update-notice.ts:139-150`). The practical difference is real — `hive status | cat` prints no notice because stdout is a pipe.

The line, dim, one line, ending the command:

```
hive 0.0.9 available (you have 0.0.7) — run hive update
```

When the version is already staged and this is a native install, the line says what is actually true (`src/update/notice.ts:49-53`): `hive 0.0.9 downloaded — run hive update to activate`, or `— run hive update after all Hive teams stop` when agents are live. It promises no automatic activation and names no nonexistent force command.

### Rate limit, dismissal, and the security escalation

Silence is the common case and the correct default — `renderUpdateNotice` returns `null` unless there is genuinely something to do (`src/update/notice.ts:109-134`). For an ordinary release the notice is suppressed if the version was dismissed (`hive update skip`) or if a notice was shown within the last 24 hours.

**A `securityCritical` release bypasses both** — the skip list *and* the rate limit — and prints in yellow rather than dim, on every eligible command (`src/update/notice.ts:114-123`, `:45-48`): `hive 0.0.9 available — security release, run hive update`. The code says why in the comment, and it is worth repeating because it is a claim about the field, not about Hive: **there is essentially no CLI precedent for a security-urgent update notice.** Tailscale accelerates security releases and marks them with a red arrow — in its admin console, not in a CLI. npm's red-for-major coloring signals semver breakage, not security. Hive is an agent-control daemon; it sets the precedent rather than inheriting a wrong default.

A **"you are N versions behind" counter** was considered (npm colors by semver distance) and **rejected** (`src/update/notice.ts:10-12`): at a patch-per-push cadence the number is noise, and the security flag plus the staged-and-waiting line already say everything the count would imply.

### Opt-outs

Two levels of off, mirroring Claude Code, plus the ecosystem variable (`src/update/check.ts:65-77`):

| variable | effect |
|---|---|
| `HIVE_NO_UPDATE_CHECK=1` | background checks and notices off; `hive update` still works |
| `HIVE_DISABLE_UPDATES=1` | blocks even a manual `hive update` (`src/cli/update.ts:94-117`) |
| `NO_UPDATE_NOTIFIER` | honored, any value. Costs one `||` and respects a convention users already export |

Per-version dismissal is `hive update skip`, Codex's politest-rate-limit-in-the-survey, one field in a cache file.

## The commands

The real command family (`src/cli.ts:308-331`):

```
hive update                  check, download, verify, stage; activate if the team is idle
hive update check            check and report; exit 0 up-to-date, 10 update available
hive update status           version, commit, install method, key posture, retained versions, last check
hive update 0.0.4            stage and activate an exact version (also the downgrade path)
hive update rollback         reactivate the retained previous version
hive update skip             silence notices for the currently offered version
```

`hive update channel stable` and `hive update off | on` **do not exist** — the research doc listed both. Channels: the manifest carries a `channel` enum (`src/release/manifest.ts:61-75`) but **nothing reads it**; `src/update/source.ts:112-116` resolves `releases/latest` unconditionally. `off`/`on` are the environment variables above.

Claude Code splits pinning into a separate `claude install`; Hive folds it into `hive update <version>` because a second installer-flavored verb earns its keep only when install and update genuinely differ, and under versioned directories they are the same operation: fetch, verify, stage, activate.

`rollback` does not fetch release bytes, but it is not a trust shortcut. Each staged version stores the exact signed manifest bytes and signature in `release-verification.json`. Rollback re-verifies that signature, selects the artifact for the running architecture, and re-hashes the retained CLI before changing `current`. A legacy or tampered version without valid verification material is refused with an instruction to reinstall that exact version (`src/update/install.ts:536-618`).

### The three checks, named out loud

`hive update` prints what it actually verified (`src/cli/update.ts:276-289`, `:325-350`):

```
hive 0.0.9 staged — verified: Ed25519 signature, SHA-256, binary probed
```

Hive performs three independent integrity checks on every update — the Ed25519 signature over the manifest, the SHA-256 of each artifact against that signed manifest, and executing the staged binary to make it state its own version before it can ever be `current` — and for a long time told the user about none of them. **"Downloaded and verified" names no check and so cannot be wrong, which is exactly what was wrong with it**: it neither earns trust nor risks anything. The answer to a trust complaint is not a stronger adjective; it is saying plainly what already happens. The rejected alternative was to keep the vague line and let `hive update status` carry the detail — it loses because the moment of the claim is the moment the user is deciding, and nobody audits an install afterwards.

There is no unsigned update mode. Staging refuses when the running binary has no embedded release key, the signature asset is missing, or the signature does not verify. A source checkout refuses self-update and tells the user to pull and rebuild (`src/cli/update.ts:94-117`, `src/update/install.ts:158-173`).

The download is **visible**: a binary that asks to replace itself, over tens of megabytes, on a connection the user cannot see, has to earn that. The signed manifest already carries the size, so it is on screen before the connection opens. It degrades twice — no `Content-Length` means bytes and rate but no invented percentage, and off a TTY it prints one plain line and no ANSI, because a `\r`-redrawn bar in a log file is a single unreadable 400 KB line.

### What `hive update` will not do

**No `--now` flag.** Not built, and not an omission: the daemon owns landing authority and approvals, "force" means killing agents mid-write, and the honest spelling already exists — `hive stop && hive update` (`src/cli/update.ts:1-11`). Making destruction a deliberate two-command act rather than a flag is the point.

**An unmanaged binary is refused, not rewritten** (`src/cli/update.ts:99-111`). Hive never guesses that it owns a release binary outside its native version directory.

**Daemon auto-activation at quiescence is not built.** A staged update waits for a human to re-run `hive update`; the one-shot completion line from the design does not exist.

Activation is a machine-wide mutation. It holds the mutation lease, repeats the all-instance liveness check, and refuses while any instance has a live or unobservable team. Spawn and landing use the same coordinator, so a new operation cannot enter between the final check and the `current` change (`src/cli/update.ts:291-323`, `src/daemon/mutation-lease.ts:162-305`). The refusal names each blocking instance and the observed agent names or unknown marker (`src/cli/update.ts:224-231`). Downloading, signature verification, hashing, probing, and staging happen before that lease because they do not change the active install.

**Wire compatibility is not N/N−1.** The research doc promised "N/N−1 wire compatibility by policy"; `src/daemon/handshake.ts:13` is `{min: 1, max: 1}` — one wire version, refuse on mismatch. That is the conservative half of the contract and not yet the useful half.

## The ecosystem survey

Measured from source and live docs on 2026-07-10. This is the survey the design above is derived from, and it exists nowhere else in the repo.

**`gh` (GitHub CLI).** Checks in a **goroutine launched at command start** and prints to stderr **after the command finishes**, at most once per 24 hours via a persisted state file; skips CI, non-TTY output, and Codespaces entirely; silenced by `GH_NO_UPDATE_NOTIFIER`.

**npm.** Fires an unawaited best-effort check and saves the message "for printing at **process exit** so it will not get lost"; weekly for stable versions; **color-codes the notice by semver distance** (red major, yellow minor, cyan patch) and always prints the exact upgrade command. The `update-notifier` config key turns it off.

**`update-notifier`** (the package that set the convention). Checks in a **detached, unref'd child process** and shows the result on the **next** run; one-day default interval; `NO_UPDATE_NOTIFIER`, a `--no-update-notifier` flag, and automatic CI/test-env suppression. It **intentionally stopped auto-installing** after automatic mutation proved unpopular — see [distribution.md](distribution.md).

**Deno.** Delays its startup check by **500 ms** so it can never affect startup latency; caches 24 h; prints to stderr **only when stderr is a terminal**; `DENO_NO_UPDATE_CHECK`.

**Codex CLI.** A `version.json` in the Codex home stores `latest_version`, `last_checked_at`, and an optional `dismissed_version`, refreshed at most every **20 hours**; the network fetch is spawned in the background so startup always renders the previous cached answer. An unrecognized install method is left alone. Two notice forms exist: an interactive "Update available!" popup with "Update now / Skip / Skip until next version" (a persistent per-version dismissal), and a passive history line. One config key, `check_for_update_on_startup`, disables the lot.

**Claude Code.** Native install checks at startup and periodically while running; downloads and installs in the background; takes effect the next time you start. Two channels (`latest`, and `stable` ≈ one week behind, skipping releases with major regressions). **Two levels of off**: `DISABLE_AUTOUPDATER=1` stops background updates while manual `claude update` still works; `DISABLE_UPDATES=1` blocks everything, for organizations distributing through their own channels. And the detail worth copying outright: the managed-settings-only `requiredMinimumVersion`/`requiredMaximumVersion` gate startup and **deliberately fail open on invalid values, so a bad policy push cannot brick the tool.** Failure handling is modest: downloads retry up to **three attempts** on drops, stalls, and checksum failures, with a **ten-minute total deadline**; recovery is rerunning `claude update` or `claude install <version>`.

**The consensus, and the one gap.** Check asynchronously so the user's command is never slower; cache the answer for about a day; print one line to stderr at a natural boundary; gate on TTY and skip CI; name the exact native update command; provide one dedicated opt-out. **No vendor in this survey performs an automatic post-activation rollback** — they verify before activating and leave recovery to an explicit reinstall. Hive does revert on a failed health check, which is going beyond the precedent, justified because a daemon can be health-checked and a TUI cannot, and because a broken control plane strands a team rather than merely failing a command.

## Rejected alternatives

**A startup popup**, Codex-style. Codex owns its TUI and can ask a question. **Hive does not own the orchestrator terminal** — it belongs to Claude Code or Codex — and interrupting an agent session with Hive chrome is exactly the annoyance this design exists to avoid.

**A "you're N versions behind" counter.** Noise at a patch-per-push cadence.

**A vague "downloaded and verified" line.** Names no check, so it cannot be wrong; that is the defect, not the feature.

**Trust on first use.** Rejected outright: a pinned key is the entire point, and TOFU on an updater means the first fetch decides who owns the machine. See [versioning-and-release.md](versioning-and-release.md).

## Open decisions

1. **Security-notice severity source.** `securityCritical` is release-author judgment, grepped out of the GitHub release notes (`src/update/check.ts:134-138`), with no external check — and it overrides every rate limit and the skip list on every install. A second approver or a linked advisory is plausible; it is a process decision, not a code one.
2. **Beta-channel population.** The manifest carries `beta` from day one but nothing reads `channel`. Publishing a channel with one subscriber is ceremony; not publishing means the first channel switch happens untested.
3. **Post-activation confirmation placement.** The one-shot `hive updated to X` line assumes the next command comes soon after quiescent activation. Neither the line nor the quiescent activation exists yet.

## See Also

- [versioning-and-release.md](versioning-and-release.md) — the versioning contract; authoritative where this article and it disagree
- [distribution.md](distribution.md) — how the bytes get here and why Hive owns its native install
- [../daemon/database-resilience.md](../daemon/database-resilience.md) — what the daemon restart behind an activation must survive
- [../../SPEC.md](../../SPEC.md)
