#!/usr/bin/env bash
# Stop hook: if the agent worked an active task (status in-progress/review) but
# left its task.md stale (updated: not today), block once (exit 2) and tell it
# to update the progress log + board. Self-resolves as soon as the date is
# refreshed, and honours stop_hook_active so it can never trap a session.
# Pure shell (no python); fails open on any problem.

input="$(cat)"
proj="${CLAUDE_PROJECT_DIR:-}"

# Loop guard: if we already blocked once this stop cycle, allow the stop.
printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0

cwd="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -z "$cwd" ] && cwd="$(pwd)"

dir="$cwd"; found=""
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -f "$dir/task.md" ]; then found="$dir/task.md"; break; fi
  [ -n "$proj" ] && [ "$dir" = "$proj" ] && break
  dir="$(dirname "$dir")"
done
[ -z "$found" ] && exit 0

status="$(grep -m1 '^status:' "$found" 2>/dev/null | sed 's/^status:[[:space:]]*//; s/[[:space:]]*$//' | tr -d '"')"
updated="$(grep -m1 '^updated:' "$found" 2>/dev/null | sed 's/^updated:[[:space:]]*//; s/[[:space:]]*$//' | tr -d '"')"
today="$(date +%F)"

case "$status" in
  in-progress|review) ;;
  *) exit 0 ;;
esac

if [ "$updated" != "$today" ]; then
  # exit 2 => blocking; stderr is fed back to the agent.
  echo "You worked in $(dirname "$found") but its task.md still shows updated: ${updated:-none} (today is ${today}). Before stopping: append a dated entry to the Progress log, set updated: ${today}, and make sure the matching card on the board reflects reality (it regenerates from this file's status: field)." 1>&2
  exit 2
fi
exit 0
