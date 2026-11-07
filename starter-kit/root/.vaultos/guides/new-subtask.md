# New subtask

Split a job into subtasks that can be worked at the same time, each in its own terminal. Each subtask gets its own folder and card. It does not get a Knowledge Base article: the parent writes one article covering all of them at the end.

Use this when a job holds independent units: one per server, environment, client or migration wave. Steps that must happen one after another stay as Plan items in the parent.

## 1. Read the parent

- Find the parent job folder from the request, or use the task being worked. Read its `task.md` end to end, and anything in its `data/`. Subtasks come out of the parent's Plan; do not invent new work.
- Work out the batch key: the parent's `id:`, or, if that is empty, its folder name without the number prefix (`04-site-migration` gives `site-migration`). State it in one line.

## 2. Propose the split first

List the subtasks you intend to create, one line each, with the unit each one covers. Show the list to the user and wait for a go-ahead before creating any files. A bad split is hard to undo once the cards are on the board.

A good split:

- has one subtask per unit that can be worked in its own terminal while the others run
- keeps work on one shared outside system (one admin console, one DNS zone, one account) in a single subtask, so two sessions never change it at once
- has no card for a unit with no open work left

## 3. Create each subtask

- Nest the subtasks inside the parent's folder, numbered: `<parent>/01-<unit>/task.md`, `<parent>/02-<unit>/task.md`.
- Copy `<Board>/_tasks/_Templates/task.md` from the parent's board into each.
- Fill in the frontmatter:
  - `id`: the subtask's slug. `aliases`: the same value in a list, `["<id>"]`.
  - `title`: `<parent shorthand> — <unit>`, readable on a card with no context.
  - `area`: the same as the parent.
  - `batch`: the parent's batch key. This groups the cards, and searching for it finds them all.
  - `host`: the machine or unit the subtask runs on, if there is one.
  - `status`: the subtask's own status, not a copy of the parent's. One waiting on a decision is `needs-decision`.
  - `priority`, `owner`, and `created`/`updated` (today).

## 4. Fill in the subtask callout

The template opens with a callout marked SUBTASK. In each subtask, keep it, delete only the `<!-- SUBTASK ONLY ... -->` comment line above it, and fill in the parent's title and the batch key.

An agent that opens the file cold, in its own terminal, must learn three things from the top of the file: this is a subtask, it gets no article, and its report goes to the parent's `data/`.

## 5. Write a real Goal and Plan for each

- Goal: one or two sentences on what "done" means for this unit alone.
- Plan: the parent's open Plan items that this unit owns. A plan that says "see parent" is a dead card.
- Context: the unit's own facts (machine names, paths, settings, values), so a fresh session can start from this file alone.
- Note in Context that findings go back to the parent, written by one session at a time.

## 6. Point the parent at the subtasks

In the parent's `task.md`:

- Under Context, add a line naming the batch key and how many subtasks it has.
- Replace each Plan item that moved with one line saying which subtask owns it now.
- Keep the shared facts, findings and decisions in the parent.
- Set the parent's `status:` to `in-progress` if any subtask is being worked.
- Add a dated line to its Progress log.

## 7. Closing

A subtask closes without an article: set its `status: done` and `updated:`, put its report in the parent's `data/`, and add a line to the parent's Progress log. Its folder stays inside the parent.

When every subtask is done, finish the parent with `.vaultos/guides/done.md`. That writes one article for the whole batch.

## 8. Confirm

Tell the user:

- the batch key and how many subtasks it has
- one line per subtask: title, unit, status
- what moved out of the parent, and what stayed
- that the cards are on the board, and searching the batch key finds them all
