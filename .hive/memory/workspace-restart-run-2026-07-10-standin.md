---
title: Workspace restart run 2026-07-10: standing orders and pending follow-ups
date: 2026-07-10
tags: [orchestration, workspace-restart, follow-ups]
---

Scott's standing orders for the Workspace restart build (2026-07-10, 8 agents live): (1) shut each agent down (hive_kill + worktree cleanup) as soon as its work is landed and reported — do not leave finished agents running; (2) after the new Workspace UI (agent sam, Fable 5, workspace/ directory) lands, spawn a cheap docs agent to update README.md to reflect what shipped; (3) UI design rule: Hyprland inspires tiling behavior only — visuals must be macOS-native per Apple HIG (sam acked, zero rework); (4) orchestrator envelope injection must never disrupt the human's in-progress typing — agent leo is fixing the daemon delivery path and updating SPEC.md. Daemon landing order agreed among agents: maya (Phase 0 auth) lands first; david (reuse handshake, binding opaque hiveUuid + identityKey + repoFamilyKey from nina's registry-backed resolver, NOT a canonical-root hash) and leo rebase over her.
