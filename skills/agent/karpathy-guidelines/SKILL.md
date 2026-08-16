---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
license: MIT
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes, Eyes Open

**Touch only what you must. Fix what you find in your path.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't go hunting for work.
- Match existing style, even if you'd do it differently.
- The test is "not broken," not "not mine": things you meet on the way are part of the job, not a distraction from it.
- Consolidate genuine redundancy in your path — several ways of doing one thing, or duplicated logic in code you had to open anyway — because divergent implementations hide bugs.
- Fix a bug you discover; do not merely report it.

Both stop at the same line:
- The code must already be in front of you because of the task.
- The fix must fit the diff a reviewer is reading and must not change behavior the task never asked about.
- A format or lint refusal this repo's verification names is the tool's own edit — fix it as its own commit even if the file was not in the story; that is not hunting and not a scope expansion.
- If it is larger than the task, reaches another agent's files, or changes behavior outside your task, report it to queen and do not start the refactor.
- Unrelated dead code you never had to open is still mentioned, not deleted.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.

The test: Every changed line should trace to the user's request, or to something you had to touch to fulfill it.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
