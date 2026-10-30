# VaultOS round 2: Next on Today, one meaning per gold mark, labelled toolbars

Date: 2026-10-30. Source: the re-run critique of 2026-10-30 (26/40, up from 24/40). The owner chose its three highest-value targets and answered the open questions below.

## Intent

VaultOS has one heavy daily user, and focus is hard-won. Today should answer "what do I do now?" in the first screenful, on a phone as much as on a desktop. The gold ring should mean one thing. The two toolbars made of icon-only buttons should be readable without tooltips. The tone carries over from round 1: precise, not louder. Add no decoration, no new colours and no new shadows.

Success means:
- On a phone, the first screen of Today shows one next item and a Start button.
- A gold ring always means keyboard focus.
- The task drawer and the Files bar each show at most two labelled actions plus a "More" menu.

## Part 1: Next on Today (architectural)

### Decisions (the owner's)
- **Source:** the first unticked item in Today's tasks. If none, the In Progress task from the Board of the workspace in the header chip. If none, "You're clear for today".
- **Phone layout:** the date shrinks to one line inside Next's header, and the quote moves to the bottom.
- **The Board fallback** uses the current workspace (the header chip). The chip is therefore no longer dimmed on Today. It stays dimmed on Files.

### The picker: `public/today-next.js` (new)
- **How it's built:** a pure module in the same UMD shape as `public/agent-form.js`. It attaches to `window.TodayNext` in the browser and exports through `module.exports` under node.
- **Signature:** `pickNext({ todayTasks, boardTasks, agentState, ws, wsLabel }) → Next`.
  - `todayTasks` is the day's tasks as `today.js` holds them: `{ text, done, moved }`.
  - `boardTasks` is the `/api/tasks?ws=` array, or `null` if it never loaded or failed.
  - `agentState(path)` returns the task's agent state (`'blocked'` means "needs you") or `undefined`.
- **Returns one of:**
  - `{ kind: 'today', text, target: 'task:' + text }`, the first today task where `!done && !moved`.
  - `{ kind: 'board', title, path, ws, wsLabel, needsYou, target: 'task: ' + title }`, the board fallback. It considers only `status === 'in-progress'`. A task whose agent state is `'blocked'` comes first, then the most recent `mtime`. With no candidates it falls through.
  - `{ kind: 'clear' }`.
- **No other inputs.** It has no clock, no DOM and no fetch.

### The Next strip (in `public/today.js`, Today's markup)
- **Placement:** it replaces the `td-date` card as the first block, full width on desktop and phone.
- **Header row:** the existing ‹ › day arrows around a one-line date, `Fri 30 Oct · week 44`. The arrows keep their current behaviour, and so does the "day N of 365" detail, now shown as the date's `title`.
- **Body by kind:**
  - **today:** the task text, with the label `Today's tasks`.
  - **board:** the title, with the label `Board · <wsLabel>`, plus `needs you` in the existing agent-pill style when `needsYou` is set.
  - **clear:** "You're clear for today", with the day's summary in the same form as the header (`3/4 habits · 50m focus`).
- **Actions:**
  - **Start** is the screen's one solid-gold primary. The Focus card's own Start becomes secondary while Next shows an item; when Next is `clear`, Focus's Start returns to primary. Start sets the Focus target to `next.target` and starts the timer through the existing `POST /api/today/timer { action: 'start', target }`. For a `board` item, the target is added to the Focus "Working on" select as a one-off option under a `Board` group, so the select shows it.
  - **Open:** for a `board` item it opens that task's drawer in Board mode, through the existing task-open path in `app.js`. For a `today` item it scrolls Today's tasks into view and focuses that row.
- **Viewing another day:** if the user is looking at a day other than today, Next shows that day's first open task and no Board fallback. The Board is "now", not history.
- **Timer running:** Start reads `Running · 12:34` and is disabled. Open stays available.

### Data flow
- Today already loads its day (`/api/today`). Next recomputes on every Today repaint: a tick, an add, a timer change or a day change.
- **Board fallback fetch:** `GET /api/tasks?ws=<STATE.workspace>` runs once when Today mode opens, again on a workspace switch, and on Today's own refresh. There is no polling. While it is in flight or after it fails, `boardTasks` is `null`, so Next goes straight to `clear`. Next never shows an error.
- **Agent states:** read from the agent-marks state `app.js` already keeps for board cards (`agentPill`'s source). If that state isn't loaded, `agentState` returns `undefined` and the most recent `mtime` decides.

### Layout
- **Desktop:** row 1 is Next. Row 2 is Habits on the left, with Focus and Today's tasks stacked on the right (as now). The quote card is last, full width.
- **Phone (≤700px):** Next, then Habits, then Focus, then Today's tasks, then the quote. Next's header fits one line at 390px.
- **Fonts and colours:** everything uses the `--t-*` scale and existing tokens. Start is the existing primary button. Labels use `--muted`.

### Testing
- **`test/today-next.test.js`** (node:test, pure) covers:
  - today first
  - skipping done or moved tasks
  - the board fallback only when there is no open today task
  - only in-progress tasks considered
  - needs-you before a newer `mtime`
  - `boardTasks: null` giving `clear`
  - `clear` when nothing remains
  - the target strings
- **A puppeteer check on the preview, desktop and 390px phone:**
  - Next is visible in the first viewport on the phone.
  - Start sends `POST /api/today/timer` with the expected target.
  - Ticking the shown task advances Next.
  - An empty Today list with an in-progress board task shows `Board · Personal`.
  - Switching the chip workspace changes it.
  - A failed `/api/tasks` (aborted) shows `clear`.
- **The preview runs with the live feature flags** (`TERMINAL=1`). Round 1 missed a header bug by previewing with the Terminal button hidden.

## Part 2: one meaning per gold mark (bounded)

Today the gold ring means three things: keyboard focus, "selected" (the shared selected rule's 1px inset ring) and "today" (the `.td-cell.sel` outline in the habit grid). After this change each mark has one job:

| Mark | Meaning | Rule |
|---|---|---|
| Gold ring (outline) | Keyboard focus only | The existing `:focus-visible { outline: 2px solid var(--accent) }`. Unchanged. |
| Gold tint (fill) | Selected | The shared selected rule becomes `background: color-mix(in srgb, var(--accent) 16%, var(--panel-2)); color: var(--text); box-shadow: none`. That gives a real fill step from the `--panel-2` track (fixing `.viewseg`) and no ring. |
| Solid gold | Brand and the primary action | Unchanged (the round-1 allowlist). |
| Gold label | Today / the current day | The habit grid's day header for the selected date stays gold and bold. `.td-cell.sel` loses its outline and gets a `--brand` 2px bottom border (an underline, not a ring) when unticked. A ticked cell keeps its soft done fill and also gets the underline. |

- **Contrast:** text on the tinted selected fill must be ≥ 4.5:1 in both themes. The tint itself is ≥ 1.2:1 against its track, checked by the token test. If 16% doesn't reach it, use the smallest percentage that does, the same in both themes where possible.
- **Tests:** `test/look-tokens.test.js` updates the "selected states share one treatment" assertion to the new rule, adds the tint-vs-track check, and asserts no selected rule carries a `box-shadow` ring.

## Part 3: labelled toolbars (bounded)

### Task drawer header
- **Today:** a 3-way view switch (side/centre/full), Show in Files, Start agent, Refresh and Close, all icon-only.
- **After:**
  - **Agent** is a labelled button (icon plus "Agent"), keeping its status dot.
  - A **More** button (`⋯`, `aria-haspopup="menu"`) holds: View as side panel / centred / full screen (a radio group), Show in Files, and Refresh task.
  - **Close** stays an icon at the far right.
- **The menu** reuses the existing `.fx-menu` / `.tw-menu` styling and the keyboard behaviour of the workspace menu: arrow keys, Enter, Escape, and focus returning to the button.
- **Phone:** unchanged, apart from Agent's label (the view switch is already hidden).

### Files bar
- **Today:** crumbs, "edited …", the Rendered/Source (or Grid/Source) switch, the sheet/text-edit buttons, then six tools: locate, Copy file, copy path, download, terminal, refresh.
- **After:** crumbs, "edited …", the view switch, Edit (labelled, from `TextEdit`) and any sheet buttons, then a **More** menu holding: Show in the tree, Copy file, Copy vault path, Download, Terminal here (only when the terminal is on) and Refresh file. Every item is labelled.
- **Phone:** the bar is one row. The crumbs truncate from the left, and Edit and More stay visible.
- The existing ids (`fx-locate`, `fx-copy` …) move onto the menu items, so the delegated click handler at `workbench.js` ~661 keeps working.

## Global constraints (carried from round 1)
- Fonts use only the `--t-*` tokens, with a 12px floor. Text is ≥ 4.5:1 in dark and sepia. Solid gold stays limited to the allowlist in `test/look-tokens.test.js`.
- Use "workspace" in UI copy.
- **Work happens in the worktree** `/opt/vault/board-r2` (branch `round-2`). Each part is released separately: the owner runs the merge, and `server.js` is not expected to change.
- **The preview runs the live feature flags** (`TERMINAL=1`). Header and toolbar fit checks include the Terminal button.
- **Before any push,** run the private-words check on the added lines.

## Out of scope
- Global keyboard shortcuts.
- The empty-KB explanation.
- The Settings dot.
- Date formats.
- Native checkbox styling.
- The `--needs-decision` 4.0:1 note.

These are logged as follow-ups from the re-run critique.
