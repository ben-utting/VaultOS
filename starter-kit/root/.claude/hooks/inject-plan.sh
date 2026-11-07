#!/usr/bin/env bash
# UserPromptSubmit hook: auto-load the nearest task.md (or legacy info.md) as
# context so the agent always re-reads the plan — even after /clear or a new
# session. No-ops unless cwd is inside a task folder. Never blocks.
# Pure shell (no python) so it works in every container.

input="$(cat)"
proj="${CLAUDE_PROJECT_DIR:-}"

cwd="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -z "$cwd" ] && cwd="$(pwd)"

# Walk up from cwd looking for a task file, bounded by the project root.
dir="$cwd"; found=""
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -f "$dir/task.md" ]; then found="$dir/task.md"; break; fi
  if [ -f "$dir/info.md" ] && [ -z "$found" ]; then found="$dir/info.md"; fi
  [ -n "$proj" ] && [ "$dir" = "$proj" ] && break
  dir="$(dirname "$dir")"
done
[ -z "$found" ] && exit 0

echo "## Active task context (auto-loaded from ${found})"
echo
sed -n '1,120p' "$found"
echo
echo "_Board protocol: work the Plan, append a dated entry to the Progress log, and set \`updated:\` to today whenever you change anything. The board regenerates from this file's \`status:\` — no need to hand-edit it._"
exit 0
