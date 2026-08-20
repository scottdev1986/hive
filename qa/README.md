# qa/ — Hive's functional QA harness

Hive QA tests behaviour: does the button exist, does it work. One directory
holds the harness, its rows, and its own unit tests.

## Layout

    qa/
      run.ts            entrypoint (`make qa-run`)
      runner.ts         preflight, three-state reporting, build-identity fence
      wait-ready.ts     proof that daemon.port exists before the rig is "up"
      rows/stage1.ts    T1-01..T1-09 Task Router rows
      test/             unit tests for the files above
      README.md         this file

Isolation, process-ownership, and inventory stay in `scripts/qa/`. They are
the Makefile lifecycle fence (`qa-clean` / `build-qa` / `qa`), not rows, and
the writer-verification reader `classify-swift-test-run.sh` is used outside
QA. Putting them here would mix the harness with the same unrelated scripts
the owner ordered out of the old `scripts/qa/` pile.

The older `docs/qa/` rig is gone. Git history keeps it.

## Commands

Four verbs, one job each. Do not collapse them.

    make qa-clean     tear the isolated install down; prove user Hive untouched
    make build-qa     compile one QA candidate from this tree into /tmp/hvqa-<tag>
    make qa           install that candidate, init the test project, bring the daemon up
    make qa-run       run this harness against the rig `make qa` left running

`make qa` does not report results. `make qa-run` does: one
`PASS|FAIL|NO MEASUREMENT <row-id> <reason>` line per row, then exit 0 / 1 / 2.

`PROJECT` defaults to `/Users/scottkellar/Projects/hive-test-project`. QA
refuses this checkout and any child of it. Staging is `/tmp/hvqa-<tag>`,
outside the source tree, with `HIVE_HOME` and `HIVE_DEFAULT_HOME` both pinned
there so uninstall cannot see the live fleet.

## What must survive

The three-state row contract: PASS / FAIL / NO MEASUREMENT, exit 0 / 1 / 2. A
wait bound expiring is a fact about the rig, never a product failure.

The build-identity fence: `make build-qa` compiles `git rev-parse --short HEAD`
into the CLI, and the runner refuses to measure when `current/hive --version`
does not name this tree.

## Why wait-ready exists

`make qa` used to print daemon readiness from the startup announcement, then
fail with no `daemon.port` under the QA home. The announcement is not the
artefact the next step needs. `qa/wait-ready.ts` waits for a usable
`daemon.port` under the repo-instance home (and the machine home, if they
differ) before `make qa` continues, and prints that home so the memory probe
reads the same place the daemon wrote.
