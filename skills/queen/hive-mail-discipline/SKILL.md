---
name: hive-mail-discipline
description: Follow Hive's mail protocol — when to poll, how lanes differ, and what publishing does and does not prove. Use whenever you read or send mail.
---

# Mail Discipline

Nothing interrupts you with mail. A mailbox is read only at a safe point its owner chose — after finishing a unit of work, before reporting, on resume — never on a timer and never in a tight poll loop. The same discipline applies to your own inbox as orchestrator.

## Poll, claim, settle

hive_mail_poll returns at most one control message in full, plus a bounded digest of work-lane updates and backlog counts. Polling changes nothing and takes nothing. To act on the one control message, hive_mail_claim leases it so nothing else works it concurrently — the lease is time-bounded, and an unsettled claim returns to the queue for another attempt. Finish with hive_mail_complete: `completed` when handled, `deferred` with a retry delay when you cannot handle it yet, `rejected` when you never will. An unsettled claim blocks the message behind it, so settle before you move on.

## Owner and user control mail is a ruling

A control message from `user` or `owner` is a decision, not a note. Before `hive_mail_complete` with `completed`, `memory_write` that ruling into repo memory and put the message's `itemId` in `evidence` (the body may cite it too). The complete tool refuses otherwise. `deferred` and `rejected` do not need an article — you did not accept the ruling. Mail from another agent is not a user ruling.

## Two lanes, two disciplines

The control lane carries instructions and escalations: each one is handled and settled individually, one at a time, never merged with another. That is for a design fork, a scope change, a rebase conflict that needs an integrator, an irreversible destroy/salvage, an explicit hold, or an owner ruling. It is not a standup.

The work lane carries progress: repeated updates from the same sender on the same topic collapse into the newest one, so a digest entry can represent several superseded updates — read it as the current state, not a log of every update sent. Completions, measurements, and "ready" reports belong here. Do not reply to work-lane status. Update the board from the digest when you have room.

## Publishing proves acceptance, not reading

hive_mail_publish returns once a message is durably committed — that is a receipt, never proof the recipient read it. An idempotencyKey reused for the same content returns the original receipt; reused for different content, it is refused rather than silently dropped, so a retry is always safe to resend verbatim. When you need to know whether a mailbox has actually been drained, hive_mail_status reports queue depth by lane, the age of the oldest waiting message, any live lease, and dead letters with reasons — it delivers nothing itself.

## Directing agents

You are the lead, not a ticket desk. Do not issue GO, verify windows, or landing sequences — writers land their own finished work; hive_land already serializes the merge. Use hive_mail_publish on the control lane only when the next act is a ruling the agent cannot make: which design, whether scope grew, who integrates a collision, whether to destroy residue. Do not write into a terminal or otherwise try to interrupt — an agent that never reaches a safe point (stuck, crashed, or grinding) needs hive_terminal_observe or hive_status, not a louder message.
