# Preserved-ref deletion ledger — 2026-07-25

This ledger was verified against `main` immediately before deletion.  A `git
cherry -v main <tip>` result of only `-` means every commit has a patch-equivalent
payload in `main`; the other reasons name the source/evidence check actually
performed.  The full object name is recorded because deleting a ref makes its
objects eventually GC-able.

| Ref | Full tip SHA | Verified reason |
|---|---|---|
| `b25-production-pane-david-5b448217` | `5b4482177a16b5f8ef2ce9c44e919350d50ffee0` | All commits are patch-equivalent to `main`. |
| `b25-production-pane-first-rebase-0aa486b3` | `0aa486b39246b6294ff21466059da0fa32d24ddc` | All commits are patch-equivalent to `main`. |
| `b25-production-pane-pre-rebase-42e74c55` | `42e74c55825c1dcbb14dede80f03f1f082f75595` | All commits are patch-equivalent to `main`. |
| `b25-production-pane-second-rebase-a1f73119` | `a1f73119e955a551497c5bb33916b734bfed3f0f` | All commits are patch-equivalent to `main`. |
| `harold-detached-973f41cc` | `973f41cccd3a84a6c360d88d1a3337cf9c6ad056` | All commits are patch-equivalent to `main`. |
| `hattie-continue-a-crashed-agent-s-wor` | `963a6f35412300909c68f2f961aaf74f979b3e93` | All commits are patch-equivalent to `main`. |
| `horace-detached-fac2db0b` | `fac2db0b4e3c3b61be58090629c461dda5fd5c97` | All commits are patch-equivalent to `main`. |
| `hive/anna-advance-github-issue-6-m1-a4-c` | `b47adf07109ffbb531ede4c80c09dfaca85004f9` | All commits are patch-equivalent to `main`. |
| `hive/boris-independent-audit-fix-of-the-m` | `38f828050c1e531a47de5a6d5bd320f1c020d625` | All commits are patch-equivalent to `main`. |
| `hive/chris-m1-b1-remainder-increment-3-pi` | `aaa57149cc14d2ef97475b9f05b9d9c1bec4bf84` | All commits are patch-equivalent to `main`. |
| `hive/camila-story-m1-a2-respawn-sessiond-h` | `61d390c6d8a8a5f2a8d7e514597411ba7d67a0ac` | All commits are patch-equivalent to `main`. |
| `hive/crystal-m1-a2-production-sessionhost-b` | `49ef46026b7a94a3ae325fdbd5db3897bd2a4cb6` | All commits are patch-equivalent to `main`. |
| `hive/candace-story-m1-a2-cp-frozen-control` | `d5f2ef82efaffceb681fe826b9d22520cb4c681f` | All commits are patch-equivalent to `main`. |
| `hive/chiara-m1-a2-cp-native-ops-the-termin` | `70b0769a08b8d5b6f350e1ce5e2bfad2b0cd63ca` | All commits are patch-equivalent to `main`. |
| `hive/clinton-m1-a2-cp-native-ops-terminate` | `b032958ed2bb8415132a5d2841cfd757ba97feb9` | All commits are patch-equivalent to `main`. |
| `hive/david-m1-b2-github-issue-8-wire-hive` | `7f54d42742ccfe9364718ae5d1590ba6a0b7fc9f` | All commits are patch-equivalent to `main`. |
| `hive/james-m1-b2-b2-5-continuation-github` | `5ca587f6bfd2f0bd8a7c98c0eced4ee709353905` | All commits are patch-equivalent to `main`. |
| `hive/lucas-github-issue-95-resume-path-co` | `3696a30093aba46747f2c05831963e5de6308523` | All commits are patch-equivalent to `main`. |
| `hive/lucas-hold-do-not-hive-land-your-bra` | `5904b99e8c804d91ebde3493e58d68a3ce282982` | All commits are patch-equivalent to `main`. |
| `hive/priya-github-issue-95-resume-path-co` | `045b32684a3af493ecd07b298eab2628dc81ce00` | All commits are patch-equivalent to `main`. |
| `duncan-gate10-groundwork` | `943407ba1b5d360a7c1c460b307b72776aa4325f` | Its Gate10 semantic-snapshot payload is superseded by `main` commit `280352d8` and current Gate10 probe/tests. |
| `hive/duncan-category-complex-coding-m1-b1` | `943407ba1b5d360a7c1c460b307b72776aa4325f` | Same tip as `duncan-gate10-groundwork`; its Gate10 payload is superseded on `main`. |
| `harvey-followup-1005-1015` | `10cf6e44ebd84874edf34a0eb55e22c8c8642db4` | The unique DECSET 1005/1015 path payload is byte-identical to ancestor `main` commit `56b2f012`. |
| `harvey-residual-nits-hardening` | `7c7630d3fb04d252c11edf8e98b593a7c77c6af3` | The unique acceptance-matrix path payload is byte-identical to ancestor `main` commit `371d1e94`. |
| `helena-production-sessiond-lifecycle` | `fdfc36174b3a8be2b6458d5dfc82d527bc97ef77` | Its 14-file broker-lifecycle payload is the same later landed implementation at `main` `adc5df1b`. |
| `hive/calvin-implement-gate-6-option-d-user` | `7dc3ec0f1226f73e6a751c61e59772c4f3b6cd6f` | Its only non-patch-equivalent surface-restore symbols are present in current `main`. |
| `hive/chester-m1-b1-gate-6-option-d-finalize` | `7dc3ec0f1226f73e6a751c61e59772c4f3b6cd6f` | Same tip as calvin; its surface-restore symbols are present in current `main`. |
| `hive/cindy-m1-b1-gate-6-option-d-finalize` | `81c1a84b77fa73913c6f2bf37b60876f24c0025e` | Its surface-restore payload is superseded by the current `main` Gate6 implementation. |
| `hive/james-implement-the-remaining-half-o` | `655f8820fb71dbc2a1843b960e0f04e9a00baa10` | `main` contains the later same-subject liveness fix at ancestor `ceda3b74`. |
| `hive/sarah-complete-github-issue-34-m1-a0` | `69c6dbb805469897609d011e749defbc0f42a5d4` | Current `main` carries its A0 B/D/E/K discriminator tests and a stricter replacement for F. |
| `hive/zoe-complete-github-issue-34-m1-a0` | `954c02f44c90a5d5302a38b207bf77a19f16ad91` | Byte-identical A0 payload to Sarah’s superseded work. |
| `hive/lucas-three-planning-deliverables-fr` | `bf5455b28155b66b063d3cf2ab4818ff03de646d` | Its adopted M3 planning body is on `main` at `0c994807`; current story docs carry `ADOPTED`. |
| `gate6-pin-d7a9104f` | `d7a9104f71023a96c14c6643e04b3dadd8ac035c` | Superseded by ancestor `main` replay commit `a41e23df`, including the serializer and restore fixes. |
| `gate6-pre-rebase-backup` | `1d185bb06066a8b5886355f1cfb1469297f083d4` | Earlier backup of the Gate6 series superseded by `main` replay commit `a41e23df`. |
| `hive/devon-category-code-review-cross-ven` | `104d68716866c66cf3d5c506e588b743dce58507` | Historical raw B1 review evidence pinned to the now-superseded foundation review. |
| `hive/dexter-category-code-review-delta-cro` | `0783c7f81e9b9b4e384c39d4f7ed8ef491389604` | Raw review evidence explicitly frozen at `a7ff468c`, an ancestor of `main`. |
| `hive/deborah-cross-vendor-review-build-capa` | `f7eb2bb90dcaded36d8332f9fe8cc521ecd7995d` | Historical review evidence; its `ce4b7e00` production payload is patch-equivalent to `main`, and the companion is marked `-noland`. |
| `hive/helga-fix-two-review-blockers-on-the` | `c4618c42890f2e406dd8f5d2d807bacfa066cee0` | Explicit quota-pause handoff doc; successor B2.5 evidence/closure is now in `main` `raw/qualification/`. |
| `hulda-occlusion-reference-02bb827d` | `02bb827de6c4266a5901167d040e6469c475406e` | Debug/evidence snapshot for a fixed occlusion/attach-journal bug; current `main` has the production behavior. |
| `hive/sam-verification-tripwire-for-the` | `ba3d0a39afede2558e507ad249405750bac069d4` | The sole commit subject says `never land`. |
| `sam-70-stop-gate-tripwire` | `ba3d0a39afede2558e507ad249405750bac069d4` | Same `never land` tripwire commit as the Hive-namespaced ref. |

Not listed means deliberately retained: the five C1.3 refs are excluded while
`c13` lands Nina’s ref; Geoff and its dirty snapshot remain live work; Amber’s
large production-create WIP needs a separate decision because the rebuilt
broker is not byte-identical evidence of supersession.
