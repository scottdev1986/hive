# Ghostty manual bridge fork contract v1

Status: frozen fork-contract candidate for cross-vendor review. Gate 1 passed
live on both architectures. Gate 4 passed through signing and creation of the
notarization-ready carrier; Apple submission remains blocked only by missing
notarization credentials and is not recorded as a pass. Gates 2, 3, and 5–10
remain outside this foundation increment. This is a Hive-owned fork contract,
not an upstream Ghostty embedding guarantee.

Repeated clean builds produced byte-identical XCFrameworks, libraries, SBOMs,
and XCFramework metadata. Eight arm64 checkpoint qualification fixtures varied
in two serialized bytes; that finding belongs to Gate 6 checkpoint determinism
and is retained as a B1.4 handoff rather than hidden or absorbed here.

The pinned upstream header says the embedding API is not yet general purpose
and that its only consumer is Ghostty’s macOS app. It defines process-owning
surface creation and the stock renderer/input callbacks, but it does not define
manual output ingestion, ordered output sequence numbers, or checkpoints. The
six operations below are therefore versioned and qualified as one indivisible
Hive contract. Upstream Ghostty and Ghostling do not provide evidence for it.

## Frozen source and toolchain

| Input | Frozen value |
|---|---|
| Upstream commit | `73534c4680a809398b396c94ac7f12fcccb7963d` |
| Upstream Git tree | `0aeaa44eda9efaf41523c3c0d4f6851eb81e536e` |
| Patched Git tree | `7a199af1796ec6681d7a462b5a64ec889552f16d` |
| Ordered patch-series SHA-256 | `77398dc2a90e642a41c42b26b6dd7e9eb26fa1841c103547c27cccd7390e25dc` |
| Upstream public-header SHA-256 | `36ca1c10cd07094abbf77cb14c2531899ca74c089a62f6f6cdeb07aa4927b2af` |
| Hive bridge-header SHA-256 | `7c065bfa1ebac11b6b2ce70a14b3c06b54377ad610bf8ce0ae0d1308864f64ea` |
| Six-symbol allowlist SHA-256 | `0ef7a18716a6bcf2a3ab1917584ed37f863a0ee183c88a037345ed55f4cc427f` |
| Zig | `0.15.2`; official arm64 archive `3cc2bab…fa6b`; official x86_64 archive `375b6909…b43f7f` |
| Apple toolchain | Xcode `26.6` build `17F113`; Swift `6.3.3`; Swift tools `5.10` |
| Deployment | macOS `14.0`; universal arm64 and x86_64 static slices |

The upstream commit, tree, and public header were fetched again from the
[pinned Ghostty tree](https://github.com/ghostty-org/ghostty/tree/73534c4680a809398b396c94ac7f12fcccb7963d)
and [pinned raw header](https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/include/ghostty.h)
during qualification. Zig version and archive identities come from Zig’s
[official 0.15.2 downloads](https://ziglang.org/download/#release-0.15.2).

## The six operations

1. `hive_ghostty_engine_build_id_v1` returns a nonempty, lowercase 64-digit
   hexadecimal identity. The identity binds checkpoint layout, engine inputs,
   and architecture. Attach and restore reject a different identity; no
   compatibility inference or fallback is permitted.
2. `hive_ghostty_surface_new_manual_v1` creates a renderer-backed terminal
   surface with host write and event callbacks but no subprocess or PTY.
3. `hive_ghostty_surface_process_output_v1` is the only operation that applies
   remote output. A nonempty byte range is accepted only at its declared
   ordered stream position, except for an exact previously accepted duplicate.
4. `hive_ghostty_surface_restore_checkpoint_v1` atomically replaces a manual
   surface from a valid build-bound checkpoint and resets its accepted output
   position to the declared through-sequence.
5. `hive_ghostty_terminal_checkpoint_export_v1` allocates an opaque bounded
   checkpoint through the caller’s allocator and reports its exact length.
6. `hive_ghostty_terminal_checkpoint_import_v1` replaces a compatible
   terminal from an opaque checkpoint and rejects a wrong build, truncation,
   corruption, or invalid size.

There are exactly six globally exported names with the `hive_ghostty_` prefix.
Adding, removing, renaming, or versioning another such name is an ABI change and
must fail the allowlist check.

## Manual-mode isolation

Manual creation uses only the platform handle, userdata, scale, font, and
surface-context portions of the stock surface configuration. Working directory,
command, environment entries, initial input, and wait-after-command are inert.
They do not select or launch a child, shell, hidden command, or PTY; they do not
seed terminal output; and they do not emit host input.

Only ordered `process_output` calls mutate remote terminal output state. Bytes
generated toward the host by terminal input or protocol replies are delivered
only through the registered write callback. Ordinary remote output does not
echo through that callback.

The stock process queries have no process truth to report in manual mode and
use explicit unsupported sentinels: process-exited is false, foreground PID is
zero, and TTY name is empty. Consumers must treat those three values as
unsupported for a surface they created manually, never as evidence for a live
process, an exited process, or a real TTY.

Qualification observes the probe process before creation, after creation,
after ordered output and host input, and after free. Every stage must show no
descendant process and no PTY descriptor. The creation stage deliberately
supplies a long-lived command and impossible working directory, so any accidental
process path remains observable instead of racing to exit. File-descriptor,
thread, process-tree, and sampled-stack inventories are retained with the run.

## ABI and shipment rules

All six functions and all three callback types use the C calling convention.
The result values are success `0`, out-of-memory `-1`, invalid-value `-2`,
out-of-space `-3`, and no-value `-4`. Event values are invalidate `1`, title
`2`, working-directory `3`, bell `4`, clipboard-denied `5`, and close-request
`6`.

On both supported 64-bit macOS architectures, the event enum has size and
alignment 4. The event structure has field offsets 0, 8, and 16; size and
stride 24; and alignment 8. Independent C, Zig, and Swift programs assert
these values at compile time and runtime. The Swift program also resolves and
calls the real static archive, while the archive symbol inventory is checked
separately for each slice.

The deliverable contains universal arm64 and x86_64 static code, the upstream
license and transitive notices, an SBOM, exact source/toolchain provenance, and
no `.dylib` or `.so`. Its Mach-O members may not require a newer deployment
target than macOS 14.0. The build runs offline from verified, bundled toolchain
and dependency caches; a user-installed Ghostty or Zig is neither searched nor
used.

Every qualification run performs three clean source builds and hashes the full
shipped runtime set (XCFramework, lib-vt slices, notices, and SBOM). The guard
fails on any byte drift, including metadata ordering, and retains all three
manifests and hash lists as evidence.

The qualification evidence also records a Gate 4 portability limitation:
static archives retain absolute build-directory references. Runtime artifacts
reproduce at the fixed content-addressed build path, but archive bytes are not
yet path-independent; this remains a documented follow-up for release review.

The notarization carrier is signed with a Developer ID Application identity,
secure timestamp, and hardened runtime, then strictly verified and packaged as
the exact ZIP submitted by `notarytool`. Apple requires Developer ID signing,
hardened runtime, and secure timestamp before notarization, and only an
`Accepted` service result is a notarization pass
([Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[custom workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)).
Missing credentials are recorded as an environment gap, never converted to a
pass.

## Upgrade and rollback

An upgrade begins from a newly fetched upstream commit and tree. Re-establish
the upstream header hash from the live source, rebase the ordered Hive patch
series cleanly, record the patched tree and every source/toolchain hash, and
rebuild with empty work and output directories using only the verified offline
cache. Re-run all ten M1-B1 gates and the complete conformance corpus on both
architectures. No hash or build identity is updated merely to bless an existing
binary.

Every shipped artifact retains its immutable manifest, licenses, SBOM, ABI
results, live isolation inventories, signature evidence, notarization result,
and full-corpus result. Keep the previously accepted signed artifact available
until the replacement has passed review and deployment.

Rollback stops new surface admission, drains or closes surfaces using the new
identity, atomically reselects the previous accepted artifact, and verifies its
manifest, signature, notarization ticket, and six-symbol ABI before admission
resumes. A checkpoint is restored only by the exact matching build identity and
architecture. Otherwise the host supplies a fresh compatible snapshot or
ordered replay; rollback never mislabels an incompatible checkpoint as usable.
