# Gate 4 post-patch-change corpus re-run attestation (Gate 10 export expansion)

Run completed 2026-07-18 on macOS 26.3.1 from source commit `9ff88d3b`
(branch `hive/esther-category-complex-coding-m1-b1`, based on main `ba31ca30`).
This run was required because the seventh export
(`hive_ghostty_surface_semantic_snapshot_v1`, patch
`0004-hive-semantic-snapshot.patch`) changed the patch series, patched tree,
bridge header, and exported-symbol list after the previous Gate 4 evidence was
recorded. The previous corpus (patched tree `a27fc0e7`, series `603bb8a1`) is
superseded by this one; its tuple-bound attestations were removed with this
re-run rather than left to mislabel the new identity.

## Qualified version tuple

- Upstream Ghostty commit: `73534c4680a809398b396c94ac7f12fcccb7963d`
- Upstream tree: `0aeaa44eda9efaf41523c3c0d4f6851eb81e536e`
- Patched tree: `d92dc8fe76f3cd7c13879b34c972c8eaa0ed3dcb`
- Patch-series SHA-256: `ddeaf79284f0072f29d69dbf6580fd8f58eba98ceff11525f83f91f03f6e09e0`
- Upstream public-header SHA-256: `36ca1c10cd07094abbf77cb14c2531899ca74c089a62f6f6cdeb07aa4927b2af`
- Bridge-header SHA-256: `275ca6b8d3af85d9e9addcdc4f4e0edc599cd8fba2f93b19fd3d1f089688fafe`
- Seven-symbol allowlist SHA-256: `16e34bd7e3776904a8b5c13b69ebb3a883dcd071f090ac57e32f95cdb61139e9`

## Corpus legs in this directory

- `qualify-ghostty-foundation.sh` full run: both-arch builds, seven-symbol
  allowlist comparison against the shipped static library, C/Zig/Swift ABI
  evidence (`symbols=7`, `row_size=48`, `snapshot_size=224`), build-id
  rejection on both architectures, manual-isolation probe stage inventories,
  signing evidence. Exit 3: complete except notarization submission
  (`notarization-status.txt` — credentials unavailable, unchanged from the
  previous corpus).
- `qualify-ghostty-reproducibility.sh` (3 clean builds): shipped runtime set
  byte-identical across builds a/b/c (`shipped-runtime-*.sha256`,
  `reproducibility-gap.txt`). Checkpoint fixture difference count in this run:
  0 (the previously recorded 2-byte Gate 6 serialization nondeterminism did
  not reproduce; that handoff remains B1.4's).
- `external-source-verification.txt`: upstream commit/tree/header and Zig
  archive identities re-fetched live from GitHub and ziglang.org and matched
  against the vendored pins.

The Gate 10 engine-scope export evidence (probe protocols on both
architectures, ASan run, allocation-contract proof, and the patch-series
missing-entry positive control) lives in
`raw/qualification/ghostty-b1-gate10-snapshot/`.
