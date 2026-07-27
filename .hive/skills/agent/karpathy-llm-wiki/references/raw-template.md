# Raw Source Template

Format for files under `raw/<topic>/`. Written once at Fetch, never modified afterward.

File name: `YYYY-MM-DD-descriptive-slug.md` (kebab-case, max 60 chars). Omit the date
prefix when the published date is unknown.

```markdown
# <Source Title>

Source: <url, or a description of where it came from if not a URL>
Published: 2026-03-14
Collected: 2026-07-13

---

<Original text.>
```

## Field rules

- **Source** — the URL. For pasted or offline material, describe the origin instead.
- **Published** — the source's own date. `Unknown` when unavailable.
- **Collected** — today's date, when you fetched it.

## Body rules

Preserve the original text. Clean formatting noise — navigation chrome, ad copy, cookie
banners, duplicated headers, stray escapes. Do not rewrite the author's opinions,
summarize, or reorder arguments: the wiki is where interpretation happens, this file is
the record it is interpreted from.