# Hive agent standards

Every section below is injected verbatim into the spawn prompt of every agent
Hive starts. Edit the prose here; nothing about these rules lives in the daemon
source. A spawn reads this file, so an edit reaches the next agent spawned — no
build, no promote, no restart.

The daemon chooses which sections a given agent gets: coding guidelines, hive
protocol and search hygiene go to everyone, writer and read-only agents get one
clause each, and code review goes only to a code-review agent. Those choices are
runtime facts, so they stay in the daemon. This file holds only the text.

The `##` headings are the contract between this file and the daemon. Renaming,
removing, emptying or adding one fails the next spawn with an error naming the
section — deliberately, because an agent running without its standards and
nobody noticing is worse than a spawn that refuses. Notes to user readers
belong in prose like this, above the first heading, or under a deeper `###`
heading inside a section — but remember that a `###` line ships to the agent
along with the rest of its section.

```standards
Coding guidelines: everyone
Hive protocol: everyone
Search hygiene: everyone
Read-only agents: read-only
Writer agents: writers
Code review: category code_review
```

## Coding guidelines

Coding guidelines (these are not optional; the karpathy-guidelines skill holds the long form):
1. Think before coding. State your assumptions; if you are uncertain, ask. If a request has several readings, present them — never pick one silently. If a simpler approach exists, say so and push back. If something is unclear, stop and name it.
2. Simplicity first. Write the minimum code that solves the problem and nothing speculative: no features beyond what was asked, no abstractions for single-use code, no unrequested flexibility or configurability, no error handling for impossible cases. If it is 200 lines and could be 50, rewrite it. Ask: would a senior engineer call this overcomplicated?
3. Surgical changes. Touch only what you must. Do not 'improve' adjacent code, comments, or formatting; do not refactor what is not broken; match the existing style even where yours differs. Unrelated dead code gets mentioned, not deleted. Remove only the orphans your own change created. Every changed line must trace to the request.
4. Goal-driven execution. Turn the task into a verifiable goal before you start ('fix the bug' → 'write a test that reproduces it, then make it pass'), and state a brief plan whose every step names its check. Loop until verified.
5. Keep separation of concerns. Each module, function, and change should have one clear job; put behavior at its owning boundary instead of coupling unrelated concerns.
6. Comments refer only to code, never to documents. A code comment must carry its own explanation instead of depending on a plan, ticket, or external account that can drift away.
7. Use the code-comments skill whenever writing or reviewing code comments or documentation that lives alongside code.
These bias toward caution over speed; on a trivial task, use judgment.

## Hive protocol

Hive protocol (non-negotiable):
1. An absent field is unknown, never false. A missing or misspelled key does not raise — it reads back as "no". Before trusting a negative, prove your reader can see a positive (a positive control): an all-empty result is usually a bad key, not an empty world.
2. Measure, do not infer. Never accept an ACT as proof of a STATE: "the command exited 0" is not "the message was received"; "the skill shipped" is not "the agent read it"; "the screen redrew" is not "the agent is alive". Read the thing that records the state.
3. Never run `make clean`, `make build`, or `make run`; use the repository's narrower commands instead.
4. Skills live in the primary checkout, not an agent worktree. Resolve and read them there.

## Search hygiene

Search hygiene: a repo-wide search with an unanchored pattern — one leading with `.*` or `.{0,N}` — can allocate tens of GB on a large tree, and Hive's memory watchdog will kill it. Anchor patterns on a real literal, scope the search to the subdirectory that can hold the answer rather than the repo root, and stay out of build, vendor, and dependency trees. If a search is killed for memory, never re-run it wider: a wider pattern is a bigger allocation, not a better search.

## Read-only agents

This process is capability-enforced read-only: it may read the repo, run permitted read-only commands, use MCP tools, and report with hive_mail_publish. It cannot change the worktree or land its branch. Persist findings in durable Hive messages; do not attempt a commit.

## Writer agents

Complete writer work must be committed, verified after rebasing the primary checkout's current branch, and landed through hive_land. Abort and report any rebase conflict; never merge into the primary checkout directly.

## Code review

Code review rules (Hive has no PRs; the code-review skill holds the long form):
1. Pin before reading: resolve the primary checkout's current branch, the branch under review's exact SHA, and their merge-base, then review `git diff <base>..<sha>` from your own worktree — worktrees share one object database, so never check the branch out. Your verdict binds that SHA: if the branch moves, later commits are unreviewed — say so, never silently re-pin.
2. Scope is the footprint — `git diff --name-only <base>..<sha>` — not the commit messages. Review every changed file, including ones the task never mentioned.
3. Always report code the branch adds that nothing consumes: uncalled functions, unconsumed exports, unread config or flags, dead code paths. The finding is that it exists; whether it changes is the author's and the orchestrator's call. Note any justification the branch already gives.
4. Verdict on evidence, never on the author's say-so: APPROVE requires verified green at the pinned SHA — a suite you ran with its exit code captured directly (never through a pager or `| tail`), or the author's recorded test output at that SHA. Missing evidence is NEEDS_DISCUSSION, naming exactly what is unverified. A green run does not prove a new test executed; confirm it ran by name or flag it.
5. Report with one durable hive_mail_publish message to queen (lane "control"): verdict (APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION), reviewed SHA, test evidence, then blocking and non-blocking findings as path:line, each naming a concrete failure. The author self-lands via hive_land once green — for any blocker, explicitly ask queen to hold landing; an unflagged blocker lands.
