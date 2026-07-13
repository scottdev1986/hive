# Article Template

Format for compiled articles at `wiki/<topic>/<article>.md`. Named after the concept,
not the raw file that introduced it.

```markdown
# <Concept Name>

Updated: 2026-07-13
Sources: Andrej Karpathy, 2026-03-14; OpenAI, 2026-01-08
Raw: [Software 3.0](../../raw/llm/2026-03-14-software-3-0.md); [GPT-5 system card](../../raw/llm/2026-01-08-gpt-5-system-card.md)

## Summary

One or two sentences: the article's core thesis, stated plainly.

## <Section>

The compiled knowledge. Synthesize across sources rather than transcribing any one of
them.

## See Also

- [Related Article](related-article.md)
- [Cross-topic Article](../other-topic/cross-topic-article.md)
```

## Field rules

- **Updated** — when the article's *knowledge content* last changed. Not the file system
  timestamp; a typo fix does not move this date.
- **Sources** — author, organization, or publication name + date. Semicolon-separated.
  Plain text, not links.
- **Raw** — markdown links to the `raw/` files this article was compiled from.
  Semicolon-separated. From `wiki/<topic>/`, a raw file is `../../raw/<topic>/<file>.md`
  (two levels up to the project root).

## Conflicts

When a new source contradicts what the article already says, annotate the disagreement
with attribution rather than silently overwriting the older claim:

```markdown
> **Conflict.** Karpathy (2026-03-14) argues X. The GPT-5 system card (2026-01-08)
> reports Y. Unreconciled.
```

Place it in the section the conflict bears on. When the two claims live in *separate*
articles, annotate both and cross-link them under See Also.

## See Also rules

Links are relative to the current file: `article.md` for a sibling in the same topic,
`../topic/article.md` across topics. Cross-reference generously across topics — the
index groups by topic, so a cross-topic link is the only thing that surfaces a related
article to a reader who is not already looking for it.