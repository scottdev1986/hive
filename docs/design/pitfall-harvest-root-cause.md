# Root cause: pitfall harvest produces false candidates and ignores operator rejection

Verification pass, 2026-07-23, agent `anna`. **Design only — no source changed.**
Both defects reproduced from a copy of the live episodic store.

Primary source: `src/daemon/pitfall-harvest.ts`.
Contract sources: `docs/design/hivememory-architecture-and-operations.html` §1, §4;
`docs/design/hivememory-manager.html` §03 group C.

---

## Reproduction (both defects, one harness)

Ran the **real** `harvestPitfalls` against a **copy** of the live store
(`~/.hive/projects/984bea91-.../episodic.db`, 33 events) in a throwaway repo root,
for the two agents whose kill produced the reported candidates:
`75718f6d-…` and `62925804-…`.

> Positive control (protocol #3): the first run returned zero candidates because
> `cp` took only `episodic.db` and every event lived in the unflushed `-wal`.
> An empty result was a bad reader, not an empty world. After copying
> `episodic.db-wal`/`-shm`, the control reads 33 events / 10 for the first agent.

Pass 1 emitted **exactly the five reported candidates, byte-identical titles**:

| id | events | title (len 89) |
| --- | --- | --- |
| `pitfall-path-test-tagged-suites-pass-n-f` | e8 | `Pitfall: <path> test-tagged suites PASS. N FAIL: episodic-store (N roots -> N store path)` |
| `pitfall-all-n-test-tagged-rows-pass-on-a` | e11 | `Pitfall: All N test-tagged rows PASS on a clean TMPDIR. Full run (in-repo TMPDIR): N <pat` |
| `pitfall-complete-all-n-test-tagged-memor` | e18 | `Pitfall: Complete. All N test-tagged memory rows PASS. Full regression N <path> <path> fa` |
| `pitfall-codex-mcp-conformance-passed-cli` | e16 | `Pitfall: Codex MCP conformance passed. CLI temp-writing checks were capability-blocked wi` |
| `pitfall-tmpdir-tmp-retries-confirmed-tmp` | e21 | `Pitfall: TMPDIR=/tmp retries confirmed /tmp is also non-writable: all harnesses blocked b` |

Then `deleteMemoryFact` on all five (each `{deleted: true}`, disk empty), then pass 2
over the same events: **all five regenerated, `action=created`, ids identical.**

Harness: `scratchpad/repro.ts`, `scratchpad/loop-test.ts` (session scratchpad).

---

## DEFECT 1 — the classifier files successes as failures

### What the harvester treats as a failure signal

`src/daemon/pitfall-harvest.ts:29`

```ts
const FAILURE_PATTERN = /error|fail|blocked|kill/i;
```

applied at `src/daemon/pitfall-harvest.ts:198-200`:

```ts
const failures = events.filter((event) =>
  FAILURE_PATTERN.test(`${event.type} ${event.summary}`)
);
```

**That is the whole classifier.** A case-insensitive, unanchored substring match over
the agent's own free-prose status summary. There is no negative term, no word boundary,
no structured field. Any status report containing the substring `fail`, `error`,
`blocked` or `kill` anywhere — including inside `FAIL:`, `10 fail`, `failures`,
`capability-blocked` — becomes a pitfall.

Applied to the 11 real `agent.status-reported` events in the store, it fires on 5.
**45% of ordinary status prose is classified as a failure.** All five matched on
prose only; the typed channel `event.type` (`agent.status-reported`) matches nothing.
Three of the five describe unambiguous successes:

- e11 — `…rows PASS on a clean TMPDIR… 2118 pass/21 skip/10 fail…` → matched `fail`
- e18 — `Complete. All 11 … rows PASS. Full regression 2125 pass/…/3 fail…` → matched `fail`
- e16 — `Codex MCP conformance passed. CLI temp-writing checks were capability-blocked…` → matched `blocked`

The near-misses confirm how arbitrary the boundary is: e27
(`…probe passed: mktemp -d exited 0; no EPERM blocker.`) escapes only because the
pattern spells `blocked` and the prose says `blocker`.

### The decisive proof: two classifiers on the same event disagree

For e18 the harvest fired at all, which means `isDigestBoundaryEvent`
(`src/daemon/episodic-digest.ts:64-69`) returned true:

```ts
return OUTCOME_PATTERN.test(kind) || data.phase === "complete";
```

`OUTCOME_PATTERN` (`/land|complete/i`) cannot match kind `agent.status-reported`,
so the boundary fired on **`data.phase === "complete"`**. On the very same event,
the agent's own structured, authenticated phase field said *complete* while the
prose regex filed it as a failure. The correct signal was present and ignored.

### Root cause statement

The codebase already knows to classify on the typed channel — and does so
inconsistently *within one file*. `src/daemon/episodic-digest.ts`:

- line 145 / 154: `OUTCOME_PATTERN.test(event.type)` — **typed channel only**
- line 148 / 155: `FAILURE_PATTERN.test(\`${event.type} ${event.summary}\`)` — **typed channel + free prose**

Outcomes are read from structure; failures are guessed from prose. The harvester
inherits the prose branch verbatim.

### The bug is wider than briefed: the digest shares it

`src/daemon/pitfall-harvest.ts:28` comments *"Same failure classification the
digest's Failures section uses."* **That comment is true**, and that is the problem —
`src/daemon/episodic-digest.ts:32` declares the identical pattern. Live digests in
the production store already carry the misclassification:

- **Digest #5 `## Failures`** lists e8, e11, e18 — including `Complete. All 11 test-tagged memory rows PASS.`
- **Digest #6 `## Failures`** lists e16, e21 — including `Codex MCP conformance passed.`

So the corruption is not confined to the harvested articles queen deleted. It is
already baked into compiled digests, which are retained **forever**
(`digests_retention: forever`, §4) and are the drill-down surface `memory_digest` serves.

### The structured signal that should be used already exists

`src/daemon/status-store.ts:226-229` — every `agent.status-reported` event carries
`data.phase` (enum, includes `blocked`) and `data.blocker` (required, nullable),
authored by the agent, `confidence: "authoritative"`.

`src/daemon/server.ts:2866-2875` then **drops both at ingest** — the persisted
`provenance` JSON keeps only `{eventId, seq, entity, source}`. The typed failure
declaration never reaches the store, so every downstream reader is forced back onto prose.

### Recommended fix (defect 1)

1. **Carry the structured fields through ingest.** At `src/daemon/server.ts:2869-2874`
   add `phase` and `blocker` to the `provenance` object. `provenance` is already a
   TEXT JSON column (`src/daemon/episodic-store.ts:261-268`) — **no schema migration.**
2. **Classify on them.** Replace the prose test at `pitfall-harvest.ts:198-200` with:
   a failure is an event whose *typed kind* matches a failure kind, **or** whose
   `provenance.blocker !== null`, **or** whose `provenance.phase === "blocked"`.
   Never the summary. This mirrors `isDigestBoundaryEvent` exactly.
3. **Fix the digest too** (`episodic-digest.ts:148,155`), or the digests stay wrong.
4. **Add the missing negative control.** §4's acceptance criterion is *"run a session
   that fails, let it get killed → candidate appears"* — it only asserts a true
   positive. Add the dual: *a session that passes produces zero candidates.* This
   defect ships green against the current criterion.

### The two "cosmetic" issues are one substantive issue

Both trace to `sanitizeLabel` (`src/daemon/pitfall-harvest.ts:41-48`), whose own
doc comment (lines 38-40) scopes it to **cluster keying**:

> *"Strip the volatile tokens (paths, number runs, long hex) that would make the
> same failure earn a new cluster — and a new normalized title — every time it recurs…"*

`failureSignature` returns one `label` used for **both** purposes
(`pitfall-harvest.ts:50-76`), and every branch sanitizes before returning:

```ts
const label = sanitizeLabel(text).slice(0, 80);
return { key: `fail:${event.type}:${label.toLowerCase()}`, label };  // :74-75
```

The `key` already lowercases independently, so **the key never needed the label to
be pre-sanitized** — only the key needs sanitizing. The scrubbed string then flows
straight into the stored title (`:228 title = \`Pitfall: ${cluster.label}\``) and
into the body's `- Failure signature:` line (`:144`).

**This is a confirmed leak, not a design intent.** The damage is exactly as described:
`2118 pass/21 skip/10 fail` → `N pass/N skip/N fail`, and every path → `<path>`.
The numbers and paths are the only actionable content a pitfall has; the stored
lesson is left with none. (The `## Exact values` table at `:150-156` preserves them
separately, which is precisely why the title does not need to be scrubbed.)

**Truncation at ~85 chars:** `TITLE_MAX = 110` (`:34`) is **not** the binding
constraint and never fires on this path. The cut is `.slice(0, 80)` at `:74`, applied
to the label *before* the `"Pitfall: "` prefix (9 chars) is added — hence the exactly
**89-character** titles reproduced above, cut mid-token (`<pat`, `fa`). The error
branch (`:65`) can also overrun and be cut mid-word by `TITLE_MAX` at `:228`, since
`ERROR_PATTERN` (`:31`) admits a 100-char tail.

**Fix:** return `{ key, label }` where only `key` is sanitized and the `label` keeps
the raw text; truncate the title once, on a word boundary, at a single place.

---

## DEFECT 2 — operator rejection does not stick

### Does any suppression mechanism exist?

**No.** Verified three ways:

1. `src/daemon/pitfall-harvest.ts` is 298 lines and contains no tombstone, rejection,
   or suppression read of any kind. Its only pre-write lookup is
   `discoverMemoryFacts(deps.repoRoot, "repo")` at `:222-224`, which reads **live
   articles on disk**. A deleted article is simply absent, so `duplicate === undefined`
   at `:229-231` and the write at `:262-278` takes the **create** path.
2. `deleteMemoryFact` (`src/adapters/memory.ts:463-489`) does `rm(fact.path)`,
   `rebuildScopeIndex`, and `appendLog(… \`delete | ${fact.title}\`)`. No tombstone
   is recorded and **the function takes no reason parameter**.
3. The MCP tool `memory_delete` (`src/daemon/server.ts:5844-5852`) uses
   `MemoryFactRequestSchema` — `{scope, id}` only. **There is nowhere to put a reason.**

### Why the ids came back identical

`writeMemoryFact` derives the id from the title when none is supplied
(`src/adapters/memory.ts:370-379`): `id = slugify(input.title)` (40-char cap,
`:80-88`), with `-2`/`-3` suffixes only on a live on-disk collision. Title is a pure
function of the failure signature, which is a pure function of the event summary —
and the events are immutable and still in the store. Delete removes the only thing
that could have perturbed the id (the collision), so the next harvest lands on the
**exact same slug**. Reproduced: `IDS IDENTICAL ACROSS REJECTION: true`.

The digest number moving `#4 → #5/#6` is unrelated to identity — `:171` and `:274`
read the *current* digest for provenance, so only the citation text changes. It is a
regenerated article, not an updated one: pass 2 reported `action=created`, not `updated`.

### The contract gap is real and self-declared

`docs/design/hivememory-manager.html` §03 group C specifies the review inbox as
*"approve = verify write; reject = operator delete with a required reason, both
audit-logged (§04-C7)"* — and the doc's own "Grounded reality" cell already labels
this row a **Contract gap**. Confirmed: reject is unimplementable today on **two**
counts — no reason channel, and delete does not suppress re-harvest. A reviewer who
rejects a candidate gets it back on the next session boundary, forever, because the
source events are immutable and retained 30d while the harvest re-derives from
scratch every time.

### Minimal correct design — key on the failure signature

The three candidate keys, assessed:

| Key | Verdict |
| --- | --- |
| **Article id** (`pitfall-…`) | **Wrong.** Not a pure function of the failure — `slugify` truncates at 40 chars and disambiguates with `-2` suffixes against whatever else is on disk. Two distinct failures can collide onto one id, silently suppressing a genuine pitfall; and any drift in the label mints a new id that escapes the tombstone. |
| **Event cluster** (`eventIds`) | **Too narrow.** Events age out at 30d and a genuine recurrence in a later session carries new ids. The tombstone would expire and the same rejected candidate would return — which is the defect, restated. |
| **Failure signature** (`signature.key`) | **Correct.** It is already the cluster identity (`:61-76`), and it is *already designed* to be stable across recurrences at different lines/ids — that is exactly what `sanitizeLabel` exists for (`:38-40`). "This class of failure is not a pitfall" is precisely what an operator asserts when rejecting. |

**Recommendation:**

1. A `pitfall_rejections` table in `episodic.db` — the per-project state the harvester
   already holds via `deps.store`: `(signature TEXT PRIMARY KEY, reason TEXT NOT NULL,
   rejected_by TEXT NOT NULL, rejected_at TEXT NOT NULL, article_id TEXT)`.
   **Retention-exempt** (forever, alongside facts/digests) — a tombstone that ages
   out faster than the events it suppresses is not a tombstone.
2. `harvestPitfalls` skips any cluster whose `signature.key` is tombstoned — one
   lookup in the loop at `:226`, before the write at `:262`. This is the whole
   behavioural change.
3. Add `reason` to `memory_delete`'s schema, **required when the target is
   `kind: pitfall`** (that condition keeps ordinary article deletes unchanged and
   satisfies §03-C's "required reason" literally). Writing the tombstone and the
   audit line is then the delete path's job, giving §04-C7's audit log a real record —
   today's `delete | <title>` line carries no reason and no actor.
4. Escape hatch: re-harvesting a tombstoned signature must remain possible
   deliberately (delete the tombstone), so a rejection is reversible.

**Ordering note:** defect 2's tombstone is *not* a substitute for fixing defect 1.
With the prose classifier still in place, every distinct status summary mints a
distinct signature, so tombstones would accumulate one-per-report and never suppress
the next novel sentence. **Fix defect 1 first; the tombstone handles the residue.**

---

## Blast radius

### Junk pitfalls do lead every agent's spawn prompt — confirmed in source

`src/adapters/memory.ts:922-928` (`buildMemoryIndex`), the 30-row spawn index
(`MEMORY_INDEX_MAX_ENTRIES = 30`, `:32`):

```ts
if (a.pitfall !== b.pitfall) return a.pitfall ? -1 : 1;
if (!a.pitfall && a.matches !== b.matches) return b.matches - a.matches;
```

Pitfalls sort first **unconditionally** — ahead of brief-match and recency, and
**regardless of `status: unverified`**. Note line 2: brief-relevance is scored *only
for non-pitfalls*. A pitfall does not have to be relevant to the assignment to lead
the index; it only has to be a pitfall. This matches §1's "spawn index: pitfalls →
brief-match → newest" and §02's "pitfalls first, then articles sharing tokens with
the assignment brief".

Wake deltas carry them too, and deliberately ignore the high-water mark
(`src/daemon/memory-delta.ts:158-175`: *"a task-matching pitfall matters however old
it is"*), so a junk pitfall re-arrives on every wake, not just at spawn.

**Quantified against the current corpus:** the repo index holds 19 rows, of which
**1** is a pitfall. The five junk candidates would have made **5 of 6 pitfall rows
(83%)** and occupied **positions 1–5 of every spawn prompt and every wake delta** —
ahead of all 18 genuine articles. Well under the 30-row cap, so nothing was evicted;
the cost is ordering and trust, not truncation.

### The self-reinforcing loop: PARTIALLY CONFIRMED — the strong form is refuted

Queen's claim was flagged as possibly wrong. Tested rather than repeated.

**The loop is genuinely closed.** Harvested articles ride the injection; agents then
write status reports; those reports are `agent.status-reported` events; the harvester
reads them. I ran seven realistic follow-up summaries an agent might write after junk
pitfalls led its injection — **2 of 7 re-entered the harvest**, both matching
`blocked` while merely *describing* a pitfall they had read and dismissed
(e.g. *"Reviewed the injected pitfall about capability-blocked temp writes; not
relevant to my task."*). A status report that only *mentions* the noise becomes new noise.

**But the gain is well below 1, so it does not run away.** Each junk article yields
well under one new junk article per downstream agent, so the process is
convergent/leaky, not exponential. Dedup does not damp it either — the 2 harvested
follow-ups produced 2 distinct cluster keys, because each distinct sentence sanitizes
to a distinct signature — but the growth it permits is **linear in the number of
status reports**, not compounding per-article.

**The dominant term is not the feedback at all — it is the 45% base rate.** Junk is
produced overwhelmingly by ordinary status prose being misclassified (5 of 11 real
reports), not by agents reacting to previously injected junk. The loop is real and
worth closing, but it is a second-order contributor.

**Practical consequence, which the loop framing understates:** growth is driven by
*volume of status reporting*, and the corpus is unbounded because every distinct
sentence mints a distinct signature that dedup can never merge. A talkative fleet
poisons the head of every spawn prompt at a rate set by how often agents report —
and, because pitfalls sort first regardless of relevance, the newest junk keeps
outranking every verified article indefinitely.

---

## Test artifacts

**None created.** The reproduction ran entirely inside a throwaway repo root in the
session scratchpad against a **copy** of the episodic store. No memory article, no
episodic row, and no file in `.hive/memory` was created or modified by this pass;
the live store was opened read-only. No `stresstest-` ids were needed.

No agents were spawned or killed. No source code was changed.
