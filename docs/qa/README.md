# qa/ — the agent-runnable QA rig

Tools for standing up an isolated QA Hive an agent can test against — daemon
from current source, own scratch home, aimed at the designated target repo —
without touching the user's Hive or the shared development instance.

A human who wants the installed `hive-qa` binary — not this source-running
rig — uses the Makefile lifecycle instead:

    make qa          # install.sh --variant qa, init the test repo, run it
    make qa-clean    # product uninstall --repo, then uninstall --purge

`make qa` defaults `PROJECT` to `/Users/scottkellar/Projects/hive-test-project`
and keeps every guard `make run` already has. Its home is `/tmp/hvqa-<tag>/home`
— the same isolated-QA-home family `docs/qa/rig.sh` uses for its own default,
outside the checkout entirely — with `HIVE_HOME` and `HIVE_DEFAULT_HOME` both
pinned there so uninstall cannot resolve to `~/.hive` or see the live fleet.
A guard refuses the staging root by name if it ever resolves back inside the
checkout. `make qa-clean` runs the product repository and machine uninstall
commands, checks that the QA installation paths are gone, and checks that
`~/.hive`'s isolation inventory
(top-level names, instances, `run/`, `db-identity/`, default hive-qa
install locations) matches the pre-qa snapshot. Nested live-fleet writes
are not part of that compare — they would make every run red.

## Use

    docs/qa/rig.sh up                  # bring up the QA daemon, leave it running
    docs/qa/rig.sh run <cmd...>        # up, run cmd in the QA environment, down
    docs/qa/rig.sh down                # stop; exit 1 if anything survives
    docs/qa/suite.sh fixture           # private rig + landed legs → suite-report.jsonl
    docs/qa/suite.sh probe missing-row|forged-tier|teardown-leak
    docs/qa/suite.sh probe workspace-ui   # workspace shell legs must be able to fail
    docs/qa/workspace-ui.sh run <artifacts> <home> <port> <hive-bin>

Parameters (env): `QA_HOME` (default: a short checkout-specific `/tmp/hvqa-*`
path), `QA_PROJECT` (default `/Users/scottkellar/Projects/hive-test-project`),
`QA_SRC_ROOT` (default: the checkout containing the script — the code under
test), `QA_SESSIOND_BIN`, `QA_SKIP_POLICY=1` (leave routing unconfigured).

After `up`, use the published `home` rather than the caller's input spelling.
The port is in `<home>/daemon.port`; logs and artifacts are below that same
resolved home. Every bring-up appends its source SHA, sessiond identity, and
source-hash assert result to `<home>/artifacts/rig-record.txt`. The rig prints
the coordinates and writes them to `<home>/artifacts/coordinates.txt`:

    requested_home=/tmp/hvqa-...
    home=/private/tmp/hvqa-...
    default_home=/private/tmp/hvqa-.../default
    port=12345
    project=/Users/scottkellar/Projects/hive-test-project
    source=/path/to/hive-checkout
    hive_bin=/private/tmp/hvqa-.../artifacts/hive-bin

`hive_bin` is an executable shim (`exec bun run <source>/src/cli.ts`) for tour
live mode and the suite. Pass published `home`, `port`, and `hive_bin` directly
to consumers. Never discover a QA daemon by globbing `/tmp/hvqa-*`: several
rigs may coexist, and a name alone does not prove where a path resolves.

## Gate — why this cannot reach dev or prod

- `QA_HOME` is resolved before it is matched against `/tmp/hvqa-*` or macOS's
  physical `/private/tmp/hvqa-*` spelling. The user's home (`~/.hive`), the
  primary development home (`~/.hive/instances/dev-<sha10>`, a named instance
  inside the user home and so already covered by that rule), and symlinks to
  either are refused. The accepted resolved value—not the caller's replaceable symlink—is
  passed to the daemon, CLI, and `run` command.
- `HIVE_DEFAULT_HOME` is pinned below the QA home for the daemon and every CLI
  consumer. Default-instance settings and the shared quota database therefore
  stay in QA; the real `HOME` remains available to provider credential stores.
- `QA_PROJECT` may not be the Hive checkout, contain it, or live under
  `~/.hive`.
- The daemon runs directly from source (`bun run src/cli.ts daemon`) and never
  invokes a shared build or development-runtime target.
- The rig asserts the daemon's startup announcement hash equals the hash of
  `QA_SRC_ROOT` — a stale or wrong-tree daemon fails bring-up.
- Teardown signals only recorded process identities and their captured
  descendants. Its final `lsof` readback proves its own reader worked before an
  empty result can pass.

- The checkout root is never assumed. Every script here resolves its own
  directory from its own location and asks `repo-root.sh` (`repo-root.ts` for
  the two TypeScript entry points) to search upward for a directory holding
  both `package.json` and `src/cli.ts`. Nothing records how deep this tree
  sits, and sibling scripts are referenced through the caller's own directory,
  so moving the tree cannot silently redirect a run. A root that cannot be
  validated is refused, quoting the path — it is never passed to the daemon,
  the CLI, or the u5 isolation gate.

Reviewer controls:

    QA_HOME=$HOME/.hive docs/qa/rig.sh up   # refused
    docs/qa/rig-checks.sh                   # every claim above, exercised

`docs/qa/rig-checks.sh` proves the refusals in both directions with a passing
positive control, proves `down` really fails on a survivor by leaking a
TERM-ignoring process bound to the QA home, proves `up` with no `QA_SRC_ROOT`
resolves this checkout, and proves the root resolver refuses a directory that
sits under no checkout.
