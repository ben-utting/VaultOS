# vaultos-automations reference

The command runs in a VaultOS terminal and talks to VaultOS with that terminal's own token. Outside one it prints `Run this in a VaultOS terminal.` Add `--json` to any command for the raw answer. `--file -` reads JSON from stdin.

Exit codes: `0` done, `1` VaultOS refused (the reason and any field errors follow), `2` usage, not in a VaultOS terminal, or the terminal's session has ended, `3` VaultOS isn't answering.

## Commands

| Command | What it does |
| --- | --- |
| `vaultos-automations options` | What this install offers: boards, statuses, levels, agents and the levels each can run, the default agent, templates with their prompts, schedule examples, limits, time zone |
| `vaultos-automations list` | Every automation: id, on or off, schedule, level, last run, and a tag on drafts you or another agent made |
| `vaultos-automations show <id>` | One automation as JSON, ready to copy fields from |
| `vaultos-automations match <id>` | The cards an automation would pick up right now (a Once automation picks none) |
| `vaultos-automations match --file draft.json` | The same for a draft you haven't created (only `cards` is read) |
| `vaultos-automations runs [--automation <id>] [--limit N]` | Recent runs, newest first, with their trigger (scheduled, catch-up, run now, trial) |
| `vaultos-automations run <runId>` | One run: each card's state, reason, note, status change, files changed, and the new cards it created or didn't |
| `vaultos-automations create --file automation.json` | Creates it, always switched off |
| `vaultos-automations edit <id> --file changes.json` | Changes some fields; see "Edits" below |
| `vaultos-automations off <id>` | Switches it off |
| `vaultos-automations try <id> [--no-wait]` | Runs a trial and waits for it, then prints the notes |
| `vaultos-automations delete <id>` | Deletes it, only when it's off |

## An automation

```json
{
  "name": "Weekday check-in",
  "agent": "default",
  "template": "check-in",
  "prompt": "Look at this card and tell me where it stands. ...",
  "level": "report",
  "cards": { "board": "work", "statuses": ["in-progress", "blocked"], "subtasks": false },
  "schedule": { "repeat": "weekdays", "time": "08:00" },
  "section": "Latest check-in",
  "timeLimitMin": 10
}
```

| Field | Values |
| --- | --- |
| `name` | 1 to 60 characters |
| `agent` | `default` (the person's default agent) or an agent id from `options`. The agent must be offered at the chosen level |
| `model` | Optional, Cursor CLI only. The model the run passes to Cursor as `--model`, for example `gpt-5` or `claude-opus-4-8[context=1m,effort=high,fast=false]`. Leave it out (or `null`) for Cursor's default. One line, 1 to 200 characters. It isn't checked against a list, so a wrong id only shows when the run fails: `cursor-agent --list-models` lists what this install can use. Other agents ignore it, and so does `default` unless the default agent is Cursor |
| `template` | `check-in` or `blank`. A label of where the prompt started; the prompt is what counts |
| `prompt` | What the agent does on each card, up to 8,000 characters. VaultOS adds the card, its task.md and the rules for the level |
| `level` | `report`: reads and writes a note. `update`: can also propose a status change (never to Done). `work`: can edit files in the card's folder and propose new cards (see "New cards") |
| `runsOn` | Optional. Left out (or `cards`): one agent per matching card. `once`: one agent per run, not tied to a card, that looks things up and proposes new cards. `once` needs `level: "work"` and `newCards`, has no `cards`, `section` or `reminders`, and is offered to the agents whose `once` levels in `options` include `work` |
| `newCards` | Optional, Work only: `{ "board": "<key>", "folder": "<path in the board>", "max": 5 }`. Where new cards go and how many a run may make (1 to 10, default 5). `folder` is relative to the board (`""` is its top) and must already exist, inside the board, not in a folder the board skips (`_tasks`, `archive` and so on) and not inside a card's folder. `options` lists the folders per board. Required with `runsOn: "once"`. Add `"choose": true` (folder is then ignored) to let the agent pick a folder for each card: see "New cards" |
| `cards.board` | A board key from `options`, or `all` (not used with `runsOn: "once"`) |
| `cards.statuses` | One or more of `backlog`, `in-progress`, `blocked`, `needs-decision`, `review`, `scheduled` (never `done`) |
| `cards.subtasks` | `true` to include subtask cards |
| `schedule` | See below. Times are in the board's time zone |
| `section` | The heading the note goes under in each card: 1 to 40 letters, digits, spaces or hyphens, not one of the card's own sections |
| `timeLimitMin` | 2 to 30 minutes per card |
| `connectors` | Optional list of connector ids from `options` (the `Connectors (read-only)` line) the automation may look things up in during a run. Lookups are read-only. Leave it out, `null` or `[]` for none. Only some agents can use them, and a changed list switches the automation off |
| `reminders` | Optional, `true` or left out. With `true`, the run's agent may propose one calendar reminder per card (see "Calendar reminders" below). Saving works while Calendar is off, but runs then skip the reminder: the `Calendar reminders` line of `options` says which. Changing it switches the automation off |

Board keys and agent ids differ per install: take them from `options`.

### Schedules

```json
{ "repeat": "daily", "time": "08:00" }
{ "repeat": "weekdays", "time": "08:00" }
{ "repeat": "weekly", "days": ["mon", "fri"], "time": "17:00" }
{ "repeat": "hours", "every": 4, "from": "08:00" }
```

`every` is one of 1, 2, 3, 4, 6, 8 or 12. Days are `mon` to `sun`.

## Edits

`changes.json` holds only the fields you want to change. `cards`, `newCards` and `schedule` merge into what's there, so `{"schedule": {"time": "09:00"}}` keeps the repeat and `{"cards": {"statuses": ["blocked"]}}` keeps the board. `"newCards": null` removes the destination.

- Changing `name`, `schedule`, `timeLimitMin`, `section` or `template` keeps the automation on or off as it was.
- Changing `agent`, `model`, `level`, `prompt`, `cards`, `runsOn`, `newCards`, `connectors` or `reminders` switches it off. The Automations tab then says what you changed, and the person switches it back on.
- `"model": null` removes the model, so Cursor uses its default. That counts as a model change.
- `"enabled": true` is ignored. `"enabled": false` switches it off.

## Calendar reminders

With `"reminders": true`, each card's prompt lists the card's upcoming calendar reminders and explains a `vaultos-remind` block the agent may end with (before its note): `date` (required, YYYY-MM-DD), optional `time` and `end` (HH:MM), `title` (defaults to the card's title), `ping` (`start`, `5m` … `1d`, or `none`), `note` and `brief`. VaultOS checks it and puts the reminder on the calendar, linked to the card and tagged "Automation: <name>". You don't run any command for it: the agent in a run has no shell.

- A time left out takes the first free 15-minute slot from 09:00 (the last starts at 15:45), so several cards on one date stagger 09:00, 09:15, 09:30. A full day is skipped.
- A card that already has a reminder on that date gets no second one, so a re-run adds no duplicates. One the person deleted for that date isn't added again.
- Past dates, and times already gone today, are skipped. So is everything while Calendar is off.
- Automations add at most 30 reminders an hour between them.
- The run shows "Reminder added: Thu 26 Nov 09:15 · …" or "Reminder skipped: why" on each card. A trial adds nothing and shows "Would remind: …" with the slot it would pick.

Write the prompt so the agent knows when a reminder is worth it, for example "if the card needs me tomorrow, add a reminder for tomorrow morning".

## New cards

A Work automation with `newCards` can create cards. The agent never writes them itself: it ends its reply with one `vaultos-card` block per card (before its note), and VaultOS creates `<folder>/<key or title slug>/task.md` from the board's own template (`_tasks/_Templates/task.md`, or a built-in one), status Backlog.

```
title: how it should read on the board        (required, up to 120 characters)
key: the source's own id, e.g. a ticket number (letters, digits, . _ -)
goal: what done looks like                     (required, up to 500)
link: https://… to the source item
priority: low | med | high                     (default med)
plan:
- first next action
context: who raised it, dates, ids             (up to 2,000)
```

- The prompt shows the agent the cards already in the folder and every key on the board, so it can skip them.
- VaultOS skips a card whose key is already the `id` or `source_key` of any card on the board (Done and archived ones too, case doesn't matter), one without a key whose title matches a card in the folder, a second proposal of the same thing in one run, and anything whose folder name is taken.
- At most `max` new cards a run, and 30 an hour across all automations. The rest are listed as not created and come up again next run.
- A **Once** automation (`runsOn: "once"`) has no card: its agent works from the destination folder and its connectors, read-only, and its note goes into the run history with what it created. This is the "go and look, then make me cards" shape, for example turning the tickets in someone's Jira queue into cards.
- On each card, a Work run's follow-up cards come after its note, and the new card's Progress log says which card it came from.
- **Let the agent choose** (`"newCards": { "board": "work", "choose": true, "max": 10 }`): the agent works from the top of the board, its prompt lists the board's folders (and points at the board's `CLAUDE.md`, if any, for which work goes where), and each `vaultos-card` block gets a `folder:` line, a path from the top of the board (leave it out for the top). It may name one new folder level inside an existing folder, such as `10. security` or `3. iam/entra`: letters, digits, spaces, `.`, `_` and `-`, starting and ending with a letter or digit, up to 60 characters, never a folder the board skips or inside a card's folder, at most 3 new folders a run. The run shows "Created: <title> (<key>) in <folder>" and "(new folder)".
- The run shows "Created: <title> (<key>)" and "Not created: <key>" with the reason. A trial creates nothing and shows "Would create: …".

## Trials

`try` runs the automation on its first 3 matching cards with the agent held to reading. The notes go into the run history only; nothing is written into the cards and no card moves. At Update, the run shows the move it would have made ("Would move"). A Work automation is tried as Report, so the trial shows what it would say, not what it would change. At most 6 trials an hour; one at a time, queued behind any run in progress.

## Limits

- 20 cards a run (3 for a trial).
- New cards: up to the automation's `max` (1 to 10) a run, 30 an hour across automations.
- 10 drafts from agents that are still off. Delete some, or ask the person to switch them on, before making more.
- 6 trials an hour.
- Drafts never run on their schedule until the person switches them on.
