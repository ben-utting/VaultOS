# vaultos-automations reference

The command runs in a VaultOS terminal and talks to VaultOS with that terminal's own token. Outside one it prints `Run this in a VaultOS terminal.` Add `--json` to any command for the raw answer. `--file -` reads JSON from stdin.

Exit codes: `0` done, `1` VaultOS refused (the reason and any field errors follow), `2` usage, not in a VaultOS terminal, or the terminal's session has ended, `3` VaultOS isn't answering.

## Commands

| Command | What it does |
| --- | --- |
| `vaultos-automations options` | What this install offers: boards, statuses, levels, agents and the levels each can run, the default agent, templates with their prompts, schedule examples, limits, time zone |
| `vaultos-automations list` | Every automation: id, on or off, schedule, level, last run, and a tag on drafts you or another agent made |
| `vaultos-automations show <id>` | One automation as JSON, ready to copy fields from |
| `vaultos-automations match <id>` | The cards an automation would pick up right now |
| `vaultos-automations match --file draft.json` | The same for a draft you haven't created (only `cards` is read) |
| `vaultos-automations runs [--automation <id>] [--limit N]` | Recent runs, newest first, with their trigger (scheduled, catch-up, run now, trial) |
| `vaultos-automations run <runId>` | One run: each card's state, reason, note, status change and files changed |
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
| `template` | `check-in` or `blank`. A label of where the prompt started; the prompt is what counts |
| `prompt` | What the agent does on each card, up to 8,000 characters. VaultOS adds the card, its task.md and the rules for the level |
| `level` | `report`: reads and writes a note. `update`: can also propose a status change (never to Done). `work`: can edit files in the card's folder |
| `cards.board` | A board key from `options`, or `all` |
| `cards.statuses` | One or more of `backlog`, `in-progress`, `blocked`, `needs-decision`, `review`, `scheduled` (never `done`) |
| `cards.subtasks` | `true` to include subtask cards |
| `schedule` | See below. Times are in the board's time zone |
| `section` | The heading the note goes under in each card: 1 to 40 letters, digits, spaces or hyphens, not one of the card's own sections |
| `timeLimitMin` | 2 to 30 minutes per card |

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

`changes.json` holds only the fields you want to change. `cards` and `schedule` merge into what's there, so `{"schedule": {"time": "09:00"}}` keeps the repeat and `{"cards": {"statuses": ["blocked"]}}` keeps the board.

- Changing `name`, `schedule`, `timeLimitMin`, `section` or `template` keeps the automation on or off as it was.
- Changing `agent`, `level`, `prompt` or `cards` switches it off. The Automations tab then says what you changed, and the person switches it back on.
- `"enabled": true` is ignored. `"enabled": false` switches it off.

## Trials

`try` runs the automation on its first 3 matching cards with the agent held to reading. The notes go into the run history only; nothing is written into the cards and no card moves. At Update, the run shows the move it would have made ("Would move"). A Work automation is tried as Report, so the trial shows what it would say, not what it would change. At most 6 trials an hour; one at a time, queued behind any run in progress.

## Limits

- 20 cards a run (3 for a trial).
- 10 drafts from agents that are still off. Delete some, or ask the person to switch them on, before making more.
- 6 trials an hour.
- Drafts never run on their schedule until the person switches them on.
