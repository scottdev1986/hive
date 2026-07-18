# Gate 4 post-patch-change corpus re-run attestation

Run completed 2026-07-18 on macOS 26.3.1 from then-current main commit `33760753be400047e4be69ed59497ded52cfda8b` and repository tree `fad1af1d75fb8a680eb225e38e6a4657d631dad8`. This run was required because the patch series and patched source tree changed after the original Gate 4 evidence was recorded.

## Qualified version tuple

- Upstream Ghostty commit: `73534c4680a809398b396c94ac7f12fcccb7963d`
- Upstream tree: `0aeaa44eda9efaf41523c3c0d4f6851eb81e536e`
- Patched tree: `a27fc0e76555552cf7202c98fb1a31b2021bcf26`
- Patch-series SHA-256: `603bb8a1ef795b59c6b2e7a3de5d78b4cdab59bb68e6f4557d71e0cc17af225b`
- Upstream public-header SHA-256: `36ca1c10cd07094abbf77cb14c2531899ca74c089a62f6f6cdeb07aa4927b2af`
- Bridge-header SHA-256: `0430ec399c61ab67fe68f61c2318890e87946e0bf3443c23ff14106c88e40c36`
- Symbol-list SHA-256: `0ef7a18716a6bcf2a3ab1917584ed37f863a0ee183c88a037345ed55f4cc427f`
- Toolchain-lock SHA-256: `98bb11e48515eb3cd347f41ab914c60457f52c554af425b6745e3aebf9f7bc4a`
- Zig: `0.15.2`; arm64 archive SHA-256 `3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b`; x86_64 archive SHA-256 `375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f`
- Apple toolchain: Xcode `26.6` build `17F113`, Swift `6.3.3`, Swift tools `5.10`; deployment target `14.0`

The cache was warmed only from a sibling artifact whose manifest matched the current patched-tree, patch-series, bridge-header, and Zig identities. Production preflight then independently verified both Zig archives and all 36 locked Ghostty dependencies from the project-local cache. The clean-build driver deleted the warmed artifact and regenerated it from the verified vendored tree before the corpus used it. The regenerated artifact manifest again recorded the patched tree and patch-series identities above; its SHA-256 is `15c49f272f6b64410cdba7fbce2da9d4d37d4d9e5b261eb10b42d5a92b103d05`.

## Corpus results

Three clean builds completed. Their build logs were byte-identical at SHA-256 `9be7bcbd25d1815254b53346de5ef8b54826bfbe02576d0661796b01285ac396`. The three regenerated manifest SHA-256 values are `5adac14ef225ff232ef624dba0d16e1dcd0f8c011f0ba9c83f4c6661ad411ed5`, `8e89851990d177931412685e9bf95c0150e40f4dafef16d962626f85d6bad90a`, and `15c49f272f6b64410cdba7fbce2da9d4d37d4d9e5b261eb10b42d5a92b103d05`; every manifest records the qualified patched tree and patch-series digest. All 79 files in the shipped runtime set—GhosttyKit, both lib-vt slices, notices, and the SBOM—were byte-identical across the three builds. The runtime inventory SHA-256 is `79b25b536af1dccfd5217ddad3d21c542c4937f5f49bbcf38a9e5646475aebd1`; the SBOM SHA-256 is `12cd21701d8f43fd0313dfa7f61547c7f3ce29883ed71009ab684d9a2e8d3576`. Eight arm64 checkpoint fixtures retained the previously recorded nondeterministic byte outside the shipped runtime set; that Gate 6 handoff does not alter the Gate 4 runtime reproducibility result.

The reproducibility driver was captured by direct stdout/stderr redirection with no pipeline. It returned exit code 0 after emitting its terminal qualification message; the committed run-log SHA-256 is `97179ee44eeba1eadd0d9003c676a40bcb9ed0b7ea05130018770809fead6d22`. The foundation driver was captured the same way. It returned exit code 3 only after completing the corpus and recording that notarization credentials were unavailable; its committed run-log SHA-256 is `dc5f6fda46e8e4891c2c827db03c177e598fd9db96fb20b17a8f03d6f97878f2`.

C and Zig assertions passed for arm64 and x86_64: pointer size 8, enum size 4, enum alignment 4, event size 24, event alignment 8, C calling convention, and six declarations. Swift compile-and-runtime assertions passed on both architectures with the same values. The resulting engine build IDs were `0762764116c83a45a14251322dc2a3b34e9b67851797ec60e199466352799972` for arm64 and `e8e456c5ac7481d52c255517fea236403715b52f3194d0cdd98e89bf29f06f19` for x86_64.

Both architecture slices exported exactly this allowlist and no additional `hive_ghostty_*` symbol:

```text
hive_ghostty_engine_build_id_v1
hive_ghostty_surface_new_manual_v1
hive_ghostty_surface_process_output_v1
hive_ghostty_surface_restore_checkpoint_v1
hive_ghostty_terminal_checkpoint_export_v1
hive_ghostty_terminal_checkpoint_import_v1
```

The foreign-engine checkpoint rejection test passed independently on arm64 and x86_64. The universal library reported both `x86_64` and `arm64`. Artifact inspection found zero dynamic libraries, the signed carrier linked zero non-system dynamic libraries, and 66 bundled license or notice entries were inventoried. Developer ID signing verified the carrier as valid on disk and satisfying its designated requirement. The signed carrier SHA-256 was `47f620c3efa74a865aef43ba178273c8fcb99ff2014ff1111bc46bc2ec719d39`.

Notarization was not resubmitted because the three notarization credentials were unavailable. The generated submission archive SHA-256 was `9e78e3c449113335a80eb3d647f2c958dd2d6c1654815223e97d7054a3c90582`; the resulting status is `blocked_missing_MACOS_NOTARY_credentials`, unchanged from the original accepted Gate 4 evidence and not a regression caused by the patch regeneration.

The committed evidence index was regenerated only after the foundation outputs, all three reproducibility manifests and inventories, and both direct-capture logs were placed in their final evidence set. Together, these results attest that the exact six-symbol ABI and build-ID rejection contract still hold on both architectures after the current patch-series regeneration. Any change to the qualified tuple invalidates this attestation and requires the full corpus to run again.
