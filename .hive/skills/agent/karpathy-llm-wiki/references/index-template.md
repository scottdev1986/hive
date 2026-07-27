# Index Template

Format for `wiki/index.md`. One row per article, grouped by topic. This is the file a
Query reads first to decide what to open, so every article must appear here.

```markdown
# Knowledge Base Index

## llm

How language models are built, trained, and evaluated.

| Article | Summary | Updated |
| --- | --- | --- |
| [Software 3.0](llm/software-3-0.md) | Prompts as the new program; the model as the runtime. | 2026-07-13 |
| [Scaling Laws](llm/scaling-laws.md) | Loss falls as a power law in compute, data, and parameters. | 2026-05-02 |

## agents

Systems that plan and act over multiple steps.

| Article | Summary | Updated |
| --- | --- | --- |
| [Tool Use](agents/tool-use.md) | (no summary) | 2026-06-19 |
| [Context Windows vs. Memory](agents/context-vs-memory.md) | [Archived] Why retrieval does not replace a persistent store. | 2026-07-01 |
| [Reflexion Loops](agents/reflexion-loops.md) | [MISSING] File not found at this path. | 2026-04-11 |
```

## Rules

- **Paths** are relative to `wiki/index.md`, so they read `topic/article.md`.
- **Topic sections** get a one-line description under the heading when the topic is
  first created.
- **Updated** mirrors the article's own Updated field — when its knowledge content last
  changed, not the file system timestamp.
- **`[Archived]`** prefixes the Summary of a page created by archiving a Query answer.
- **`[MISSING]`** prefixes the Summary when Lint finds an entry whose file does not
  exist. The row stays; deleting it is the user's call, not yours.
- **`(no summary)`** is the placeholder Lint writes when it finds an article on disk
  that the index never listed.