# B2.5 · Workspace/vendor qualification (DoD row K + A4)

Status: **in progress (helga)** — M1 item 6 HARD.  
B2.5 **is** DoD row K, not a separate task. Planning authority: `planning/story-m1-b2-hive-terminal-view.md` B2.5 row + DoD §6–8.

## Sequencing (queen)

| Phase | Work | Blocked on |
|-------|------|------------|
| 1 | Production-pane wiring (default path, not demo harness) | landed only |
| 2 | Single-pane A4: exact close, quit teardown, non-Hive project, restart/reconnect/replay | landed only |
| 3 | 100 MiB ordered-output responsiveness at the **pane** | Gate 5 row C prior art |
| 4 | Row K: live Claude + Codex + Grok through production pane + evidence | real vendor CLIs |
| 5 | Gate-10 operability: Instruments leak/UAF + multi-pane main-thread latency | multi-viewer waits **hulda #40** claim-release |

Ports: **43140+**. Homes: short per-checkout (`/tmp/hive-dev-*` via make, or `/tmp/hb25-*` for harnesses).

## What already exists (code inventory, not evidence)

- Daemon owns broker (`SessiondBrokerSupervisor`); `make run` short `HIVE_HOME` fits sun_path.
- Spawner: `prepare()` → sessiond locator; `awaitInitialSessiondPolicy` waits for Workspace inventory; `create` through sessiond host.
- Workspace: `installSessiondTerminal` when `locator.hostKind == "sessiond"`; visibility publish via workspace-feed stdin → `POST /workspace-visibility`.
- Exact close: pane X → `hive kill --session-locator` → daemon process-tree capture (`stopSessiondAgentSession`).
- Demo harness remains: `scripts/b22-live-attach-proof.ts`, run directly (manual create + smoke; the `make terminal` wrapper was deleted 2026-07-21 with the four-command ruling). **B2.5 must not treat that as production.**

## Gap (why row K is empty)

1. **No recorded production-pane matrix** for real Claude/Codex/Grok under `make run` / bare `hive` (E2E #43 proved broker ownership + panes, not vendor matrix cells).
2. ~~Makefile still claims “terminal panes stay blank… make terminal is the entrypoint” — stale after broker ownership + sessiond wiring.~~ Closed 2026-07-21: the Makefile header now names `make run` as the product entrypoint and the harness as a directly-run script.
3. A4 live rows (exact close isolation, concurrent quit, non-Hive project, reconnect/replay) need evidence packs, not only unit paths.
4. 100 MiB is proven at **engine** Gate 5; pane-level ordered-output responsiveness is open.
5. Gate-10 multi-pane latency / multi-viewer blocked on #40.

## Pin plan

| Pin | Deliverable | Review |
|-----|-------------|--------|
| B2.5.0 | This plan + Makefile production messaging + evidence scaffold + harness skeleton | light |
| B2.5.1 | Production-pane GREEN: spawn under make-run stack → sessiond locator + HiveTerminalView + broker parent | cross-vendor |
| B2.5.2 | A4 single-pane legs + process-tree evidence | cross-vendor |
| B2.5.3 | 100 MiB pane-level row | cross-vendor |
| B2.5.4 | Row K Claude/Codex/Grok (cheapest real invocations) | cross-vendor + third vendor |
| B2.5.5 | Gate-10 remainder after #40 | as needed |

## Evidence layout

```
raw/qualification/hive-b25-production-pane/
  EVIDENCE.md
  provenance.txt
  evidence-sha256.txt
  matrix/
    production-wiring.txt
    a4-exact-close.txt
    a4-quit.txt
    a4-non-hive-project.txt
    a4-reconnect-replay.txt
    stress-100mib-pane.txt
    row-k-claude.txt
    row-k-codex.txt
    row-k-grok.txt
  manifests/
    *.json
```

## Laws

- Per-pane close: process-tree **capture before kill**, authoritative absence readback (teardown doc).
- 100 MiB: prior art Gate 5 ordered-output matrix row C / control #2 dispositions.
- Vendor sessions are **real agents** — cheapest live invocations, not mocks.
- Evidence `.txt` + manifests; never edit a red run into green.
- Multi-viewer / drop-reattach shaped work waits for hulda #40 landing relay.
