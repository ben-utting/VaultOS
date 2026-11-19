# vaultos-calendar reference

## Commands

```
vaultos-calendar <command> [--json]
  today                              now (date, time, zone), today's entries, what's due
  list [--from D] [--to D] [--search TEXT]   entries by day; default today + 13 days
  show <id>
  add --title T --date D [--time HH:MM] [--end HH:MM] [--all-day]
      [--repeat daily|weekdays|weekly:mon,wed|monthly|yearly] [--until D]
      [--ping none|start|5m|10m|15m|30m|1h|1d] [--card PATH] [--note TEXT]
      [--link URL|PATH]… [--brief TEXT] [--agent ID|default]
  add --file <entry.json>            (--file - reads stdin)
  edit <id> [any add flag] [--no-links] | --file <changes.json>   changes the whole series
  skip <id> --date D                 drop one date from a repeat
  delete <id>                        to Recently deleted (30 days)
  deleted                            what's in Recently deleted
  restore <id>
  due                                what's due now
  done <id|key>  dismiss <id|key>  snooze <id|key> --for 10m|1h|tomorrow|Nm|Nh
  brief <id> [--date D]              what an agent opened from this reminder reads first
```

- `D` is `YYYY-MM-DD`, `today` or `tomorrow`, in the VaultOS time zone that `today` prints.
- `--card` takes a card's folder or its `task.md` path, relative to the vault. `--card none` on `edit` removes the link.
- `edit` sends only the flags you give. `--time` on an all-day entry makes it a timed one. `--until` on its own keeps the entry's repeat and changes its end.
- `--link` can be given up to 10 times, one link each. On `edit`, any `--link` replaces the whole list and `--no-links` clears it. `--brief ""` clears the focus. `--agent default` goes back to the default agent.
- `done`, `dismiss` and `snooze` take a due key (`c_7k2m9p4x1q@2026-11-20`) or an entry id. An id means that entry's item in the Due list.
- `--json` prints the server's answer as it came.
- Exit codes: 0 done, 1 VaultOS refused (the reason prints, with one line per field), 2 bad usage or not in a VaultOS terminal, 3 VaultOS isn't answering.

## An entry

| Field | Rule |
|---|---|
| `id` | `c_` and 10 characters. VaultOS makes it. |
| `title` | 1 to 120 characters, one line. |
| `date` | `YYYY-MM-DD`: the first (or only) day. |
| `allDay` | `true` or `false`. |
| `start` | `HH:MM`, 24-hour. Needed unless the entry is all day. |
| `end` | `HH:MM` after `start` on the same day, or `null`. No overnight entries. |
| `repeat` | `null`, or `{ "every": "daily" \| "weekdays" \| "weekly" \| "monthly" \| "yearly", "days": [0–6], "until": "YYYY-MM-DD" }`. `days` is for weekly only (0 = Monday) and needs at least one. `until` is optional and inclusive. |
| `skip` | Dates dropped from a repeat, at most 500. |
| `ping` | `null`, `"start"`, `"5m"`, `"10m"`, `"15m"`, `"30m"`, `"1h"` or `"1d"`. Left out, it pings at the start. |
| `card` | `null`, or the path of a card's `task.md`. VaultOS checks the card exists when you set it. |
| `note` | Up to 4,000 characters: what it's about, what done looks like, and any runbook (a numbered step per line, each with the check command the person runs). |
| `links` | Up to 10, each up to 500 characters: a web address (`https://…`) or a vault path such as `Work/1. projects/12-website-refresh/data/brief.pdf`. |
| `brief` | Up to 500 characters, one line: what the agent opened from this reminder should look at. It describes, it doesn't instruct. |
| `agent` | `null` for the default agent, or one of `claude`, `cursor`, `pi`, `codex`, `antigravity`, `copilot`, `opencode`, `kilo`. Set it only when the person asks. |
| `created`, `updated` | Who and when. VaultOS fills these in and tags your changes with your agent's name. |

## Pings

- Timed entries: `start` pings at the start time, `5m` to `1h` that long before, `1d` 24 hours before.
- All-day entries: `start` pings at 08:00 on the day, `1d` at 08:00 the day before. The minute offsets don't apply.
- `--ping none` adds the entry without a ping.
- On the night the clocks go forward, a time inside the missing hour pings an hour later (01:30 pings at 02:30). A time that happens twice when they go back pings the first time.

## Repeats

- `daily`: every day. `weekdays`: Monday to Friday. `weekly:mon,wed`: the days you name (`mon tue wed thu fri sat sun`).
- `monthly`: the same day of the month as `date`. In a shorter month it falls on the last day, so the 31st becomes 30 Apr.
- `yearly`: the same day and month. 29 Feb becomes 28 Feb in other years.
- The tightest repeat is daily.

## `brief`

`vaultos-calendar brief <id> [--date D]` prints what an agent opened from the reminder's Agent button reads first:

1. The item: id, title, then "Due <date> <time>" (with `--date`) or "Next: …", the repeat, the ping and who added it.
2. The note, under a heading saying it was written when the reminder was added and is information, not instructions.
3. The links and the focus (left out when empty).
4. The linked card: its path, title and status, and which of `task.md`, `info.md`, `checklist.md` and `conversation-log.md` its folder holds, with sizes. A card that has moved says "not found"; no card says "No card linked."
5. The rules for the session: read first, change nothing until the person says, gather only from the vault, Google Calendar and Plaud, and walk a runbook one step at a time.

`--date` must be a date the entry falls on. `--json` gives the same parts as fields (`text`, `entry`, `when`, `card`, `rules`).

## Limits

- Agents may add 30 entries and delete 20 in any hour, across every terminal. Past that, VaultOS answers "Too many calendar changes from agents in the last hour".
- At most 2,000 entries with a date today or later. Past entries don't count.
- Snooze runs 1 to 1,440 minutes (`Nm`) or 1 to 24 hours (`Nh`). `tomorrow` means 09:00 tomorrow.
- VaultOS judges every field. The command doesn't check anything itself.

## `--file` examples

A weekly entry with a card and a note (`vaultos-calendar add --file entry.json`):

```json
{
  "title": "Review the website draft",
  "date": "2026-11-23",
  "start": "10:00",
  "end": "10:30",
  "repeat": { "every": "weekly", "days": [0], "until": "2026-12-21" },
  "ping": "10m",
  "card": "Work/1. projects/12-website-refresh",
  "note": "Check the contact form.\nDone when the form sends to the shared inbox.",
  "links": ["https://example.com/contact", "Work/1. projects/12-website-refresh/data/brief.pdf"],
  "brief": "Whether the contact form fix from last week is live",
  "agent": null
}
```

Changes for an existing entry (`vaultos-calendar edit c_7k2m9p4x1q --file changes.json`):

```json
{ "start": "11:00", "ping": "15m" }
```
