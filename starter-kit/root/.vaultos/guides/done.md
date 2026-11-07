# Done

Finish a job: write its Knowledge Base article and mark the task done.

## 1. Find the job

Find the job folder from the request, or use the task being worked, and state its path in one line. If it is unclear which job, ask.

## 2. Check whether it is a subtask

If the task's frontmatter has a non-empty `batch:`, it is a subtask and gets no article. Close it like this, then stop:

1. Set `status: done` and `updated:` to today in its `task.md`.
2. Put its report or output in the parent folder's `data/`.
3. Add a dated line to the parent's Progress log, and copy any lasting finding into the parent's findings.
4. Leave the folder where it is.

Tell the user which subtask closed and how many in the batch are still open. The parent gets one article covering every subtask, once they are all done.

Everything below is for a job with no `batch:`.

## 3. Read the whole folder

- If the job has subtasks, check that every one is `done`. If any is still open, say which and stop.
- Read `task.md` in full, and every other file in the folder: notes, data, subtask reports, scripts, screenshots. The article comes from the whole record. Note the outcome, the decisions that mattered, and anything a later reader would otherwise have to work out again.

## 4. Write the article

The bar: someone who has never seen this job understands what it was, how it ended and what was learned within five minutes of opening the article.

- Copy `<Board>/_tasks/_Templates/article.md` into the job folder as `article.md`.
- Fill in the frontmatter:
  - `title`: a clear title for a person, usually the task title without board shorthand.
  - `area`: the same as the task.
  - `stack`: the technologies and products involved, as a list, e.g. `[Postgres, Nginx]`. They show as chips. Be specific.
  - `tickets`: ticket or reference numbers, if any.
  - `search`: 3 to 6 entries someone would type to find this later: at least two natural questions ("why does OU delegation skip Domain Admins") plus exact error strings, commands or identifiers worth pasting. Search ranks these as highly as the title.
  - `job`: the path from the vault root to this job's `task.md`.
  - `status: published`. Use `draft` only if you are knowingly leaving it unfinished.
  - `created` and `updated`: today.
- Write the body to the template's sections, leading with the outcome:
  - **TL;DR**: what it was and how it ended, in two or three sentences.
  - **Stack** and **Glossary**: the technologies, then one-line reminders of the terms, acronyms, ports and protocols the article actually uses.
  - **Diagrams** and **Screenshots**: place each one where it explains something.
  - **Situation & goal**, **What I did**, **Key decisions**, **Gotchas & lessons**, **References & related**.
  - Drop a section that does not apply rather than padding it.
  - Link related articles as `[[<Board>/<N. project>/<NN-job>/article|Label]]`.
- Write plainly: short sentences, active voice, no filler.

## 5. Mark the task done

In the job's `task.md`, set `status: done` and `updated:` to today, and add a final Progress log line. The card moves to Done and links to the article. Never edit `_tasks/Board.md` by hand.

## 6. Confirm

Tell the user:

- where the article is
- its TL;DR and the stack
- any articles you linked
- that the task is marked done
