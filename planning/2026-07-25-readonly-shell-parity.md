# Read-only shell parity: what each vendor's read-only posture actually permits

Investigation, 2026-07-25. Author: john. **No production behavior was changed.**
All live measurement ran in a throwaway git repo under the session scratchpad
(`…/scratchpad/probe`), against generated configs byte-identical to what Hive
writes.

Every claim below is labeled:

- **[MEASURED]** — I ran it and read the resulting state, not the actor's report.
- **[PRIOR-MEASURED]** — measured by an earlier agent, cited to the doc holding it.
- **[INFERRED]** — reasoning from code I read; no live observation.
- **[UNMEASURED]** — I could not measure it, and I say why.

CLI versions under test **[MEASURED]**: claude 2.1.220, codex-cli 0.145.0,
grok 0.2.112, kimi 0.29.1, opencode 1.18.5.

---

## Headline

The brief asks whether read-only agents should be *given* shell parity. The
measurements invert the question.

**Three of the five vendors already give read-only agents a shell — an
uncontained one — and Hive does not know it.** Codex is the only vendor whose
read-only containment I could measure as real.

| | reader has shell? | contained? |
|---|---|---|
| Codex | yes, by design | **yes — kernel-enforced [MEASURED]** |
| Claude (autonomous) | **yes, undocumented, via `Monitor`** | **no [MEASURED]** |
| OpenCode | **yes, undocumented, via `task` subagent** | **no [MEASURED]** |
| Kimi | **yes — Hive emits no restriction at all** | **no [MEASURED, `-p` path]** |
| Grok | no | rules hold; sandbox does not [PRIOR-MEASURED] |

So the problem is not that readers have too little capability. It is that
reader capability is **mislabeled and unenforced**. That changes the
recommendation (§5).

---

## 1. Per-vendor: what Hive emits, and what the vendor does with it

### Claude

**Hive emits** (`src/adapters/tools/claude.ts`):

- `readOnlyDeny = ["Edit", "Write", "NotebookEdit", "Bash"]` — `:562`
- autonomous reader (`dangerous`): `{ defaultMode: "bypassPermissions", deny: readOnlyDeny }` — `:574-581`
- attended reader: `{ defaultMode: "default", deny: attendedDeny, allow: ["Read","Glob","Grep","mcp__hive__*"] }` — `:582-598`, plus `--permission-mode default` on argv — `:288`

**Measured behavior**, autonomous posture (`bypassPermissions` + that deny list):

- `Bash` is **removed from the tool list**, not refused. Reported tool set:
  `Agent, Glob, Grep, Read, ReportFindings, ScheduleWakeup, Skill, ToolSearch,
  Workflow, Monitor, PushNotification, TaskOutput, CronCreate, WebFetch`.
  `ToolSearch("select:Bash")` → `No matching deferred tools found`. **[MEASURED]**
- The deny **does** propagate to subagents: a `general-purpose` subagent
  reported no Bash and created nothing. **[MEASURED]**
- The deny **does** propagate to `Workflow` subagents: exact error returned was
  `No such tool available: Bash. Bash exists but is not enabled in this context.` **[MEASURED]**

**…and then the escape.**

- **`Monitor` is not in the deny list, and `Monitor` takes an arbitrary shell
  `command`.** Its own schema says: *"The script runs in the same shell
  environment as Bash."* Called with
  `command: 'touch M1.txt && echo "M1 created"'`, it ran with **no permission
  prompt**, emitted `M1 created`, and `M1.txt` was verified on disk by me
  out-of-band. **[MEASURED]**
- This is what produced a mutation on my very first probe before I was looking
  for it: the agent reported `"mutate": "ok"` and the file was there.
- `CronCreate` was also accepted with no prompt, scheduling a future session
  whose posture is not the reader's. The job did not fire inside the probe
  window, so what that session's tool surface would be is **[UNMEASURED]**.

**Fix, verified**: adding `"Monitor"` to `readOnlyDeny` removes it by the same
mechanism as `Bash` — `ToolSearch("select:Monitor")` → `No matching deferred
tools found`, and the escape file was absent. **[MEASURED]**

**Scope caveat, and it matters**: the escape is measured under
`bypassPermissions`, i.e. the **`dangerous`/autonomous** reader. The attended
reader gets `--permission-mode default` with an allow list that does not
contain `Monitor`, so `Monitor` should raise a prompt rather than run
**[INFERRED from `:582-598`, not measured]**. Note the second-order problem:
an unanswered prompt in an unattended agent is the exact failure the comment at
`:282-287` records as already having bitten once ("the first WebFetch raised a
dialog no one was watching").

### Codex

**Hive emits** (`src/adapters/tools/codex.ts:130-137`): `--sandbox read-only`,
or `-c sandbox_mode="read-only"` on the resume path. Dangerous autonomy may add
`-c approval_policy="never"` but never changes `sandbox_mode`.

**Measured behavior** — the reader **keeps its shell** and the sandbox is real:

| probe | result |
|---|---|
| `git log --oneline -1` | ran, real output **[MEASURED]** |
| `touch /tmp/…` | `Operation not permitted` **[MEASURED]** |
| `touch $HOME/…` | `Operation not permitted` **[MEASURED]** |
| `echo x > a.txt` (in workspace) | `zsh:1: operation not permitted: a.txt` **[MEASURED]** |
| `git checkout -- a.txt` (dirty file) | `fatal: Unable to create '…/.git/index.lock': Operation not permitted` **[MEASURED]** |
| `git reset --hard HEAD` | same `index.lock` failure **[MEASURED]** |
| `git stash` | same, plus `could not write index` **[MEASURED]** |
| `curl https://example.com` | HTTP code `000` — blocked **[MEASURED]** |
| `rm -f a.txt` | rejected **before process creation** by Codex's own command policy: `rm -f style commands are not permitted` **[MEASURED]** |
| `git config --global --get user.name` | **succeeded** — reads escape the workspace **[MEASURED]** |

The destructive-git test is the decisive one and I verified it out-of-band: I
dirtied `a.txt` with `UNCOMMITTED WORK THAT MUST NOT BE LOST`, and after all
three destructive commands the file still contained that string and `git status`
still showed ` M a.txt`. I did not take the agent's word for it.

Network positive control: the same `curl` from my own unsandboxed shell in the
same directory returned `200`, so `000` is the sandbox and not a dead network.
**[MEASURED]**

### Grok

**Hive emits** (`src/adapters/tools/grok.ts:53-54`, `:139-148`):
`--deny Bash --deny Write --deny Edit --allow MCPTool --allow Read --allow Grep`.

**I could not re-measure the live tool surface.** `grok -p` returned
`API error (status 402 Payment Required): Grok Build usage balance exhausted`.
**[MEASURED — the blocker, not the behavior]**

Relying on prior measurement in `docs/providers/grok.md`:

- Rule names are Claude Code prefixes that bind Grok's *differently-named*
  native tools: `--deny "Bash"` binds `Shell` (composer) and
  `run_terminal_command` (grok-4.5). So the reader has no shell.
  **[PRIOR-MEASURED, grok.md:56-60]**
- A `--deny` match is a **clean refusal** — the model absorbs it and the turn
  completes. Unlike Claude/OpenCode, the tool is not silently removed.
  **[PRIOR-MEASURED, grok.md:72]**
- **`--sandbox` is not a write barrier on macOS.** `--sandbox read-only`
  registered in `summary.json` and the Write tool still *created a file in CWD,
  verified on disk*. Child-network blocking is likewise a no-op.
  **[PRIOR-MEASURED, grok.md:84]**

I did confirm the sandbox profile *names* exist: `workspace`, `read-only`,
`readonly`, `strict`, `none` are all accepted, while `full` errors with
`Custom sandbox profile 'full' not found`. Hive uses none of them. **[MEASURED]**

### Kimi

**Hive emits: nothing.** `kimiPermissionArgs` returns `[]` for the read-only
case (`src/adapters/tools/kimi.ts:75-79`). The read-only posture is Kimi's
*default* `manual` mode, i.e. an interactive approval prompt — not a deny list,
not a sandbox.

**Measured** (`kimi -p`, no flags, the exact argv shape minus interactivity):

- Tool list includes `Bash`, `Edit`, `Write` — full surface. **[MEASURED]**
- `git log --oneline -1` ran. **[MEASURED]**
- `touch MUTATED.txt` **succeeded and the file was verified on disk by me.** **[MEASURED]**

**Honest limit**: Hive launches Kimi *interactively* — `kimiLaunchArgs`
(`kimi.ts:81-88`) never passes `-p`. So the production path is Kimi's
interactive `manual` mode, which I could not exercise without a TTY.
**[UNMEASURED]** What is certain either way: **Hive emits no enforcement for a
read-only Kimi agent.** The only barrier is a human answering a dialog.

The user has no `~/.kimi/config.toml` **[MEASURED]**, so no
`default_permission_mode = "yolo"` override is in play today — but the adapter's
own comment (`kimi.ts:61-68`) concedes that such a config would silently make a
Hive "read-only" Kimi agent fully autonomous, and that Kimi offers no flag to
force manual back on.

### OpenCode

**Hive emits** (`src/adapters/tools/opencode.ts:178`):
`permission: { edit: "deny", bash: "deny" }`, **scoped to the Hive agent entry**
inside `opencode.json`.

**Measured behavior** — the brief's premise is confirmed at the top level:

- Reported tool set is exactly
  `glob, grep, read, skill, task, todowrite, webfetch` (plus
  `multi_tool_use.parallel`). No shell. `bash: "deny"` removes the tool rather
  than refusing calls. **[MEASURED — this reproduces the finding that was
  mistaken for a vendor defect]**

**…and then the escape.**

- The `task` tool spawns a **"General Agent" subagent that has bash.** Asked to
  delegate `touch OC_ESCAPE.txt`, the subagent reported
  `Had a shell/bash tool: yes`, returned `OC_OK`, and **`OC_ESCAPE.txt` was
  verified on disk by me.** **[MEASURED]**
- The agent-scoped `permission` block binds only the named primary agent. One
  `task` hop restores a full shell *and* write.

**Fix, verified**: writing the same `permission` block at the **config top
level** (alongside, not instead of, the agent-scoped one) closes it — the
subagent reported "could not run it" and the escape file was absent.
**[MEASURED]**

---

## 2. Which vendors give readers a shell, and is there a middle setting?

**Shell today**: Codex (by design), Claude-autonomous (via `Monitor`, unintended),
OpenCode (via `task`, unintended), Kimi (nothing stops it). Not Grok.

**Middle setting — permitting non-mutating commands while blocking mutating ones:**

| vendor | middle setting? | evidence |
|---|---|---|
| **Codex** | **Yes, and it is the real thing.** The sandbox permits any command whose *effects* are reads and blocks writes at the kernel boundary — no command parsing involved. | **[MEASURED]**, §1 |
| **OpenCode** | **Yes, measured working.** A `bash` **pattern map** with allow patterns and **no `"*"` catch-all** keeps `functions.bash` present: with `{"git log*":"allow","git status*":"allow","touch*":"deny"}` the agent listed `functions.bash`, ran `git log --oneline -1` (`894b605 seed`), and `OC_MID3.txt` was **absent**. With a `"*": "deny"` catch-all the tool is removed entirely, exactly like `bash: "deny"`. | **[MEASURED]** |
| **Claude** | **No, not in the autonomous posture.** `deny` removes the tool outright, and under `bypassPermissions` there is no prompt left for a scoped `Bash(git log:*)` allow rule to gate. The code says this itself at `claude.ts:566-572`. It is all-or-nothing: no shell, or a full unprompted one. | **[MEASURED]** + code |
| **Grok** | Rule layer is tool-name-prefix based and its granularity for `Bash(...)`-style scoping is **[UNMEASURED]** (402). Its sandbox is **[PRIOR-MEASURED]** non-enforcing on macOS, so any middle setting would be rule-layer only. | grok.md:56-60, :84 |
| **Kimi** | **No per-launch channel exists.** `[[permission.rules]]` live only in the global `config.toml`, which Hive does not write and, per its own rule, must not. | `kimi.ts:61-68` |

The important asymmetry: **only Codex's middle setting is enforced below the
model.** OpenCode's and Grok's are the vendor's own string matching.

---

## 3. Blast radius

The brief asked for the blast radius *of granting* parity. The measurements say
most of that radius is **already live** on three vendors. I enumerate it as it
stands today.

### The shared substrate

A reader's worktree `.git` is a pointer file:
`gitdir: /Users/scottkellar/Projects/hive/.git/worktrees/john` **[MEASURED]**.
That is a **shared object store and a shared `refs/` namespace**. At the time of
measurement, eight worktrees were live under it, including five active agents
(`amber-assess`, `c13`, `cluster-verify`, `david`, `john`) **[MEASURED]**.

Any uncontained shell in *any* worktree can therefore reach *every* agent's work.

### What a determined-but-not-malicious reader can do

On **Claude-autonomous (via `Monitor`)**, **OpenCode (via `task`)**, and **Kimi**
— all uncontained **[MEASURED]**:

1. **Destroy its own uncommitted work** — `git checkout -- .`, `git reset --hard`,
   `rm -rf`. SPEC decision 3's guarantee that work is "merged, intentionally
   preserved, or explicitly surfaced, never silently lost" has no mechanism
   behind it here.
2. **Destroy other agents' work** — `git -C <repo> branch -D <other>`,
   `git update-ref -d refs/hive-preserved/<branch>` (the preservation escape
   hatch itself), `git worktree remove --force <other-agent>`. Nothing in the
   worktree model isolates refs.
3. **Rewrite the posture of the next agent** — `$HOME` is writable:
   `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.hive/`, shell rc files.
   A "read-only" agent can edit the file that decides what read-only means.
4. **Reach the outside world** — unrestricted `curl`, `gh`, `git push`. Combined
   with (5), that is an exfiltration path.
5. **Read anything the user can read** — this is true on **every vendor
   including Codex** (Codex read `~/.gitconfig` **[MEASURED]**). `~/.ssh`,
   `~/.aws`, token files. Read-only never meant confidential.
6. **Run arbitrary repo-authored code** — `bun run <script>`, `npm test`. This is
   the one that breaks allowlists specifically: a script runner is a
   *non-mutating-looking command name* that executes whatever the repo says.

### Does Codex's sandbox actually contain those, or merely appear to?

**It actually contains them, for writes and for network.** Not by parsing
commands — by refusing the syscall. `git reset --hard` does not get argued with;
it fails to create `index.lock`. I verified the surviving file contents myself
rather than believing the agent's report. **[MEASURED]**

Three honest limits on that containment:

- **Reads are not contained.** The whole filesystem is readable. **[MEASURED]**
- **Codex's `rm -f` block is a *different*, weaker layer** — a command-string
  policy that fires before process creation, not the sandbox. Do not credit the
  sandbox for it. **[MEASURED]**
- **A "sandbox" flag is not evidence.** Grok's nominally equivalent
  `--sandbox read-only` was measured **not** to bind: the flag registered in
  `summary.json` and a file was created in CWD anyway **[PRIOR-MEASURED,
  grok.md:84]**. Codex's containment is credible because it was measured, not
  because it is named "sandbox".

### The blast radius that parity would *add*

Given the above, a non-mutating allowlist on Claude/OpenCode/Grok would add
almost nothing to the *ceiling* — it would mostly formalize access those readers
can already reach. What it would add is a **false floor**: a barrier made of
string matching (`git log --oneline -1; rm -rf .`, backtick substitution,
`bun run`) presented as a safety property. On Codex, parity adds nothing at all,
because Codex already has it.

---

## 4. Cost of implementing parity, per vendor

| vendor | where it lands | cost |
|---|---|---|
| **Codex** | nowhere | **zero — already done** |
| **OpenCode** | `opencode.ts:178` — swap `bash: "deny"` for a pattern map, no `"*"` catch-all; **and** hoist the block to top level or subagents bypass it | **small**, ~5 lines, mechanism measured working |
| **Claude** | `claude.ts:562`, `:574-598`, `:282-291` | **large and risky.** Autonomous readers would have to leave `bypassPermissions` for `--permission-mode default` + an allow list, because under bypass there is no prompt to scope. That reintroduces the unanswered-dialog hang the code comment at `:282-287` records as already fixed once. Days, with a known-bad failure mode. |
| **Grok** | `grok.ts:53-54` | **unknown — unmeasurable today** (402 quota). Sandbox layer is measured non-enforcing, so rule-layer only. |
| **Kimi** | nowhere reachable | **blocked, not expensive.** The only channel is the user's global `config.toml`, which Hive must not write (SPEC decision 4: "whatever cannot be scoped to a Hive worktree, Hive does not touch"). |

Unbudgeted shared cost: on Claude, OpenCode and Grok the barrier would be the
vendor's own rule engine, so Hive would own an allowlist whose failure mode is
silent and whose maintenance is per-vendor and per-vendor-version.

---

## 5. Recommendation

**Do not build parity. Route read-only investigation to Codex. Land two
one-line containment fixes so "read-only" stops being a false label.**

Reasoning:

1. **The premise is half-wrong in a way that reverses the priority.** Readers on
   Claude-autonomous and OpenCode already have a shell — an uncontained one.
   Widening a grant that is already leaking is the wrong order of operations.
   Make the label true first.
2. **Codex already delivers exactly what parity was meant to buy**, and it is the
   only vendor whose containment I could measure as real. It costs nothing:
   Codex is already reader-only by design in Hive
   (`docs/providers/launch-mechanics.md:87`, `:127`).
3. **Parity elsewhere buys a string-matching barrier sold as a safety property.**
   That is the precise shape `grok.md:84` already burned this repo on:
   *"Treat `--sandbox` as unproven defense-in-depth, never as the enforcement
   layer."*
4. **The two fixes are one line each and both are measured to close their escape:**
   - `src/adapters/tools/claude.ts:562` — add `"Monitor"` to `readOnlyDeny`.
   - `src/adapters/tools/opencode.ts:178` — write the same `permission` block at
     the config **top level**, not only under the Hive agent entry.
5. **Kimi read-only should be treated as unenforced.** That is a routing and
   labeling decision, not a code fix — Hive's own rule forbids writing the
   user's Kimi config. Either stop routing read-only work to Kimi, or record in
   the vendor matrix that Kimi read-only is advisory only.
6. **If a reader later genuinely needs a shell on OpenCode specifically**, the
   cheapest honest step is OpenCode's pattern map (measured working, §2) — one
   vendor, one config shape. Not a cross-vendor permission framework, not a
   capability DSL, not an allowlist engine. Those are unjustified today and the
   evidence above does not move toward them.

What I am **not** recommending, explicitly: any per-command allowlist on Claude
or Grok. On Claude it requires a posture redesign with a known-bad failure mode;
on Grok it cannot be measured right now; on both, the barrier would be advisory.

---

## 6. Doc divergences found

The repo's design docs state intent in the same voice as measured fact. Three
divergences:

1. **`SPEC.md:117` (Decision 4) — refuted on three vendors.** It states: *"a
   reader keeps its deny list or read-only sandbox, and the read-only
   replacement a critical control spawns cannot regain shell access through a
   config default."*
   - Claude: `Monitor` regains an unprompted shell *despite* the deny list. **[MEASURED]**
   - OpenCode: `task` regains a full shell *despite* the deny. **[MEASURED]**
   - Kimi: there is no deny list to keep, and a config default
     (`default_permission_mode`) is precisely what would govern it — the
     adapter's own comment at `kimi.ts:61-68` concedes this, contradicting SPEC.
2. **`SPEC.md:115` (Decision 3) — stale.** It states *"readers share the main
   checkout."* Worktree creation is unconditional (`spawner-impl.ts:2716`) and
   the reader's row takes `worktreePath: worktree.path` (`:2815`). Readers get
   their own worktree and branch. **[MEASURED in code]** Reality is *safer* than
   the doc here — but the doc is still wrong, and §3's shared-refs analysis
   depends on getting this right.
3. **`docs/daemon/authorization.md` — no divergence.** Its reader row governs the
   *control plane* (`branch:land` and `memory:write` denied, `:30`) and is
   correctly silent on the vendor shell. Its Summary (*"every agent it spawns
   runs as the same UID with a shell"*, `:8`) and §*"The sandbox is not the only
   way out, so the gate is not only in the broker"* (`:95`) are both consistent
   with everything measured here. That section's rule — *"'the sandbox contains
   it' is only true of things that run in the sandbox"* — is the general form of
   the `Monitor` and `task` escapes.

---

## 7. What I could not measure

Stated plainly rather than inferred around:

- **Grok's live read-only tool surface** — `grok -p` returns HTTP 402, balance
  exhausted. Grok rows rely on prior measurement in `docs/providers/grok.md`.
- **Kimi's interactive `manual` mode** — the production launch path. Needs a TTY;
  only the `-p` path was exercised.
- **Claude's attended-reader posture vs. `Monitor`** — inferred from the allow
  list at `claude.ts:582-598`, not run.
- **What a `CronCreate`-scheduled Claude session inherits** — the job did not
  fire inside the probe window.
- **Reproduction inside a real Hive-spawned agent** — I hold a writer capability,
  and writers hold no `agent:spawn` (`authorization.md:45`); `hive_spawn`
  returned `Role writer may not agent:spawn`. Every escape above was measured
  against the exact config bytes Hive writes, with the same CLI versions, in a
  scratch repo. Config equivalence is **[MEASURED]**; that production agents
  behave identically is **[INFERRED]** — high confidence, but not observed.
  Closing that gap needs one Hive-spawned read-only Claude agent and one
  OpenCode agent asked to call `Monitor` / `task`.
