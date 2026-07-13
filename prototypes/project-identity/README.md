# Project identity under motion

This is prototype hypothesis 4 from the [Workspace blueprint](../../docs/workspace/blueprint.md):
a project must keep one identity while the filesystem moves underneath it, and must never
hand an old identity to a new directory.

The blueprint's six-step resolver order is binding, and `src/resolver.ts` implements it in
that order. Everything else here exists to find out whether the order is enough.

## What it found

It is not enough, in one specific way. The blueprint said bookmarks "follow moves silently,
so every resolution compares the resolved path with the confirmed path and enters
`NEEDS_REBIND` on disagreement." Driving real, plain (non-security-scoped) `NSURL` bookmarks
shows that resolution is **path-first**:

| step | state on disk | bookmark resolves to |
| --- | --- | --- |
| bookmark `A` | `A` exists | `A`, `isStale=false` |
| rename `A` → `B` | `B` exists, `A` vacant | `B`, `isStale=true` |
| create any fresh dir at `A` | **both** `B` and `A` exist | **`A`** — the impostor, `isStale=true` |
| delete `B` | only `A` exists | `A` |

In row three the real project is alive at `B`, and the bookmark points at an unrelated
directory at `A`. The prescribed check then compares the bookmark's path (`A`) with the
confirmed path (`A`), finds agreement, and attaches the wrong directory.

So the resolver checks durable filesystem evidence — `ino`, `birthtimeMs` — *before* it
consults the bookmark. `st_dev` is retained only as a process-local mount hint because
macOS may renumber it across reboot. The blueprint is right that these values are not identities.
The asymmetry is what makes them useful:

- **matching** evidence is necessary, and not sufficient, to prove identity;
- **differing** evidence is dispositive proof of non-identity.

Evidence is therefore only ever used to *refuse*. A move is found by evidence and produces
`NEEDS_REBIND` that preserves the `HiveUUID`. A recreated path produces a tombstone and
`NEEDS_SETUP`, and the operator must explicitly create or rebind.

`HiveUUID` is an opaque `randomUUID()`, minted once and stored. Deriving it from the path
(`hive-<sha256(root)>`) would make a recreated directory inherit the old Hive and make a
legitimate move look like a new project — both of which the blueprint forbids.

## Running it

```
bun run prototypes/project-identity/harness/run.ts   # 22 scenarios -> EVIDENCE.md
bun test prototypes/                                 # the same scenarios, as tests
```

The harness compiles `swift/hive-fsid.swift` on first use. That helper is the only place
Foundation is reachable from Bun; it creates and resolves plain bookmarks and reads
`volumeSupportsCaseSensitiveNames`. Case-sensitive and case-insensitive APFS volumes are
real disk images created with `hdiutil`, which needs no privileges.

If `swiftc` or `hdiutil` is missing, the affected scenarios report `skipped`. They never
pass vacuously, and `NullBookmarkProvider` records nothing rather than simulating a bookmark
with an inode — simulating one would quietly assert exactly the thing the blueprint forbids.

## What this does not prove

- **Network volumes are untested.** No SMB server was reachable. The refusal logic assumes
  `ino`/`birthtimeMs` change when a directory is replaced; an SMB client synthesizes
  inode numbers and a server may reissue them across remounts. `EVIDENCE.md` states the
  experiment that would settle it. Until then a network volume should reach `BLOCKED_CONFIG`.
- **`concurrent-starts` is single-process.** Twenty `resolveOrCreate` calls on one event loop
  yield one `HiveUUID`, which exercises the unique constraint and the idempotency lease but
  says nothing about cross-process leasing. Release gate 3 needs a real multi-process test.
- **`realpath` case-correction is measured, not documented.** Apple does not promise that
  `realpath(2)` rewrites a component to its on-disk case. The resolver folds the identity key
  itself rather than depend on it, and folding is gated on detected volume behavior — an
  unknown volume declines to fold, because a fold can only merge two keys, and merging two
  genuinely distinct directories is the worse error.
- **`ProjectRegistry` is in-memory.** Persistence, hydration, and the durable unique constraint
  belong to the Supervisor.

## The harness has teeth

Each decisive check was confirmed by breaking it:

| mutation | consequence |
| --- | --- |
| drop the `evidenceMatches` refusal (leaving the blueprint's path comparison) | `move-then-impostor` and `delete-recreate` both **resolve to the old Hive** |
| fold identity keys without consulting volume case behavior | `case-sensitive-volume` merges two real directories |
| stop stripping `GIT_DIR` from the environment | `git-env-hijack` fails; discovery is redirected |

## Layout

```
src/canonical.ts   realpath, identity-key folding, evidence capture
src/volume.ts      per-volume case + normalization behavior, with provenance
src/git.ts         rev-parse discovery: bare rejection, absolute paths, env sanitization
src/bookmark.ts    plain Foundation bookmarks, and the measured path-first semantics
src/ledger.ts      capability-gated managed-worktree ownership; no file may assert it
src/registry.ts    ProjectKey <-> HiveUUID, tombstones, rebind
src/resolver.ts    the six binding steps, then reconciliation
harness/           fixtures (git topologies, disk images) and the 22 scenarios
```

## Traps worth remembering

`git rev-parse --show-toplevel` makes the whole invocation fail inside a bare repository, so
bareness is queried on its own first. `--git-common-dir` is reported *relative to the
invocation directory* — from a subdirectory it answers `../../.git` — so
`--path-format=absolute` is mandatory or the repo-family key silently mis-keys. A `GIT_DIR` in
the environment redirects discovery to another repository entirely.
