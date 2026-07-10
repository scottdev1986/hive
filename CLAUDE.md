# hive

A macOS CLI that runs an AI orchestrator which spawns and coordinates coding agents (Claude Code, Codex) across terminal windows. See SPEC.md for the full design.

## Documentation rules

- **SPEC.md is the living design source of truth**, written in Karpathy style. Its decisions are binding on any design or architecture work unless the user changes them. **Read it by section, never whole** — it is ~19K tokens. A Hive spawn already embeds the sections your task names, with `path:line` pointers to the rest; follow a pointer when you need more, and otherwise grep for the heading you want (`grep -n '^#' SPEC.md`) rather than opening the file.
- **Use the `karpathy-docs` skill** (`.hive/skills/karpathy-docs/`) whenever you make or change a design decision, resolve an open question, complete or move a roadmap item, or write any new long-form document. Update the doc in the same turn as the triggering work — not as a follow-up.
- Never append changelog-style updates to these docs; edit in place so they always read as if written today. When a decision changes, the old choice is preserved as a rejected alternative with why it lost.
