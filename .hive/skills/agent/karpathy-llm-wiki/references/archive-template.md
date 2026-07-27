# Archive Template

Format for a Query answer saved into the wiki, at `wiki/<topic>/<query-topic>.md`. Only
written when the user explicitly asks to archive an answer.

```markdown
# Transformer Architectures Overview

Archived: 2026-07-13
Sources: [Attention Mechanisms](attention-mechanisms.md); [Scaling Laws](../llm/scaling-laws.md)

## Answer

The synthesized answer, as it was given in the conversation.
```

## Field rules

- **Archived** — today's date. An archive page is a point-in-time snapshot, so this date
  never moves and the page is never cascade-updated.
- **Sources** — markdown links to the *wiki articles* the answer cited, semicolon-separated.
  Paths are relative to this file: `article.md` for a sibling, `../topic/article.md`
  across topics. Rewrite the project-root-relative paths used in conversation
  (`wiki/topic/article.md`) into this form.
- **No Raw field.** An archive page is synthesized from the wiki, not compiled from
  `raw/`. Nothing here traces back to a source file.

## Rules

- Always a **new** page. Never merge an archived answer into an existing article — it is
  a synthesized answer, not source material, and merging it would let the wiki cite
  itself as evidence.
- File name reflects the query topic, not the question as phrased.
- In `wiki/index.md`, the Summary is prefixed `[Archived]`.