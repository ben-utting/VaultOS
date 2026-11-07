---
type: task
id: ""                  # ticket number or short slug, e.g. contact-form
aliases: []             # repeat the id here, e.g. ["contact-form"]; this is what makes [[card-id]] links resolve
title: ""               # how the card reads, e.g. "Website — contact form"
area: ""                # short tag shown on the card, e.g. website
status: backlog         # backlog | scheduled | in-progress | blocked | needs-decision | review | done
priority: med           # low | med | high
owner: ""
created: ""             # YYYY-MM-DD
updated: ""             # YYYY-MM-DD; change it whenever the task changes
blocked_by: ""          # what or who you are waiting on, if status = blocked
review_note: ""         # what is left to verify, write up or decide, if status = review
scheduled_for: ""       # target start date, if status = scheduled
decision_note: ""       # what needs deciding, and by whom, if status = needs-decision
batch: ""               # parent job's batch key, if this is a subtask; groups the cards and is what you search for
host: ""                # the machine or unit this runs on, if any; shows as a label on the card
---

<!-- SUBTASK ONLY: in a subtask, keep the callout below and delete just this line. In a standalone job, delete both. -->
> [!warning] This is a SUBTASK, not a job. Read before closing.
> **Parent: [[../task|PARENT TITLE]]. Batch key: `parent-batch-key`.**
> **Do NOT write a Knowledge Base article for it.** Close it like this:
> 1. Set `status: done` and `updated:` to today in this file.
> 2. Put the report or output in the **parent folder's** `data/`, not this folder's.
> 3. Add a line to the **parent's** Progress log, and copy any lasting finding into the parent's findings.
> 4. **Leave this folder where it is.** It stays with the parent.
>
> The parent writes one article covering every subtask, once they are all done.

## Goal
_One or two sentences: what "done" looks like. Keep it stable; it is what the agent re-reads._

## Context / key facts
_Names, references, links, and the files in this folder that matter._

## Plan
- [ ] First step
- [ ] Next step

## Progress log
_Newest at the top. Date each entry._

- YYYY-MM-DD — created.

## Findings / decisions
_What was learned or decided, so nobody has to work it out again._
