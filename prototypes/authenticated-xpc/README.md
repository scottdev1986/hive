# Authenticated XPC prototype (blueprint hypothesis 3)

Runnable evidence for **"Authenticated IPC and capabilities"** in
[`docs/architecture/hive-workspace-blueprint.md`](../../docs/architecture/hive-workspace-blueprint.md).
The blueprint says authentication and authorization are separate concerns and
makes four falsifiable claims. This prototype proves all four with real signed
processes and a real launchd Mach service.

## Run it

```
./run-evidence.sh
```

Requires the macOS SDK and `codesign` (both present in a standard Xcode install).
It builds release binaries, ad-hoc-signs three peer identities, registers a
launchd Mach service in the caller's `gui/<uid>` domain, runs every check, prints
a PASS/FAIL table, and exits non-zero on any failure. It cleans up the launchd
job on exit. No entitlements, no notarization, no root.

Unit tests for the capability core (no OS machinery):

```
swift test
```

## What each hypothesis is and how it is proven

| # | Claim | How it is shown | Result |
|---|-------|-----------------|--------|
| H1 | A public code-signing requirement rejects an unsigned/hostile client that knows the endpoint | One `codesign`-signed peer binary is copied and re-signed with **three** identities — trusted cdhash, a *different* (hostile) cdhash, and no signature. All three call the same guarded Mach service. | trusted **ALLOWED**; hostile **REJECTED** by the XPC requirement; unsigned **SIGKILLed at exec** by the kernel |
| H2 | An anonymous endpoint alone is only a bearer address, not identity | The same hostile client fetches a real `NSXPCListenerEndpoint` from an *unauthenticated* rendezvous service, then uses it. It is served through the `open` listener (no requirement) and rejected through the `guarded` listener (same shape + requirement). | open **ALLOWED**, guarded **REJECTED** — identity came from the requirement, not the address |
| H3 | Connection-bound capabilities whose methods omit tenant IDs restrict subject/action (no confused deputy) | Capability methods carry **no `subject:` and no `tenant:`**; authority is the grant captured on the connection. Writer/orchestrator/agent allowlists are exercised; a deliberately-vulnerable `legacyLand(subject:)` reproduces the confused deputy the tenant-free methods prevent. | writer lands only its own branch, cannot spawn/approve/kill/read-global; orchestrator spawns/approves but **cannot land**; one-shot land is spent on success, released on a lost race, replay-denied; revocation advances the epoch |
| H4 | CLOEXEC capability descriptors do not reach descendants | A three-process tree (broker → agent → **hostile grandchild**). The broker opens a capability fd marked `FD_CLOEXEC` and a control fd without it. The grandchild actively tries to read both by their known fd numbers. | CLOEXEC fd **not readable** (EBADF); the non-CLOEXEC control fd **is** readable — proving the test observes a real leak when nothing stops it |

## Key design facts the prototype establishes

- **`NSXPCListener.setConnectionCodeSigningRequirement`** (macOS 13+) rejects a
  non-matching peer *before* `shouldAcceptNewConnection` is consulted, and works
  on both anonymous and Mach-service listeners. That is what lets H2 A/B the same
  anonymous endpoint with and without a requirement.
- **Two independent rejection layers for "unsigned."** On Apple Silicon a truly
  unsigned binary is `SIGKILL`ed by the kernel at `exec` (rc 137) and never
  reaches XPC. A *validly ad-hoc-signed but untrusted* binary does run and is
  rejected by the signing requirement. The meaningful adversary for "knows the
  endpoint" is the second one; the harness proves both.
- **The confused-deputy defense is structural, not a check.** Because
  `authorize()` and every wire method take no subject, alex's connection cannot
  *express* maya's identity. `legacyLand(subject:)` exists only to demonstrate
  the vulnerability the omission removes.
- **One-shot land is reserved-then-committed**, so a writer whose fast-forward
  merge loses a race is not permanently stranded — the right is released and the
  writer may retry. Consumed only on success. (Aligned with the Phase 0 HTTP
  control plane so both planes audit the same event names.)

## Layout

- `Sources/HiveCapability/` — transport-free capability registry + rights matrix. Unit-tested.
- `Sources/HiveXPCProtocol/` — the two `@objc` protocols. Read the signatures: no method takes a tenant or subject except the vulnerable `legacyLand`.
- `Sources/hive-proto-server/` — vends listeners; applies the signing requirement; binds one capability per connection; emits an audit line per decision.
- `Sources/hive-proto-peer/` — one client binary, signed three ways.
- `Sources/hive-proto-fdtest/` — the broker→agent→grandchild CLOEXEC adversary.
- `run-evidence.sh` — the end-to-end harness.

## Scope and honest limits

- Ad-hoc signatures and cdhash requirements stand in for a real Developer ID /
  team-identifier requirement. The API surface and rejection behavior are
  identical; only the requirement *string* changes in production
  (`anchor apple generic and certificate leaf[...] and identifier "..."`). The
  `req-anchor-apple` listener is present as a placeholder for that swap.
- launchd registration uses the per-user `gui` domain, matching a signed
  `SMAppService` agent's domain. It does not test the Supervisor's own signing.
- This proves the IPC boundary. It is not the Phase 0 daemon-auth implementation
  (that is maya's HTTP control plane); the two share a rights matrix and audit
  vocabulary by design.
