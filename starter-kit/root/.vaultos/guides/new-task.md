# New task

Turn new work into a job folder with a `task.md`, so it shows as a card on a board. Work through the steps in order.

## 1. Pick the board and project

- Pick the board from the boards list in `AGENTS.md`. If none fits, or more than one could, ask before creating anything.
- Inside that board, pick the project folder (`<N. project>/`) the work belongs to. If none fits, propose a new one with the next free number, e.g. `3. website`.
- State your choice in one line, e.g. "Contact form → `<Board>/2. website/`", so the user can correct it before you create anything.

## 2. Check it is not already tracked

- Search the board's folder for a job that already covers this work: the ticket number if there is one, and the obvious keywords in folder names and `task.md` titles.
- If one exists, say so, update that `task.md` instead (Plan, Progress log, `status:`), create any of the standard folders from step 3 it is missing, and stop.
- Also look for loose notes on the subject outside any job folder. A note outside a job folder never shows on the board. Any you find move into the new folder in step 4.

## 3. Create the folder and task.md

- Create `<Board>/<N. project>/<NN-job>/`. `NN` is the next free two-digit number in that project; `job` is a short kebab-case name, or the ticket number.
- Inside it, create the job's standard folders, empty, so there is always a place to put things:
  - `correspondence/drafts/`: emails, messages and posts you write for the user to send. Save them as `.txt` files, not just in chat.
  - `correspondence/received/` and `correspondence/sent/`: what came in, and what the user actually sent.
  - `data/`: raw material, such as exports, logs and reports.
  - `diagrams/`: diagrams for the job and its article.
  - `screenshots/`: screenshots.
- Copy `<Board>/_tasks/_Templates/task.md` into it as `task.md`.
- Fill in the frontmatter:
  - `id`: the ticket number, or the folder name without its number (`contact-form`).
  - `aliases`: the same value as `id`, in a list: `aliases: ["contact-form"]`. Without it, `[[contact-form]]` links to the card do not resolve, because the file is called `task.md`.
  - `title`: how the card should read with no context around it, e.g. `Website — contact form`.
  - `area`: a short tag for the card, usually the project name without its number (`website`).
  - `status`: `backlog`. Use `in-progress` if the work starts now, or `scheduled` with `scheduled_for:` set if there is a target date.
  - `priority`: `low`, `med` or `high`.
  - `owner`: leave it empty unless the user names someone.
  - `created` and `updated`: today.
  - Leave `batch:` empty; it is only for subtasks.
- Delete the SUBTASK callout and the comment line above it. This is a job, not a subtask.
- Write a real Goal: one or two sentences on what "done" looks like. Never leave the placeholder.
- Fill the Plan with the next actions you can work out, as `- [ ]` items. An empty plan is a dead card. Put anything unknown in the Plan as a question to answer.
- Replace the Progress log's placeholder line with `- YYYY-MM-DD — created.`, using today's date.

## 4. Bring in what exists

Move any loose notes, files or scripts on this subject into the new folder (move them, so only one copy exists) and list them under Context.

## 5. Confirm

Tell the user:

- where the job lives, and why there
- what the Goal says
- anything you moved in
- that the card is on the board. Creating `task.md` is all it takes: VaultOS reads `status:` and regenerates `_tasks/Board.md`. Never edit `Board.md` by hand.
