# Stranded branch disposal — 2026-07-13

These six branches were deleted after their work was found on main or deliberately superseded. Their tip commits remain recoverable: run `git branch <branch> <tip>` to restore any branch exactly as it was before disposal.

| Branch | Tip | Verdict | Superseded on main by |
| --- | --- | --- | --- |
| `hive/boris-update-readme-md-to-document-g` | `f9b41d22f446d6baae79963f3abdcdc5bcad75c2` | README changes are already on main byte-for-byte. | `0f05300`, `0094f08` |
| `hive/chad-architect-design-the-optimal-r` | `03470cfb66ccaea85728e338525dd74a663a4f20` | Source proposal is provenance only; the reconciler kept its accepted decisions and overruled the rest. | `dc1ba5a` |
| `hive/chandra-architect-design-the-optimal-r` | `1e504e18d19ef844a75570e98928e4dec5ca7328` | Source proposal is provenance only; the reconciler kept its accepted decisions and overruled the rest. | `dc1ba5a` |
| `hive/chiara-reconciler-judge-two-independe` | `5a7a74f78ba664606fa50320d91dd149dce3c686` | Reconciler draft was landed with factual corrections as the governing design. | `dc1ba5a` |
| `hive/cole-ui-audit-fresh-look-and-feel-d` | `db25d394c16debba0095b9a5f75efd7ac7a89b80` | The full audit is on main with an additional implementation-status clarification. | `b5908a7` |
| `hive/grok-fix-bug-in-the-model-control-cente` | `82e0fc33f3ac78f7288670a11c912e201e26fa9d` | **DISCARD:** admitted measured Grok 0.2.99 catalog identity and its live-fetch signal, but the commit is an exact duplicate: same parent, tree, and stable patch ID as the commit already on main. | `80cebfd` |
