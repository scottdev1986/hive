# Mutation testing

Mutation scoring exists in this repository as a **manual tool only**. Nothing
runs it: not the landing path, not CI, not any scheduled job. A landing is
gated on the full test suite, typecheck, `format:check`, and the
fast-forward-only merge — mutation scoring is not among the gates.

There was a landing-time mutation gate until 2026-08-12, when the owner ruled
it removed: its filed verdicts were cross-file sums rather than per-file
scores, so the numbers it enforced were wrong. The gate, its baselines file,
its verdict cache, and the machine-resource service that budgeted its CPU are
deleted. What remains is the engine below.

## The toolchain

Stryker 9.6.1 lives in `tools/mutation/`, its own npm tree deliberately kept
out of the repo's bun dependencies: Stryker's sandbox reads `tsconfig.json`
through the TypeScript 5 compiler API, which the repo's TypeScript 7 removed,
so the toolchain pins its own `typescript@5.9.3`. Install it once with:

```sh
cd tools/mutation && npm install
```

`node_modules` there is gitignored.

## Running a score by hand

Stryker ships no `bun test` runner plugin, so the `command` runner is the
oracle: it treats a non-zero exit as a killed mutant, which is exactly what a
failing `bun test` reports. `coverageAnalysis: "off"` is forced by that
runner — the command protocol returns no per-test coverage map — so every
mutant costs one full `bun test <scope>` process, and a large file takes tens
of minutes.

Write a config, for example `stryker.local.json` in the repository root:

```json
{
  "packageManager": "npm",
  "testRunner": "command",
  "commandRunner": { "command": "bun test test/daemon" },
  "coverageAnalysis": "off",
  "mutate": ["src/daemon/lifecycle/maintenance.ts"],
  "inPlace": true,
  "disableTypeChecks": false,
  "reporters": ["clear-text", "json"],
  "jsonReporter": { "fileName": "mutation-report.json" },
  "timeoutMS": 60000
}
```

Then, from the repository root:

```sh
node tools/mutation/node_modules/@stryker-mutator/core/bin/stryker.js run stryker.local.json
```

Three properties of that config are load-bearing, not taste:

- **The named test scope must be green before you start.** A mutant is only
  honestly "survived" when the suite would have passed without it; a score off
  a red suite means nothing.
- **`inPlace: true` mutates your working tree.** The sandbox copy Stryker
  would otherwise use silently drops the fixtures tests read from `workspace/`
  and `.hive/`, so the run starts red for reasons unrelated to the mutants.
  The price is that a run killed mid-pass can leave mutants in your tree —
  restore with `git checkout -- <file>` before doing anything else.
- **`disableTypeChecks: false`** because bun does not typecheck at runtime,
  and rewriting the sources would move the line numbers the architecture
  tests read them by.

Read the JSON report's per-file `mutants` when you want one file's score:
sum only the entries under that file's own key.
