# qa/ — the agent-runnable QA rig

Tools for standing up an isolated QA Hive an agent can test against — daemon
from current source, own scratch home, aimed at the designated target repo —
without touching the user's Hive or the shared development instance.

## Use

    qa/rig.sh up                       # bring up the QA daemon, leave it running
    qa/rig.sh run <cmd...>             # up, run cmd in the QA environment, down
    qa/rig.sh down                     # stop; exit 1 if anything survives
    qa/suite.sh fixture                # private rig + landed legs → suite-report.jsonl
    qa/suite.sh probe missing-row|forged-tier|teardown-leak

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

Reviewer controls:

    QA_HOME=$HOME/.hive qa/rig.sh up        # refused
    qa/rig-checks.sh                        # every claim above, exercised

`g-checks.sh` proves the refusals in both directions with a passing
positive control, and proves `down` really fails on a survivor by leaking a
TERM-ignoring process bound to the QA home.
