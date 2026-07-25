# Independent review: worktree wiring exclusion

- Reviewed commit: `1852699b24ff6b943114fc30d4e84b1e612d200e`
- Parent: `04a1df2f831f7295e497b29fcf3471ea555f8da3`
- Footprint: `src/adapters/worktrees.ts`, `test/adapters/worktrees.test.ts`
- Verdict: **REQUEST CHANGES**

## Critical — tracked credential files bypass the exclusion

**Files:** `src/adapters/worktrees.ts:346-360`, `src/adapters/tools/kimi.ts:189-209`, `src/adapters/tools/grok.ts:239-267`, `src/adapters/tools/opencode.ts:153-199`, `src/adapters/tools/codex.ts:542-557`

**What it does:** The new `core.excludesFile` contains exact paths for the Kimi, Grok, OpenCode, and Codex credential-bearing artifacts. This protects an untracked file from an ordinary `git add -A`.

**Why it is wrong:** Ignore rules never apply to a path already tracked by the arbitrary user repository. Hive merges into or overwrites these project files, so a normal `git add -A` stages the live credential when, for example, the project already tracks `.kimi-code/mcp.json`. I reproduced this in a neutral repository: after configuring the landed exclusion and writing `Authorization: Bearer LIVE_SECRET` into an already tracked `.kimi-code/mcp.json`, `git status` reported `M .kimi-code/mcp.json` and `git diff --cached` contained the bearer after `git add -A`. The same class applies to tracked `.grok/config.toml`, `opencode.json`, and `.codex/capability-token`. A preserved branch retains any credential already committed to it.

This is the most important finding: the stated credential-to-commit route remains open without `-f`, without a helpful `.gitignore`, and without unusual agent behavior.

**Concrete corrected version:** Before writing any secret-bearing worktree artifact, run `git ls-files --error-unmatch -- <exact-path>`. Refuse the spawn with an actionable error if the path is tracked; do not write a live token into a tracked project file. Longer term, move credentials outside the worktree and use a provider helper/environment indirection where the provider supports one, as Claude already does. Keep the exact-path exclusion as defense in depth for genuinely untracked artifacts, not as the credential boundary.

## Critical — enabling `worktreeConfig` can redirect Git away from the agent worktree

**File:** `src/adapters/worktrees.ts:350-360`

**What it does:** Every spawn unconditionally changes the repository-wide `extensions.worktreeConfig` to `true`.

**Why it is wrong:** Git explicitly warns that enabling this extension changes the meaning of common `core.worktree` and `core.bare`; those settings must first be moved into the main checkout's `config.worktree`. The landed code neither detects nor migrates them. This is not theoretical. In a repository with a common `core.worktree` and a tracked `.gitignore` containing `.hive/`, I called the landed `createWorktree`, wrote `agent-work.txt` in the linked worktree, and observed:

```text
git -C <linked> rev-parse --show-toplevel  -> <main checkout>
git -C <linked> status --short -uall       -> empty
assessStrandedWork(...)                    -> {"dirtyFiles":[],"unmergedCommits":0}
```

The deletion guard can therefore authorize removal while real agent work exists. Repositories with `extensions.worktreeConfig=false` are also silently changed to `true`; a differently configured user is not preserved. An already valid `true` setting works.

The official [`git-worktree` documentation](https://git-scm.com/docs/git-worktree.html#_configuration_file) names this migration requirement.

**Concrete corrected version:** Before enabling the extension, read its effective value and the common `core.worktree`/`core.bare` settings. If the extension is not already enabled and either sharp-edge setting exists, refuse worktree creation with an actionable diagnostic. Do not silently rewrite those user-owned settings. Add the exclusion only after the repository passes that preflight. This is smaller and safer than implementing an automatic configuration migration.

## High — the original stranded-work bug still occurs in a neutral repository

**Files:** `src/adapters/worktrees.ts:521-533`, `src/daemon/spawner-impl.ts:2797`, `src/adapters/skills.ts:252-278`

**What it does:** `HIVE_WORKTREE_WIRING` enumerates provider config files, while every normal spawn subsequently calls `provisionSkills`, which writes shipped `SKILL.md` files into the worktree.

**Why it is wrong:** Those files are Hive spawn artifacts too, but none is in the list or generated exclude file. The committed tests pass because this repository's `.gitignore` ignores `.claude/`, `.agents/`, and `.opencode/`; Hive must work without those repository-specific rules. I created a blank Git project with no `.gitignore`, then ran the landed `createWorktree` plus the production `provisionSkills` for each provider. Every provider still had stranded work immediately:

- Claude: four `.claude/skills/*/SKILL.md` files.
- Codex: four `.agents/skills/*/SKILL.md` files.
- Grok: four `.agents/skills/*/SKILL.md` files.
- Kimi: three `.agents/skills/*/SKILL.md` files.
- OpenCode: three `.opencode/skills/*/SKILL.md` files.

`assessStrandedWork` returned those exact paths in all five cases. Thus the claimed teardown fix is incomplete on arbitrary projects.

**Concrete corrected version:** Include exact shipped-skill file paths in the owned-artifact set, derived from `nativeSkillDirectory` and `shippedSkillsFor` rather than copied into another hand-maintained list. If provisioned user-skill symlinks are also meant to be Hive-owned spawn artifacts, have `provisionSkills` return the exact links it created and persist that exact-path manifest in the linked worktree's Git metadata. Do not exclude whole skill directories; that would hide agent-authored work.

## High — Git 2.19 silently leaves credentials unprotected

**File:** `src/adapters/worktrees.ts:350-361`

**What it does:** The code treats every Git step as best-effort and ignores the result of `git config --worktree`.

**Why it is wrong:** Worktree-specific config arrived in Git 2.20. I built Git 2.19.2 and ran the landed command sequence. `rev-parse --absolute-git-dir` and setting `extensions.worktreeConfig=true` both succeeded, but `git config --worktree ...` exited 129 with `unknown option 'worktree'`. The repository and worktree remained usable, while `git status` exposed `.kimi-code/` and `git add -A` could stage it. This verifies the narrow usability claim but disproves the security behavior on an old Git. The extension is present in the [Git 2.20.0 source](https://github.com/git/git/blob/v2.20.0/Documentation/git-worktree.txt) and absent from the [Git 2.19.2 source](https://github.com/git/git/blob/v2.19.2/Documentation/git-worktree.txt).

The swallowed final exit status also makes any other configuration failure indistinguishable from successful protection.

**Concrete corrected version:** Preflight `git config --worktree` support before writing a live credential, and verify the installed `core.excludesFile` value afterward. For token-bearing providers, failure must refuse the spawn or select a credential channel outside the worktree; it cannot be best-effort. Non-secret status cleanup may still degrade best-effort.

## High — recovery and existing worktrees never receive the protection

**Files:** `src/adapters/worktrees.ts:414`, `src/daemon/recovery.ts:676-779`, `src/daemon/spawner-impl.ts:1713-1747`

**What it does:** The exclusion is installed only in `createWorktree`. Crash recovery and critical-control restart reuse an existing worktree and rewrite provider configs directly.

**Why it is wrong:** There is no second production `git worktree add` path, so new worktrees go through `createWorktree`; however, recovery is precisely a path that can write or preserve credential-bearing configs in a worktree that predates this commit. Critical-control restart can also mint a new capability and call `prepareSpawn` on that existing worktree. Neither path ensures the exclusion. An untracked token file in such a worktree remains eligible for ordinary `git add -A`.

This makes the non-retroactive behavior a real exposure, not cosmetic. It also means upgrading Hive does not protect already running agents until their worktrees are destroyed and recreated.

**Concrete corrected version:** Make the operation an idempotent `ensureHiveWiringExcluded` and invoke it before every provider config write on spawn, recovery, and control restart. At daemon startup, apply it to recorded live worktrees before allowing resumed token-bearing providers to run. Verification failure must follow the secret-bearing failure policy above.

## Medium — the worktree override makes the user's excludes file ineffective

**File:** `src/adapters/worktrees.ts:356-360`

**What it does:** A worktree-scope `core.excludesFile` overrides the repository/global `core.excludesFile` with `hive-exclude`.

**Why it is wrong:** The user's configured value remains stored and still applies in the main checkout, but it is clobbered as the effective value in the Hive worktree. I configured a personal excludes file containing `personal.tmp`; after the landed setup, `personal.tmp` was ignored in main but appeared untracked in the linked worktree. This can again create false stranded-work reports and changes the agent's ordinary Git behavior.

**Concrete corrected version:** Build the worktree exclude file from Hive's exact paths plus the contents of the previously effective excludes file, recording its source and regenerating when the worktree is ensured. At minimum, detect a pre-existing effective value and fail visibly rather than silently replacing its behavior.

## Medium — the owned-path contract is still hand-maintained and has already drifted

**Files:** `src/adapters/worktrees.ts:510-533`, `src/adapters/tools/agents/agent-adapter.ts:38-44`

**What it does:** One private array restates filenames chosen independently by five provider writers and the Kimi instruction wrapper.

**Why it is wrong:** Cross-checking the five `write*AgentConfig` functions shows that the current config-file entries themselves are complete, and the current strings are exact. But the broader spawn pipeline already disproves the comment that these are every file Hive writes. The same hand-maintenance failure that motivated this commit remains structurally possible.

Hand-maintenance is not acceptable here: omission directly changes the recovery/deletion decision and this commit demonstrates both past and current drift.

**Concrete corrected version:** Define provider-owned path constants once and use them both to construct writer destinations and to populate an `ownedWorktreePaths` contract on each adapter. Aggregate the union for worktree creation. Derive shipped-skill paths from their existing registry. This is a justified source-of-truth boundary because it preserves recovery evidence; it is not speculative generality.

## Medium — an existing Grok config can remain world-readable

**File:** `src/adapters/tools/grok.ts:261-267`

**What it does:** Grok writes a bearer token with `writeFile(..., { mode: 0o600 })`.

**Why it is wrong:** `mode` applies only when a file is created. Unlike Kimi, OpenCode, and Codex, Grok does not follow the write with `chmod(0o600)`. If the arbitrary project already has a mode-0644 `.grok/config.toml`, Hive writes the live bearer into a file still readable by other local users. Git exclusion does not address file permissions.

**Concrete corrected version:** Apply `chmod(path, 0o600)` after every successful Grok config write, including the remaining-content branch of `removeGrokAgentConfig`, matching the other token-bearing writers.

## Low — the test does not enforce the exact-path invariant

**File:** `test/adapters/worktrees.test.ts:463-475`

**What it does:** The test proves only that `.kimi-code/notes.md` remains visible beside the excluded `.kimi-code/mcp.json`.

**Why it is wrong:** The landed list currently contains no directory, trailing-slash, or glob pattern, so the invariant holds today. The test would still pass if a future entry changed `.grok/config.toml` to `.grok/`, or `.claude/settings.local.json` to `.claude/*`; it does not inspect the generated pattern set and exercises only one parent directory.

**Concrete corrected version:** Read the generated `hive-exclude` in the test and assert every line is root-anchored, has no glob metacharacters, and does not end in `/`. Add sibling files under each owned parent directory and assert all remain visible. Keep the existing Kimi behavioral case as the regression example.

## Categories with no additional finding

- **Over-engineering:** No finding. The worktree-scoped exclusion corrects the recovery/deletion evidence that decides whether work is preserved, so it passes §1's test. The dedicated per-worktree file and exact patterns are proportionate; no addition in the footprint fails all three allowed justifications. The problems are unsafe prerequisites and incomplete coverage, not needless abstraction.
- **Main-checkout isolation:** Verified on Git 2.55.0. The linked worktree reads its own `config.worktree`; the same artifact name remains visible in main. The new test correctly covers one positive case.
- **Exact-path safety in the landed code:** Verified. All eleven entries are root-relative exact file paths; none is a directory or glob.
- **Provider config completeness:** Verified for the five `write*AgentConfig` writers and Kimi's `AGENTS.md` wrapper. No config artifact is missing from the eleven entries. The separate shipped-skills finding covers the broader spawn pipeline.
- **Other token channels:** No token appeared in provider argv or launch commands in the inspected paths. Claude uses an external credential helper; new Kimi, OpenCode, and Codex token files are forced to `0600`. The Grok exception is reported above. No additional token logging sink was found.

## Validation

- `bun test test/adapters/worktrees.test.ts`: **20 pass, 0 fail**.
- `bun test`: **1725 pass, 12 skip, 1 todo, 10 fail, 1 error**. Eight failures are the stated pre-existing embeddings/Graphify/episodic-store baseline. Two unrelated five-second CLI timeouts (`init` shared skills and `uninstall` spawn race) both passed immediately when rerun alone; neither touches the review footprint. The separately known red `test:sessiond` live-create path was not exercised by this command.
- Neutral-repository, tracked-token, inherited-excludes, common-`core.worktree`, and Git 2.19.2 behaviors were reproduced independently as described above.
