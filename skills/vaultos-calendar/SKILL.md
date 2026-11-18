---
name: vaultos-calendar
description: Use when the person asks to be reminded of something, to put something in their calendar or move or cancel it, asks what's on today or this week or when they're free, asks for help planning their week, or says they're overwhelmed by everything they have on. Works through the vaultos-calendar command in a VaultOS terminal.
---

# VaultOS calendar

The person keeps a calendar inside VaultOS. Each entry has a title, a date, a start time or "all day", an optional repeat and a ping. When a ping comes due, VaultOS shows a toast and plays a chime on any open VaultOS page. Pings that came due while VaultOS was closed wait in the Due list under the bell.

You work through the `vaultos-calendar` command. It only works in a VaultOS terminal. Every command, flag and field is in [reference.md](reference.md).

## Rules

**Run `vaultos-calendar today` first, every time.** It prints the real date, time and time zone, today's entries and what's due. Work out "Friday" or "next week" from that answer, not from memory.

**Confirm in one line.** After you add or change something, give the person the full date, the time and the ping, as the command printed them: "Added: Fri 20 Nov 2026 09:00 · Chase X · pings at start".

**Link the card.** If the reminder is about a card on a board, pass `--card` with the card's folder or its `task.md` path. The person can then open the card from the reminder.

**Add five at most without asking.** Up to five entries in one go is fine. For more, such as a whole week's plan, list what you'd add and wait for the person to choose. A calendar that fills itself makes overwhelm worse.

**Ask before you delete a repeating series.** `delete` removes every date of a repeat. To move one date, `skip` it and `add` a one-off on the new date. An `edit` changes the whole series.

**The ping goes to the person, not to you.** You won't see it. If you want something done later, that's a job for VaultOS Automations, not the calendar.

**Leave `.vaultos/calendar.json` alone.** Change the calendar only through the command. If the command says the calendar is switched off, tell the person to switch it on in VaultOS Settings → Features, and stop there.

**Close what the person has dealt with.** If they say they've done something on the Due list, run `vaultos-calendar done <id>`. They can also click Done in VaultOS.

## Planning a week, or "I'm overwhelmed"

1. Run `vaultos-calendar today`, then `vaultos-calendar list` for the next two weeks.
2. Read the Board's In Progress and Blocked cards.
3. Suggest three to five time blocks or reminders, each with a day, a time and one line on why. When the person says they're overwhelmed, suggest fewer.
4. Add only what they agree to, then confirm each one in a line.

## Examples

**A one-off reminder.** "Remind me Friday at 9 to chase the plumber's invoice." `today` says it's Wed 18 Nov 2026.

```
vaultos-calendar today
vaultos-calendar add --title "Chase the plumber's invoice" --date 2026-11-20 --time 09:00
```

You reply: "Added: Fri 20 Nov 2026 09:00 · Chase the plumber's invoice · pings at start."

**Every weekday at 8.** "Every weekday at 8, remind me to pick my top 3."

```
vaultos-calendar today
vaultos-calendar add --title "Pick my top 3" --date tomorrow --time 08:00 --repeat weekdays
```

**Moving one date of a repeat.** "Move Thursday's physio to Friday this week." Physio repeats every Thursday at 17:30.

```
vaultos-calendar today
vaultos-calendar list --search physio
vaultos-calendar skip c_7k2m9p4x1q --date 2026-11-19
vaultos-calendar add --title "Physio" --date 2026-11-20 --time 17:30
```

The series carries on from the next Thursday. You reply with both lines the command printed.
