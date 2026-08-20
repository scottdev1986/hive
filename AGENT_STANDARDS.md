# Hive agent standards

Every section an agent is given ships in its spawn prompt as the section's `##`
heading followed by the body under it — not body alone. The heading is part of
what ships, so an agent can cite a rule by section name even when the body does
not restate the title. Edit the prose here; nothing about these rules lives in
the daemon source. A spawn reads this file, so an edit reaches the next agent
spawned — no build, no promote, no restart.

This file also decides which sections reach whom. The block below names every
section and the audience it is written for; the daemon knows only how to route
to those audiences, never which sections exist here. Add a section by writing
its `##` heading and adding a line here — no code change, no build, no restart.

```standards
Coding guidelines: everyone
Hive protocol: everyone
Deletion and consolidation: everyone
Measurement and baselines: everyone
Search hygiene: everyone
Documentation conventions: everyone
Skill bindings: everyone
Service boundaries: writers
QA and environment flags: writers
Read-only agents: read-only
Writer agents: writers
Code review: category code_review
```

An audience is `everyone`, `writers`, `read-only`, or `category <name>` naming
one routing category.

Sections reach an agent in the order this file lists them, not the order of the
block above. Moving a section without changing a word of it is therefore a real
change: the prompt differs, and the standards digest an agent carries differs
with it.

The block and the `##` headings are the contract between this file and the
daemon, and they must agree. A section declared here but missing or empty
below, a section below that nobody declared, or an audience that cannot be
routed all fail the next spawn with an error naming the section — deliberately,
because an agent running without its standards and nobody noticing is worse
than a spawn that refuses. Notes to user readers belong in prose like this,
above the first heading, or under a deeper `###` heading inside a section — but
remember that a `###` line ships to the agent along with the rest of its
section.

Two things worth knowing before you edit. Every section is a rewrite of a
longer skill: the narration and worked examples stay in the skill for the agent
that wants them. When a skill conflicts with this live standard, this standard
takes precedence; a revision may retire a conflicting skill rule. The Hive
protocol section carries only rules with nowhere else to live — mail lane and
settlement semantics are enforced at the mailbox itself, so asking an agent to
remember them here would buy nothing.

## Coding guidelines

Coding guidelines (these are not optional; the karpathy-guidelines skill holds the long form):
1. Think before coding. State your assumptions; if you are uncertain, ask. If a request has several readings, present them — never pick one silently. If a simpler approach exists, say so and push back. If something is unclear, stop and name it.
2. Simplicity first. Write the minimum code that solves the problem and nothing speculative: no features beyond what was asked, no abstractions for single-use code, no unrequested flexibility or configurability, no error handling for impossible cases. If it is 200 lines and could be 50, rewrite it. Ask: would a senior engineer call this overcomplicated?
3. Surgical changes, eyes open. Touch only what you must: do not 'improve' adjacent code, comments, or formatting, do not go hunting for work, and match the existing style even where yours differs. But the test is 'not broken', not 'not mine' — two things you meet on the way are part of the job, not a distraction from it. Genuine redundancy in your path — several ways of doing one thing, logic duplicated across code you had to open anyway — gets consolidated, because divergent implementations of one thing hide bugs: one copy gets fixed and the others keep the defect. A bug you discover gets fixed, not merely reported. Both stop at the same line: it must be code the task already put in front of you, the fix must fit the diff a reviewer is reading anyway, and it must not change behaviour the task never asked about. A format or lint refusal this repo's verification names is the tool's own edit — fix it as its own commit even if the file was not in the story; that is not hunting and not a scope expansion. If it is larger than the task, reaches another agent's files, or changes behaviour outside your task, report it to queen — what you found and where — and do not start the refactor. Unrelated dead code you never had to open is still mentioned, not deleted. Remove only the orphans your own change created. Every changed line must trace to the request, or to something you had to touch to fulfil it.
4. Goal-driven execution. Turn the task into a verifiable goal before you start ('fix the bug' → 'write a test that reproduces it, then make it pass'), and state a brief plan whose every step names its check. Loop until verified.
5. Keep separation of concerns. Each module, function, and change should have one clear job; put behavior at its owning boundary instead of coupling unrelated concerns.
6. Comments refer only to code, never to documents. A code comment must carry its own explanation instead of depending on a plan, ticket, or external account that can drift away.
7. One way to do a thing. Plural mechanisms for one job are this repo's recurring defect, and none of them retires the others: when you find yourself adding a second, the correct move is usually to fix or delete the first, because a change that leaves the old path in place 'for compatibility' has added a way rather than replaced one. Build no preservation machinery whose lost data you cannot name — no backups on backups, no dual writes, no shadow tables, no flags around reversible changes; git history is already the archive for anything committed. A good proposal here has fewer files, fewer concepts and fewer entry points than before, and says plainly what it deletes to pay for any it adds. Simple is never unverified: red-then-green, mutation-proving a new test, and positive controls all stay.
These bias toward caution over speed; on a trivial task, use judgment.

## Hive protocol

Hive protocol (non-negotiable):
1. An absent field is unknown, never false. A missing or misspelled key does not raise — it reads back as "no". Before trusting a negative, prove your reader can see a positive (a positive control): an all-empty result is usually a bad key, not an empty world.
2. Measure, do not infer. Never accept an ACT as proof of a STATE: "the command exited 0" is not "the message was received"; "the skill shipped" is not "the agent read it"; "the screen redrew" is not "the agent is alive". Read the thing that records the state.
3. Never run `make clean`, `make build`, or `make run`; use the repository's narrower commands instead.
4. Skills live in the primary checkout, not an agent worktree. Resolve and read them there.
5. Full deliverables go into the artifact store, not into mail. Store reports, designs, reviews, and findings with `hive_artifact_put` keyed to your board task or run; your mail to queen carries the `artifactId` plus a short summary, never the full body. Settled mail bodies cannot be read again — an artifact can. Status, completions, and measurements go on the work lane; the control lane is for a design fork, a scope change, a rebase conflict, or an irreversible destroy/salvage decision. Do not wait for GO or a reply to status.

## Deletion and consolidation

Deletion and consolidation (each of these caught a real break in a single packet):
1. Trace the call graph; never delete on a call count. Rarity and deadness produce the same number, so a count tells you how often and only a caller tells you whether. Map every entry point and separate INTERNAL callers, which disappear with the deletion, from EXTERNAL ones — CLI, MCP tool, HTTP route — where one surviving door means the surface is live. Deleting on a zero is sound only with a positive control proving the counter works and a confirmed absence of callers across the whole tree.
2. Compare what each call can REACH, not what its signature looks like. A flag, a default, an omissible argument or a side effect decides what comes back: two surfaces that differed by one argument differed by 70% of the corpus, and folding them would have made most of it unreachable. Before deleting a shared helper, grep its importers rather than trusting its name — a second consumer dies silently with the suite still green.
3. Grep the NON-SOURCE files before deleting any command, entry point or script: `.github/workflows/`, `Makefile`, `package.json` scripts, `qa/` and other shell suites, Dockerfiles, service units, runbooks. Grep the invoked command string, not the symbol. A green suite is not evidence here, because a workflow is not in the suite — a deletion that broke the release landed with every test passing. Read the caller's own comments before deleting what it calls.
4. When you justify a deletion with "something else already does this", enumerate everything the target does and check the replacement against all of it. The argument usually covers one leg and is silent about the rest.
5. A passing test standing over the code is a finding, not an obstacle. Deleting it so a deletion can proceed is the same act as deleting a failing test to make a build green, with better manners. Report it and stop.

## Measurement and baselines

Measurement and baselines:
1. Name the ref a baseline was taken at. `git stash` removes UNCOMMITTED work only, so once you are a commit into a task it cannot clear your own landed change: the failure reproduces against a "clean" tree and you file your own breakage as pre-existing. Take the baseline at the commit before your first one and name it — a baseline with no ref named is not a baseline.
2. Check a tool's default output cap before comparing counts. A cap is a constant, so two runs report it identically no matter what changed; biome's default is 20 diagnostics, and 20-before/20-after is equally consistent with "nothing changed" and "you added six hundred". A suspiciously round number on both sides is the tell. Ask whether the number COULD have moved, not whether it did.
3. Read the message, not just the exit code. A non-zero exit can be a configuration fact rather than a result — "this path is ignored by config" is not a lint failure.
4. Verify the artifact, not just the build. A build exit code proves the import graph resolved; only running the compiled binary proves the shipped bytes execute your change. Ask the same of a golden fixture: one built from a frozen copy of its input cannot see an edit to the live file, so read which of the two it loads before trusting it either to guard your change or to indict it.
5. Scope a verification run to the blast radius, not to the directory you were working in. Grep the symbol and run everything that mentions it; for any change that moves files or rewrites import paths, run the full suite and sweep separately for dynamic `import(` strings, which survive both typecheck and the bundler and fail at runtime.
6. Never assume a database path. Several stores live under different roots with stale copies of each, and a wrong path does not throw — it opens, matches the schema, and answers with clean, plausible zeros. Read the instance root off a live artifact instead of guessing, and count something you know is non-empty in the same read.
7. A crashed, truncated or unbuilt test run is no measurement — not a pass, not a green run, never reportable as one. "The suites that ran before it died all passed" is reporting a measurement nobody took. XCTest prints an "Executed N tests, with M failures" line per suite as well as once at the end, so grepping or summing them double-counts, and a crash leaves the aggregate line simply absent, which a careless grep reads as success. Only the aggregate line under `Test Suite 'All tests'` (a full run) or `Test Suite 'Selected tests'` (a `--filter` run) closes the accounting. The only reader of a `swift test` log in this repo is `scripts/qa/classify-swift-test-run.sh`: it prints one of `caught`, `survived`, or `no-measurement`, and it trusts only that aggregate line. A build failure produces no aggregate line, so it lands on `no-measurement` through the same gate — there is deliberately no separate build check. The failure count is the number in front of the word "failure", never the number after "with", because a skip-bearing line says "with 14 tests skipped and 3 failures". Use the script; do not hand-roll a grep.

## Search hygiene

Search hygiene: a repo-wide search with an unanchored pattern — one leading with `.*` or `.{0,N}` — can allocate tens of GB on a large tree, and Hive's memory watchdog will kill it. Anchor patterns on a real literal, scope the search to the subdirectory that can hold the answer rather than the repo root, and stay out of build, vendor, and dependency trees. If a search is killed for memory, never re-run it wider: a wider pattern is a bigger allocation, not a better search.

## Documentation conventions

Documentation conventions:
1. Docs are as-built. They describe how the system IS, not how it will be; an intention is a plan, and plans are not docs.
2. Docs live in `docs/`.
3. No superseded content is retained. An overtaken doc is corrected or deleted, never left in place with a note admitting it is out of date — an agent that trusts a stale doc is worse off than one that found nothing.

## Skill bindings

Skill bindings — when the work matches, the skill is not optional:
1. Use the code-comments skill whenever writing or reviewing code comments or documentation that lives alongside code.
2. Use the typescript-best-practices skill when reading or writing TypeScript or JavaScript (`.ts`, `.tsx`, `.js`, `tsconfig.json`).
3. Use the zig-best-practices skill when reading or writing Zig (`.zig`, `build.zig`, `build.zig.zon`).

## Service boundaries

Service boundaries:
1. One subsystem, one owner. `src/usage-service/` owns usage and `src/memory-service/` owns memory: call the owning service and consume what it returns, never re-derive its numbers yourself and never reach past it into its store. A second derivation is a second answer, and one of them is wrong.
2. An adapter authenticates, validates, calls the service, and renders the result. Logic that decides anything belongs behind the boundary, not in the adapter — a rule implemented in an adapter is a copy of a rule that already has an owner, and the copies drift apart until one is fixed and the others keep the defect.

## QA and environment flags

QA and environment flags:
1. QA can do everything dev and prod can do, and dev can do everything prod can do.
2. No prod-only features. A behaviour that exists only in production cannot be exercised before it ships, so it ships untested by construction.
3. Dev-only and QA-only features sit behind their own flags, named for the environment they serve.

## Read-only agents

This process is capability-enforced read-only: it may read the repo, run permitted read-only commands, use MCP tools, and report with hive_mail_publish. It cannot change the worktree or land its branch. Persist findings in durable Hive messages; do not attempt a commit.

## Writer agents

Complete writer work must be committed, verified after rebasing the primary checkout's current branch, and landed through hive_land. Do not wait for queen to authorise the landing. Verification is three gates on the rebased branch: `bun run check`, `bun run test`, and `bun run test:sessiond` invoked separately so a Bun failure cannot short-circuit it. Record what the run reported, never only an exit code or a failure grep; a `swift test` log is classified by `scripts/qa/classify-swift-test-run.sh`. Abort and report any rebase conflict; never merge into the primary checkout directly. When you report completion or findings by mail, use the work lane unless it is an escalation; the body is a short summary plus any `artifactId`; the full deliverable lives in the artifact store.

## Code review

Code review rules (Hive has no PRs; the code-review skill holds the long form):
1. Pin before reading: resolve the primary checkout's current branch, the branch under review's exact SHA, and their merge-base, then review `git diff <base>..<sha>` from your own worktree — worktrees share one object database, so never check the branch out. Your verdict binds that SHA: if the branch moves, later commits are unreviewed — say so, never silently re-pin.
2. Scope is the footprint — `git diff --name-only <base>..<sha>` — not the commit messages. Review every changed file, including ones the task never mentioned.
3. Always report code the branch adds that nothing consumes: uncalled functions, unconsumed exports, unread config or flags, dead code paths. The finding is that it exists; whether it changes is the author's and the orchestrator's call. Note any justification the branch already gives.
4. Verdict on evidence, never on the author's say-so: APPROVE requires verified green at the pinned SHA — a suite you ran with its exit code captured directly (never through a pager or `| tail`), or the author's recorded test output at that SHA. Missing evidence is NEEDS_DISCUSSION, naming exactly what is unverified. A green run does not prove a new test executed; confirm it ran by name or flag it.
5. Store the full review body with `hive_artifact_put` first, then report with one durable hive_mail_publish message to queen: verdict (APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION), reviewed SHA, test evidence, the `artifactId`, and a short summary of blocking and non-blocking findings as path:line — never the full findings prose in mail. APPROVE, and findings that do not ask for a hold, go on the work lane. A REQUEST_CHANGES or NEEDS_DISCUSSION that needs landing held is control-lane — say so and ask queen to hold. The author self-lands via hive_land once green; an unflagged blocker lands.
6. Do not drive over-engineering. A finding needs a concrete path to a real failure — inputs, state, wrong output; a hypothetical is a question, not a blocker. Asking what if the disk fills, the vendor changes its API, or two agents race, without evidence that any of it happens here, turns a small correct change into a large defensive one. Scope the ceremony to the change, not to the blast radius you can imagine for it.
