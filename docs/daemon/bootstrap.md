# Isolated rebuild bootstrap

The rebuild fleet runs an immutable old Hive release while the development
build changes underneath it. The bootstrap is a separate control plane, not a
mode of the development build and not an alternate backend. It exists only to
coordinate rebuild work until the end gate replaces it.

## Immutable release contract

The approved release is Hive 0.0.37, tag `v0.0.37`, commit
`40c4efa447d45c71c63910d66d9bc263ff0c0534`, published 2026-07-16. The launcher
selects the matching macOS architecture and accepts only these exact artifact
bytes:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `hive-darwin-arm64` | 65,793,216 | `749245e88a920de431e8b948d9ac378413d99dd64a04be45479c360679119d92` |
| `hive-darwin-x64` | 71,501,104 | `f0638a171d49c3c3e917f146dce0faac7abd17efbb044caa52c5d45f37e9c365` |

Installation downloads from the tagged GitHub release, checks byte length and
SHA-256 against the local immutable pin, then executes the candidate and
requires its complete version identity to match the pin. Every later launch
repeats the byte-length, checksum, and version checks. The mutable GitHub
release metadata is corroborating evidence, never the trust root. GitHub's
release-asset contract exposes the download URL and SHA-256 digest used for the
independent publication check: [REST API endpoints for release
assets](https://docs.github.com/en/rest/releases/assets).

`bun run bootstrap:install` installs the verified launcher as
`hive-bootstrap`. `hive-bootstrap pin` reports the selected pin without
network access, and `hive-bootstrap verify` reads the installed bytes back and
verifies them. `hive-bootstrap update`, `hive-bootstrap uninstall`, and
`--instance` are refused: an immutable bootstrap cannot update itself or escape
into another Hive namespace.

## Runtime isolation contract

`hive-bootstrap <command>` behaves like the pinned `hive <command>`, but the
launcher replaces every Hive runtime boundary before the binary starts:

- a private process home isolates the old release's machine-level preferences,
  quota database, provider runtime state, and default-home fallbacks;
- a distinct `HIVE_HOME` owns the control database, credentials, lifecycle
  files, memory, project registry, and instance identity;
- a private temporary directory owns local Unix-domain sockets and transient
  files;
- a private tmux temporary root plus the instance-derived socket name owns the
  old terminal server;
- `HIVE_PORT=0` makes the kernel allocate a private loopback port, which later
  clients read only from this instance's lifecycle state; and
- private XDG roots prevent tools that honor those standards from falling back
  to the development user's configuration or caches.

Changing only `HIVE_HOME` is insufficient. Hive 0.0.37 deliberately places its
quota ledger in the process home so ordinary same-user instances can share
capacity. The bootstrap contract instead isolates the process home too. It
also forbids symlinks from any private runtime or provider state back into the
development home. Provider authentication must be performed or copied once
into the private home; it must not be linked to live development state.

The launcher preserves the current working directory and ordinary project
arguments. It therefore coordinates any Git project and assumes nothing about
the project's language, build tool, package manager, or layout. Project source
and the Git worktrees intentionally remain project artifacts; they are not
runtime-control state.

`hive-bootstrap env` prints the effective isolation roots for inspection.
Operators record that output, the daemon handshake, the allocated port, and
`hive-bootstrap verify` before relying on a new machine. A command must always
be invoked through the launcher. Calling the pinned binary directly is outside
the contract because it omits the private process home and socket roots.

## Live qualification

`bun run bootstrap:proof` creates a language-neutral Git repository with no
Hive package, installs the tagged release, and runs the bootstrap daemon and
the current development daemon simultaneously. While both are live, the proof
records:

1. exact version and checksum read-back;
2. distinct healthy handshakes and allocated ports;
3. distinct control and quota database identities and filesystem inodes;
4. each daemon's open runtime files, with no inode shared across roots;
5. two live tmux servers with distinct socket files and cross-invisible
   sessions; and
6. two positive controls: a memory write through the bootstrap API and a
   SQLite canary row written only to its control database, both visible in the
   bootstrap and absent from the development instance.

The ordinary proof buys no model turn. The credentialed end-to-end variant sets
`HIVE_BOOTSTRAP_ORCHESTRATION=1` and names an enabled live model with
`HIVE_BOOTSTRAP_CODEX_MODEL` before running the same command. It copies only the
operator's Codex authentication into the disposable private home, trusts only
the temporary neutral repository, configures read-only no-prompt autonomy,
spawns a real Codex worker, and waits for an exact `hive_send` receipt before
reaping the worker. The evidence records the model, agent state, receipt, and
reap result but never the credential.

The tmux manual defines `-L` as selecting a socket name that permits independent
servers, which is the external behavior the live socket test exercises:
[tmux(1)](https://man.openbsd.org/tmux.1). Database inspection follows SQLite's
database-list and on-disk identity model: [SQLite PRAGMA
reference](https://sqlite.org/pragma.html#pragma_database_list).

The proof fails closed on any missing positive control. An all-empty inspection
is not success: both writes must first be read back from the instance that made
them before their absence from the other instance counts as isolation.

The future removal-gate drain will execute from this bootstrap control plane.
That drain is deliberately not part of bootstrap establishment; no legacy
cleanup or terminal-removal behavior is added here.
