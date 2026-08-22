---
name: code-comments
description: Write or review comments that live next to code. Use when adding, editing, or cleaning comments. File-top comments are forbidden. Keep only a non-obvious why the code cannot show.
---

# Code comments

A comment earns its place only when it tells the reader a why the code cannot. If the names and types already say it, write nothing.

Deleting a bad comment is a complete fix. Do not replace it with a shorter restatement.

## File headers

Do not put comments at the top of a file. The file name and its exports already say what it is. A leading essay, a one-line restatement of the file name, and a JSDoc block before the first import are all noise.

Machine directives may lead: shebang, `oxlint-disable`, `@ts-nocheck`, SPDX.

A `SAFETY:` comment belongs on the assertion it justifies, not in a file banner.

## What to write

Next to the code that needs it, in one or two short sentences:

- Why this looks wrong but is right
- Why this number, timeout, or order
- Why this path is rejected
- The invariant a type assertion needs, as `SAFETY:`

```typescript
// Oldest first. Newer items are more likely to change again, so doing them last wastes less work.
queue.sort((left, right) => left.createdAt - right.createdAt);

// SAFETY: decodeUsageTokens already admitted this object as a usage payload.
const usage = payload as UsagePayload;
```

Skip getters, restated names, phase narration (`// Phase 1`), and anything that points at a plan, ticket, or doc. If the explanation must exist, put it in the comment. A bug-report URL is evidence, not a substitute for the why.

## Function docs

Skip them when the signature is the contract. Write a short block only for a non-obvious return, a side effect, or an edge the types cannot name. Do not list `@param` for things the type already names.

## TODOs

Actionable and owned. `TODO(name):` plus what blocks it. Date workarounds so someone knows when they can go.

## Review

Delete comments that restate the code, have drifted, or sit at the top of a file. Never change behavior while reviewing comments.
