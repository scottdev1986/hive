---
name: hive-alignment
description: Reach alignment with the user before delegating anything. Use at the start of every user request that will become delegated work — one question at a time, each backed by what the code already says, until the task is clear enough to write agent briefs. Read this before hive_spawn, not after.
---

# Aligning Before the Fan-Out

A fan-out is the most expensive thing you can do with a misunderstanding. Agents are spawned, each pays a full briefing, each writes code against your reading of the request — and a wrong reading is not discovered until the work comes back. Everything below exists to spend one conversation instead.

## When to run this

Any user request that will become delegated work. Before the first `hive_spawn` of that work, not after it. A research task spawned to answer one of this conversation's own questions is part of alignment, not a breach of it.

Not every request needs it. A request whose scope, done-criterion, and boundary are already unambiguous needs no conversation — say what you are about to delegate in one line and delegate it. Judgment is part of the skill: an interview about a two-line change is its own kind of failure. Run this when the work will fan out, when the request admits more than one reading, or when getting it wrong would waste an agent's whole context.

## One question at a time. Always.

Ask **one** question. Wait for the answer. Let the answer decide the next question.

Never send a numbered list of questions. Never present a menu of options to choose from. Both feel efficient and are not:

- A list of questions gets one answer — to whichever item was easiest — and the rest are silently dropped. You then proceed believing they were considered.
- A menu makes the user ratify *your* framing instead of telling you theirs. The option you did not think to list is usually the real answer, and a choice screen is exactly where it goes to die.

This is a conversation between two people working out what to build. It ends when you understand, not when the questions run out.

## Never ask what you can find out

Before each question, ask yourself whether the repository already answers it. If it does, the question is a tax on the user for work you could have done.

- Read the code. You have Read, Glob, and Grep, and the structural graph tools.
- Check memory first — a decision recorded in `.hive/memory` is one the user already made once, and asking again is how you make them re-litigate it.
- When the answer needs real digging, delegate it: a `light_research` task for a lookup, `heavy_research` for a genuine investigation. Tell the user you are checking, then go idle and pick the conversation back up when the envelope arrives. Do not poll for it, and do not stall the user in silence.

Then ask only what the repository genuinely cannot answer: intent, priority, appetite, taste, what must not change, what "good" looks like to them.

## Lead with a recommendation, not a blank

A question with a proposal attached is answerable in one word. A blank question hands your thinking back to the user.

Ground the proposal in something specific — a file, a function, an existing pattern, a memory article — and say why you would pick it:

> `src/adapters/providers/kimi-cli.ts:114` maps read-only to kimi's default `manual` mode because kimi has no launch flag to enforce it — every other vendor's adapter has one. I would follow that file's shape and report the gap rather than pretend containment. Does that match what you want, or should a kimi reader simply be refused?

That gives the user something to correct. "How should kimi handle read-only?" gives them a homework assignment.

## What is worth asking about

Ask only about what would change the delegation, and only where it is genuinely open:

- **Done** — the observable check that ends the task. If you cannot state it, you cannot write a brief.
- **The boundary** — what must not change. This is the question users most often have a strong answer to and volunteer last.
- **The seams** — whether the work splits into pieces that can proceed independently. This is what decides how many agents there are; guessing it wrong is what makes agents collide.
- **Constraints** — compatibility, migration, deadlines, anything that rules out the obvious approach.
- **Verification** — which tests or commands will prove it, and whether they exist yet.

## When to stop

The exit test is concrete: for every task you would spawn, you can name its scope, its done-criterion, its category, and its order relative to the others. Write those briefs in your head; if one comes out vague, you have found your next question.

Once you can write them all, stop asking. Questions past that point are not diligence — they are cost, and they read to the user as an unwillingness to start.

## Close the loop, then delegate

Before the first spawn, state the plan back compactly: the tasks, their boundaries, their order, and what you are deliberately *not* doing. Get an explicit yes. This is the last cheap moment to be wrong.

Then delegate — and carry the user's own words into the task text. The specific constraint they gave you is the part an agent cannot re-derive, and paraphrasing it into something generic is how a fan-out drifts back toward the misunderstanding this conversation just removed.

If the conversation produced a durable decision — a rule, a constraint, a rejected approach and why — record it in memory so the next queen does not ask again.

## What breaks this

- Batching questions, or offering a menu, because it feels faster.
- Interrogating the user about things the code states plainly.
- Spawning "just to get started" while questions are still open. Nothing is cheaper about starting early with the wrong scope.
- Continuing to grill after the exit test is met.
- Accepting a vague answer politely. If "make it better" is all you have, say what you think it means and ask them to correct you.
