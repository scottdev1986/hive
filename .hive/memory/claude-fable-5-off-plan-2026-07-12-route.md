---
title: Fable 5 stays supported forever; auto-routing to it ends 2026-07-12; Opus 4.8 first-class
date: 2026-07-10
tags: [routing, models, quota, deadline]
---

User decisions (Scott, 2026-07-10, refined twice same day): (1) DO NOT REMOVE FABLE — claude-fable-5 remains a fully supported model in Hive's model set, adapter, config, and quota plumbing permanently; explicit spawns may always choose it. (2) On 2026-07-12 Fable moves to usage-only billing and off Scott's plan: from that date routing must not AUTO-select Fable (explicit opt-in only); before that date, existing default routing to Fable stays. (3) Claude Opus 4.8 must be first-class (model set + quota pool), and routing should choose it "when appropriate" — capacity pressure and explicit choice are valid reasons even before the 12th (Fable draws heavy capacity). Verify exact Opus model ID against live Anthropic docs; `claude --model claude-opus-4-8` worked locally 2026-07-10. Agent hana tasked 2026-07-10; SPEC.md is authoritative once it documents this.
