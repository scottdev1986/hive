# HiveMemory assessment: promises versus practice

Audit date: 2026-07-25  
Scope: the three HiveMemory design documents, their §04 proof table, the eight failures present at the start of the audit, and live daemon behavior.  
Verdict: HiveMemory is materially healthier than the starting failure list implied. All eight named failures were test-fixture/environment defects, not memory isolation or provisioning defects. Seven belonged to HiveMemory tests; the eighth was Graphify and unrelated. After fixing the fixtures, the unflagged suite is green: **1,736 pass, 12 skip, 1 todo, 0 fail** across 170 files, with typecheck passing.

The strongest product claims mostly survived contact with evidence: project isolation, exact dedup, advisory near-dedup, guarded deletion, episodic persistence, hybrid recall, self-tests, embedding status, supersede history, and the dev/installed shared-memory policy all hold. One response-level observability defect was fixed. The remaining substantive boundaries are documented rather than hidden: a missing curated store reads as empty, and different-repository daemons do not share a lock for concurrent global writes.

## Phase 1: the eight failures

| Starting failure | Finding | Resolution |
|---|---|---|
| two-way nonce isolation | Fixture defect, not a leak. `TMPDIR` was inside the Hive checkout, so both temporary roots inherited the same Git common directory and therefore the same project identity. Independent roots under `/private/tmp` produced different UUIDs and stores. | `test/daemon/memory-query-mcp.test.ts:44-53` now initializes each fixture as its own Git repository. All isolation assertions remain unchanged. |
| EpisodicStore two-project stores | Same fixture defect. The supposedly independent directories were two paths inside one enclosing project. | `test/daemon/episodic-store.test.ts:17-26` initializes real independent repositories. The store-path inequality remains a genuine assertion. |
| `findSourceNodeModules` | The test's “missing” root lived below the checkout and correctly found the checkout's `node_modules` by walking upward. | `test/cli/embeddings.test.ts:17,30` uses the existing physical `/tmp` helper outside the repository. |
| `provisionEmbeddingsRuntime` ×2 | Same enclosing-checkout fixture contamination, not a provisioning failure. | Same fixture correction; no production fallback, retry, or provisioning layer added. |
| `runEmbeddingsInstall` ×2 | Same enclosing-checkout fixture contamination. | Same fixture correction. `test/cli/embeddings.test.ts`: 14 pass, 0 fail. |
| Graphify runtime channel manifest | Not HiveMemory. The committed dev environment set `HIVE_GRAPHIFY_MANIFEST`, overriding the published-channel test's premise. | `test/adapters/graphify-channel.test.ts:7-11,38` clears the override for that case and restores it afterward. |

The repository owns this failure mode: `Makefile:141-147` sets `TMPDIR=$(DEV)/tmp`. It is not peculiar to one user's shell. `test/outside-repo-tmpdir.ts:3-13` already documents the correct pattern for tests that exercise upward discovery.

The durable pitfall `tmpdir-fixtures-can-inherit-the-enclosin` records the investigation. Its first write returned `embedding: "indexed"`; exact replay was refused with the existing id and update instructions; a pitfall search returned the article. That is a live HOLDS result for the documented learning loop's write, projection, exact-dedup, and recall steps.

No migration is needed. There was no cross-project contamination, and this machine has only used Hive in this repository.

## The apparent temporary-memory defect

The reported `/tmp/hv-a27e3d322a/memory/...` paths were lexical paths through deliberate symlinks, not temporary storage:

- `/tmp/hv-a27e3d322a/memory -> ~/.hive/memory`
- `/tmp/hv-a27e3d322a/projects -> ~/.hive/projects`
- `/tmp/hv-a27e3d322a/project-registry.json -> ~/.hive/project-registry.json`
- `/tmp/hv-a27e3d322a/models -> ~/.hive/models`

The Kimi article and both raw revisions exist physically under `~/.hive/memory`. Nothing needs moving or reindexing. `scripts/dev-memory-setup.ts:44-57` defines the shared whitelist; `Makefile:281-284` installs it before provisioning the private embeddings runtime.

This division is sound:

- curated raw/wiki memory is shared;
- episodic stores are shared and opened with WAL, a 5-second busy timeout, and foreign keys (`src/daemon/episodic-store.ts:228-237`);
- the model cache is shared;
- daemon identity, rendezvous/runtime state, databases, configuration, capabilities, sockets, and the mutable embeddings runtime remain instance-private;
- the private embeddings runtime is probe-provisioned before development start.

The real defect was observability: `memory_write` presented the lexical temporary path as the storage location. `src/daemon/server.ts:6453-6465` now resolves only the two human-facing response paths before compaction; storage and indexing paths are unchanged. `test/daemon/memory-mcp.test.ts` asserts that a symlinked global write reports the physical path. Commit: `2a2115a9`.

## Gaps that remain

| Promise | What actually happens | Evidence | Honest treatment |
|---|---|---|---|
| Overview: “Facts are captured once, recalled forever.” Architecture: “absent-vs-empty discriminators on every read surface.” | If the configured curated store disappears, topic discovery converts `ENOENT` to `[]`, article read returns `null`, and a later write recreates blank directories. There is no rebuild or alarm. Query envelopes do distinguish absent fields, but file-backed corpus loss does not. | `src/adapters/memory.ts:31,205-237,263-269` | **Documentation correction.** The design now states the durability boundary. Recovery machinery was not added. |
| Same-repository dev/installed writes are serialized by `.hive/memory.lock`. | This holds for daemons serving the same repository. Daemons serving different repositories take different repo-local locks even when both write the shared global store. Concurrent cross-repository global writes can therefore race. | `src/daemon/server.ts:1600-1615` | **Documented known limitation.** No cross-repository locking system was built. |
| Proof table: “Primary-checkout read” is proven by `test/cli/spawner-impl.test.ts`. | That test file does not exist. The implementation reads from the daemon's primary `repoRoot`, but the claimed stale-worktree scenario lacks a dedicated test. | `src/daemon/spawner-impl.ts:2658-2665` | **Documentation correction:** row is now explicitly unproven. A speculative test was not added outside this audit's fix scope. |
| Proof table floor: “~360 MB warm RSS, ~39 ms/embed, ~8 ms scan/5k.” | The audit benchmark observed 448 MB after load, 55.11 ms mean single embed, 106.25 ms mean top-10 query including embedding, and 1,603 MB after the 5k run and GC. Hardware/runtime context matters; the old numbers are not a universal floor. | `bun scripts/memory-embedding-bench.ts` | **Documentation correction:** report measured, dated results rather than a fixed promise. |
| Proof table: “2000+ pass, 0 fail.” | The actual run is 1,736 pass, 12 skip, 1 todo, 0 fail. At audit start, eight pre-existing fixture failures also made “0 fail” false. | `bun test --reporter=dots` | **Tests fixed and document corrected** to the dated actual count. |
| Overview: “A mistake made once is never made twice” and “No duplicate memories.” | Exact duplicates are refused. Near-duplicates are advisory, semantic overlaps require consolidation, and harvested mistakes begin unverified. The absolute wording exceeded the implementation's honest contract. | `src/adapters/memory.ts:404-472`; live pitfall exercise | **Documentation correction** to exact refusal, advisory review, and verified-pitfall surfacing. |

## §04 proof table

Classification means the named behavior was executed in this audit. Automated evidence can establish the mechanism, but it does not silently stand in for an unperformed live manual scenario.

| Element | Result | Evidence |
|---|---|---|
| Whole system (fixtures) | **HOLDS** | `hive memory self-test`: 6 PASS, 2 SKIP, exit 0. |
| Deployed daemon | **HOLDS** | `hive memory self-test --live`: fixture results plus 10 `[live] PASS`, exit 0; embedding state ready, indexed writes, hybrid paraphrase recall, FTS, readback, digest, cleanup. |
| Degradation visibility | **HOLDS** | Live `hive_status` reported ready/model/vector/runtime state; writes reported `indexed`; degraded labels and logging passed in the regression suite. |
| Semantic recall | **HOLDS** | Current development binary with its private runtime: `HIVE_MEMORY_SELF_TEST_EMBEDDINGS=1 HIVE_EMBEDDINGS_HOME=/tmp/hv-a27e3d322a/tools/embeddings ... memory self-test --strict`: 8 PASS, zero SKIP. Strict without a model failed on both skips as promised. |
| Probe can fail | **HOLDS** | `test/memory-self-test.test.ts` passed, including the sabotaged canary case. |
| Wiki write/read/search | **HOLDS** | `test/daemon/memory-mcp.test.ts`: 10 pass, including physical-path response coverage. Live article writes indexed and searched. |
| Dedup L1 | **HOLDS** | Exact live pitfall replay refused and named the existing id/update path. |
| Dedup L2 | **HOLDS** | Self-test and MCP coverage returned `similarCandidates`; the first pitfall write correctly had none. |
| Dedup L3 | **HOLDS** | Read-only `hive memory consolidate`: scanned 6, found 3 identical and 1 similar, applied 0. `--apply` was not run. |
| Delete gate | **HOLDS** | `test/daemon/auth.test.ts`: writer forbidden, operator allowed. |
| Reference-checked delete | **HOLDS** | `test/adapters/memory.test.ts`: supersedes blocker named. |
| Ranked spawn injection | **UNVERIFIABLE** | Automated ranking coverage passed; the table's additional live spawn of an agent matching a 60-day-old pitfall was not performed. |
| Primary-checkout read | **UNVERIFIABLE** | Claimed test file is absent; implementation inspection is not the promised proof. |
| Wake delta | **UNVERIFIABLE** | Automated delta tests passed and live daemon injections were observed, but the exact write/first-message/second-message manual sequence was not completed. |
| Trigger protocol | **UNVERIFIABLE** | Trigger tests passed; the exact queen-versus-agent live comparison was not run. |
| Episodic + bi-temporal | **HOLDS** | `test/daemon/episodic-store.test.ts`: 10 pass, including restart and as-of behavior. |
| Project isolation | **HOLDS** | Corrected independent-repository fixture: 6 pass. Nonces remain two-way and storage remains separately asserted. |
| Budgets & scoping | **HOLDS** | `test/daemon/episodic-projections.test.ts` passed in the 135-test targeted proof run. |
| Digests + drill-down | **UNVERIFIABLE** | Digest, drill-down, and drift-audit tests passed; the table's live kill/manual tamper scenario was not run. |
| Mistake harvest | **UNVERIFIABLE** | `test/daemon/pitfall-harvest.test.ts`: 6 pass, including cross-agent surfacing. The live exercise wrote/searched a real pitfall but did not obtain it by killing a failing session. |
| Retention | **HOLDS** | `test/daemon/memory-retention.test.ts` passed in the targeted proof run. |
| Hybrid embeddings | **HOLDS** | Required targeted command `HIVE_LIVE_MEMORY_EMBEDDINGS=1 bun test test/memory-embedding-live.test.ts`: 3 pass, exit 0. The prohibited flagged full-suite form was not run. |
| Vendor conformance | **HOLDS for current matrix** | Static Claude/Codex/Grok conformance tests passed; environment-gated live tests skipped. Kimi/opencode remain explicitly future work under issue #63. |
| Floor performance | **FAILS** | The dated benchmark did not reproduce any of the three advertised values; see gap table. |
| Full regression | **FAILS as written; current gate HOLDS** | “2000+” is false. Actual: typecheck passed; 1,736 pass, 12 skip, 1 todo, 0 fail. |

Targeted proof groups also completed:

- memory/self-test/auth/adapters/episodic/isolation/projections/retention/vendor: 135 pass, 3 environment-gated skips, 0 fail;
- digest/delta/triggers: 44 pass, 0 fail;
- pitfall harvest: 6 pass, 0 fail;
- embedding provisioning: 14 pass, 0 fail;
- Graphify channel: 2 pass, 0 fail.

The old installed `hive` binary on this machine is version 0.0.38 and could not load the current development runtime. That is not evidence against current source: the current development binary passed strict real-model proof. It does mean proof reports must name the binary and runtime used rather than treating every `hive` on `PATH` as equivalent.

## Manager document

The manager document is unusually honest about its boundary: browsing/list projections, daemon-executed self-test records, consolidation endpoints, validated config writes, sweep history, metrics, audit feeds, and recall preview are labeled contract gaps rather than shipped features. Those are not reclassified as product regressions here.

Its inaccurate “full suite green” implication has been replaced with the dated measured run. Its path examples now state that `~/.hive` is the normal default, not an absolute location, and explain the deliberate development/installed split. The mockup's mature-corpus counts remain explicitly illustrative; they are not audit evidence.

## Changes

- `8fc40250` — test fixtures made independent of the committed dev environment.
- `2a2115a9` — memory-write responses report resolved physical paths, with MCP coverage.
- Documentation — all three HiveMemory design documents now state path precedence, the source-checkout sharing policy, current regression evidence, the missing-store and lock boundaries, and proof rows that were formerly overclaimed.

No production isolation, embeddings provisioning, recovery, migration, federation, or cross-repository locking subsystem was added. The smallest fixes were fixture corrections, one response-site `realpath`, and honest documentation.
