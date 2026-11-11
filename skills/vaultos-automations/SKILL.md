---
name: vaultos-automations
description: Use when the person asks what automations could help them, wants to set up, change or check a VaultOS automation (a scheduled agent that writes a note into cards), asks how their automations are doing, or asks you to look at the vault and suggest what to automate. Works through the vaultos-automations command in a VaultOS terminal.
---

# VaultOS automations

An automation runs one agent per card on a schedule. Each run picks cards by board and status, gives every card its own headless agent with your prompt, and writes the agent's note into one section of the card. The person sees each automation, and every run's results, in the Automations tab.

You work through the `vaultos-automations` command. It only works in a VaultOS terminal. Details of every field and command are in [reference.md](reference.md).

## What you can and can't do

- You can read everything: `options`, `list`, `show`, `match`, `runs`, `run`.
- You can create and edit automations. Anything you create is saved **off**. Editing the agent, level, prompt or cards of one that's on switches it off. Name, schedule, time limit and note heading edits keep it as it was.
- You can `try` one: a trial on up to 3 cards, read-only, with notes kept in the run history and nothing written into the cards. At most 6 trials an hour.
- You can switch one `off`, and `delete` one that's off.
- You can't switch one on, start a real run or stop a run. The person does that in the Automations tab. Don't look for a way round it, and never edit `.vaultos/automations.json`.

## When the person asks "what could help me?"

1. **Look first and change nothing.** Run `vaultos-automations options` and `vaultos-automations list`. Then read the vault as you normally would: the boards, what's In Progress or Blocked, cards nobody has touched for weeks, Progress logs, and recent results (`runs`).
2. **Propose three at most.** For each one, say in a few plain lines:
   - what the agent does on each card;
   - which cards, with a live count from `match`;
   - when it runs;
   - the level and why;
   - roughly how long a run takes (15 to 60 seconds a card);
   - what the person will see on the card.

   Keep it short. A long menu is harder to act on.
3. **Say the limits.**
   - One agent per card, and every run is per card. A run can't summarise a whole board in one note.
   - No connectors and no web in a run.
   - At most 20 cards a run.
   - Cards are chosen by board, status and subtasks only. "Untouched for 30 days" has to live in the prompt, for example "if the card was updated this week, keep the note to one line".
   - Only the agents `options` lists at a level can run there. Work (editing files in the card folder) is the most limited.
4. **Build what the person picks.** Ask before you create anything, and create three drafts at most in one go.
   - Write the automation to a JSON file and `create` it.
   - Run `try` on it and show the person the trial notes.
   - If the notes are thin or off target, reword the prompt with `edit` and try again.
   - Finish by telling the person the draft is in the Automations tab, where they switch it on.
5. **Never put private details in a prompt.** That means passwords, keys, account numbers and other people's personal data. Prompts sit in a file in the vault.

## When the person asks "how are my automations doing?"

Run `list`, then `runs` and a few `run` details. Tell the person plainly:

- how many cards got a note, were skipped or failed, and why;
- whether the notes said anything useful;
- whether a card has shown "nothing has moved" three runs in a row.

Suggest one change if it would help: a tighter prompt, different statuses, a better time. If an automation isn't earning its keep, say so and offer to switch it `off`.

## Ideas to tailor

Use these as starting points. Fit them to what you found in the vault rather than listing them.

- **Weekday check-in** (Report) over In Progress and Blocked: where it stands, the next step and what's waiting on the person.
- **Blocked chaser** (Update) over Blocked: if the blocker looks cleared, propose moving the card back to In Progress.
- **Backlog sweep**, weekly (Report) over Backlog: is this still wanted, and what's the smallest next step?
- **Folder summary** (Work, Claude Code only) over In Progress: gather what's in the card folder into a short summary file.

## Writing a good prompt

- Speak as the person ("tell me where this stands"), the way the check-in template does (`options` shows it).
- Ask for a short, fixed shape, for example three bullet points.
- Tell the agent what to do when nothing has changed since the last note.
- At Update, say when to propose a move and when to leave the card alone.
