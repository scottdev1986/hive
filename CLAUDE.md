# hive

A macOS CLI that runs an AI orchestrator which spawns and coordinates coding agents (Claude Code, Codex) across terminal windows. See SPEC.md for the full design.

## Documentation rules

- **SPEC.md is the living design source of truth**, written in Karpathy style. Read it before any design or architecture work; its decisions are binding unless the user changes them.
- **Use the `karpathy-docs` skill** (`.claude/skills/karpathy-docs/`) whenever you make or change a design decision, resolve an open question, complete or move a roadmap item, or write any new long-form document. Update the doc in the same turn as the triggering work — not as a follow-up.
- Never append changelog-style updates to these docs; edit in place so they always read as if written today. When a decision changes, the old choice is preserved as a rejected alternative with why it lost.
