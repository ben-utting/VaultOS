# VaultOS Look-and-Feel Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five priority issues and four bugs from the 2026-10-30 design critique, one task at a time, each one released and checked before the next starts.

**Architecture:** No build step. The front end is `public/*.js` + `public/styles.css`, served as-is. The server is `server.js` + `lib/`. All work happens in a worktree (`/opt/vault/board-look`, branch `look-and-feel`) and is checked on a throwaway preview container. A task goes live only when the owner runs the merge line handed to them. The main checkout's `public/`, `server.js` and `lib/` are bind-mounted into the live app, so the merge *is* the deploy.

**Tech Stack:** Node (Express 5), vanilla JS, one CSS file with tokens, `node:test`, puppeteer (npx cache) for visual checks.

**Spec:** the critique snapshot `/opt/vault/board/.impeccable/critique/2026-10-30T10-51-01Z__public-index-html.md` (git-ignored after Task 0). The decisions the owner made on top of it: wayfinding first; tone **"precise, not louder"** (keep the current look, make gold mean something, no new decoration); scope **all 5 priority issues + the quick bugs**; **one task at a time**.

## Global Constraints

- Tone: precise, not louder. No new colours, gradients, shadows or ornament. Brand shows in details.
- `--brand` = "this is VaultOS" (wordmark, active mode pill). `--accent` = "act on me". Keep the half-step gap between them (see CLAUDE.md "The palette is gold").
- Solid gold fill is reserved for the active mode pill and one primary action per screen (Today: the Focus Start button).
- Text contrast ≥ 4.5:1 against the surface it sits on, in **both** dark and sepia (`:root[data-theme="light"]`). The `@media print` block is out of scope.
- No `font-size` below 12px outside the spreadsheet grid (`.sg-*`), the `@font-face` rules and `@media print`.
- Use one name for the concept everywhere in the UI: **workspace**. (Code keeps `STATE.workspace`, and the API keeps `boards`.)
- Keep every behaviour CLAUDE.md lists as "don't undo": `holdScroll` pairing, refresh feedback, subtask fold, lazy-load guards.
- The repo is public. Before any push, check the added lines for private words (names, employers, hosts) and `git show --stat` for force-added `.superpowers/` files.
- Never edit `/opt/vault/board` main directly, never run the merge or `docker restart vault-board`. Hand the owner the one-line `!` command to run themselves.
- Run tests inside the image, not with the host's Node 18 (the command is in Task 0). 7 suites already fail on main (connector-fixes, connector-oauth, connector-relay, connector-service, fake-mcp-oauth, server-connectors, one sheet "Ruling 27"). These are not regressions; every other suite must stay green.

## Review Focus

1. **Switching workspace from the new header chip while a task drawer or KB article is open** must behave exactly like the Settings switch: the drawer closes, filters reset and the new workspace loads. Task 2 tests this.
2. **Dragging a card onto a collapsed empty column** must still drop there. The rail widens while a drag is in progress. Task 6 tests this.
3. **A title containing `\"`, `\\` and `#` together** parses literally, and a later status change (which goes through `setFrontmatterField`) leaves that title byte-identical. Task 1 tests this.
4. **The sepia theme** gets the same contrast floor as dark. A colour fixed only in dark is a failed task. Task 4's contrast test covers both themes.
5. **Phone width (390px)**: the header with the new chip still fits in the rows it uses today, and the mobile nav is unchanged. Task 2 tests this.

---

### Task 0: Worktree, preview and check script

**Files:**
- Create: worktree `/opt/vault/board-look` (branch `look-and-feel` from `main`)
- Modify: `.gitignore` (add `.impeccable/`)
- Move: this plan from the main checkout into the worktree, and commit it there. Left untracked in main, it would block the fast-forward merge.
- Create (outside the repo): `/opt/vault/look-check/` holding `vault/` (fixture vault), `data/` (preview password), `shoot.js` (screenshot script)

**Interfaces:**
- Produces: preview at `http://127.0.0.1:7695` (container `vb-look`); `node /opt/vault/look-check/shoot.js <label>` → PNGs in `/opt/vault/look-check/shots/<label>/`; test command `T` (below).

- [ ] **Step 1: Create the worktree, ignore `.impeccable/` and commit the plan**

```bash
cd /opt/vault/board && git worktree add -b look-and-feel /opt/vault/board-look main
mv docs/superpowers/plans/2026-10-30-look-and-feel-fixes.md /opt/vault/board-look/docs/superpowers/plans/
cd /opt/vault/board-look && printf '.impeccable/\n' >> .gitignore
git add .gitignore docs/superpowers/plans/2026-10-30-look-and-feel-fixes.md && git commit -m "Plan: look-and-feel fixes from the 2026-10-30 critique"
```

- [ ] **Step 2: Seed the fixture vault.** Use `/opt/vault/look-check/vault`. Model `.vaultos/settings.json` on `test/fs-rename.test.js`, with two boards, `personal` and `business`, and `features.today: true`. It must contain:
  - a task whose title is `"Add a \"ship kit\" to C:\\\\tools #3"`
  - a backlog task with `blocked_by:`, priority `high`
  - a task with priority `low`
  - one task each in-progress and needs-decision (with `decision_note:`)
  - **no** tasks in blocked, review or scheduled
  - a KB article (`article.md`) whose body starts `> **TL;DR:** PatchMon watches…` and whose frontmatter has `stack: [a, b, c, d, e, f, g, h, i, j, k]`
  - a file `core.123456` at the vault root
  - a `business` board with no articles

- [ ] **Step 3: Start the preview.** Use `docker run -d --name vb-look --user 1000:1000 -p 127.0.0.1:7695:8080`, `--entrypoint node`, and these env vars: `VAULT_DIR=/vault PORT=8080 DATA_DIR=/data LOCAL_READ=1 TERMINAL=0 TODAY_QUOTES=0 TZ=Europe/London ALLOWED_HOSTS=localhost,127.0.0.1`. Mount the fixture `vault` and `data`, plus the worktree's `server.js`, `lib/` and `public/`, read-only over `/app/…`, with image `vault-board:latest` and command `server.js`. If the page shows setup or login, write a password into `data` with `lib/password`'s `writePassword`.
  Expected: `curl -s http://127.0.0.1:7695/api/tasks?ws=personal` returns the fixture tasks.

- [ ] **Step 4: Write `shoot.js`.** It uses puppeteer from `/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer` and Chrome `/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome` with `--no-sandbox`. It shoots Today, Board, KB home, the KB article, Files and Settings, in dark and sepia, at 1600×1000 and 390×844@2x. Set the theme and workspace through `localStorage` before load (`vaultboard.workspace`, plus the theme key from `PREF` in app.js), and reach each mode by clicking `#mode-*` on desktop and `#mobile-nav [data-for=mode-*]` on phone.
  Run: `node /opt/vault/look-check/shoot.js baseline`. Expected: 24 PNGs. Read three of them to confirm they aren't login screens.

- [ ] **Step 5: Record the test command `T` and a baseline**

```bash
T() { docker run --rm --entrypoint node -w /app -v /opt/vault/board-look/server.js:/app/server.js:ro -v /opt/vault/board-look/lib:/app/lib:ro -v /opt/vault/board-look/public:/app/public:ro -v /opt/vault/board-look/test:/app/test:ro vault-board:latest --test "$@"; }
T 'test/*.test.js' 2>&1 | tail -5
```
Expected: only the 7 known suites fail. Write the failing list down; later tasks compare against it.

---

### Task 1: Quick bugs (escaped titles, TL;DR colon, crash dumps, stale Files copy)

**Files:**
- Modify: `server.js:149-174` (`parseFrontmatter`), `server.js:787-795` (`setFrontmatterField`), `server.js:355-372` (`articleExcerpt`), `server.js:2389-2402` (`walkRecent`)
- Modify: `lib/search.js:40-52` (`parseValue`), so search titles match the board
- Modify: `public/workbench.js:600` (Files intro copy)
- Test: create `test/look-bugs.test.js` (server harness as in `test/fs-rename.test.js`)

**Interfaces:**
- Produces: `parseFrontmatter(raw) → { meta, body }`, unchanged except that double-quoted scalars now honour the `\"` and `\\` escapes. Single-quoted scalars honour `''`.

- [ ] **Step 1: Write the failing tests** in `test/look-bugs.test.js`. Use a `lookServer(t, files)` helper modelled on `renameServer`:
  - `an escaped double-quoted title reads literally`: seed `title: "Add a \"ship kit\" to C:\\\\tools #3"`, then GET `/api/tasks?ws=personal` and assert the title is `Add a "ship kit" to C:\\tools #3` (one backslash).
  - `a status change leaves an escaped title byte-identical`: POST the status change the drawer uses (find the route next to `setFrontmatterField`'s caller), then assert the file's `title:` line is unchanged and the status line is updated.
  - `a value with a double quote is written escaped`: call the route that writes a free-text field (for example `decision_note`) with `say "yes"`, then assert the file holds `decision_note: "say \"yes\""` and that GET returns `say "yes"`. If no HTTP route writes free text through `setFrontmatterField`, export it from `server.js` behind `if (require.main !== module)` and test it directly instead.
  - `the KB excerpt drops "TL;DR:" with its colon`: assert the article's `excerpt` starts with `PatchMon`.
  - `crash dumps never show in recent files`: seed `core` and `core.123456` and assert neither is in `/api/fs/recent` items while `notes.md` is.
  - `search sees the same unescaped title`: assert `/api/search?q=ship` (find the real route in `server.js`) returns the title with `"ship kit"`.

- [ ] **Step 2: Run to confirm they fail.** Run `T test/look-bugs.test.js`. Expected: 6 failures (title `Add a \`, colon left on, `core.123456` listed, and so on).

- [ ] **Step 3: Implement.**
  - In `parseFrontmatter`, match the double-quoted scalar with `/^"((?:[^"\\]|\\.)*)"/` and unescape `\"` → `"` and `\\` → `\`. Match the single-quoted one with `/^'((?:[^']|'')*)'/` and unescape `''` → `'`.
  - Make `parseValue` in lib/search.js do the same.
  - `setFrontmatterField`: quote when the value matches `/[:#"\\]/` or has leading/trailing space, escaping `\` and then `"`.
  - `articleExcerpt`: change the strip to `/^TL;DR\s*[:—–-]?\s*/i`.
  - `walkRecent`: skip names matching `/^core(\.\d+)?$/`.
  - `workbench.js:600`: change the copy to `The whole vault. Click a file for a preview tab, double-click to keep it open; text files can be edited. Paths the agent prints in the terminal are clickable and land here.`

- [ ] **Step 4: Run.** Run `T test/look-bugs.test.js`, then `T 'test/*.test.js'`. Expected: the new file passes, and the full run fails only the 7 known suites.

- [ ] **Step 5: Look.** Restart the preview (`docker restart vb-look`, since server.js changed) and run `node shoot.js t1`. Board shows the title `Add a "ship kit" to C:\tools #3`; the KB card excerpt starts `PatchMon`; Files "Changed recently" has no `core.*`.

- [ ] **Step 6: Commit and hand over the release.** Use the commit message `Fix escaped frontmatter titles, the TL;DR colon, crash dumps in recent files, stale Files copy`. Give the owner: `! cd /opt/vault/board && git merge --ff-only look-and-feel && docker restart vault-board`, and tell them the restart ends open VaultOS terminals. After they paste the output back, check with `diff <(curl -s http://localhost:7684/workbench.js) public/workbench.js`.

---

### Task 2: Workspace chip in the header

**Files:**
- Modify: `public/index.html:30-31` (chip and menu after `.brand`), `public/index.html:66` (Settings nav label `Boards` → `Workspaces` and the section heading to match)
- Modify: `public/app.js:2066-2135` (`renderWorkspaceSwitcher`, new menu functions; rewrite the comment that says the switcher lives only in Settings), `public/app.js:1146` (`setMode`)
- Modify: `public/styles.css` (new `.ws-chip`, `.ws-menu` rules next to `.ws-row` at ~880, and the phone header block)

**Interfaces:**
- Consumes: `WORKSPACE_LIST`, `STATE.workspace`, `setWorkspace(key)`, `esc()`
- Produces: `renderWsMenu(): void`, `openWsMenu(): void`, `closeWsMenu(): void`; DOM `#ws-chip` (button, `aria-haspopup="menu"`, `aria-expanded`), `#ws-menu` (`role="menu"`, items `button[role=menuitemradio][aria-checked][data-ws]`)

- [ ] **Step 1: Write the failing check.** Create `/opt/vault/look-check/t2.js` (puppeteer, preview :7695, desktop and phone):
  - `#ws-chip` text equals the current workspace label (`Personal`).
  - Clicking it opens `#ws-menu` with 2 items, `aria-checked="true"` on Personal.
  - With a task drawer open, clicking Business closes the menu and the drawer, `#ws-chip` reads `Business`, `localStorage['vaultboard.workspace']==='business'`, and the board shows the business fixtures.
  - Escape and an outside click close the menu, and focus returns to the chip.
  - In Today and Files, the chip has class `ws-chip-off` and is still in the header (the header height is the same in every mode).
  - At 390×844, `header.getBoundingClientRect().height` is no taller than baseline (measure baseline in Step 2) and `#mobile-nav` is unchanged.
  - With only one workspace in `settings.json`, the chip shows its label and has no `aria-haspopup`.

- [ ] **Step 2: Run to confirm it fails.** Run `node /opt/vault/look-check/t2.js`. Expected: FAIL on `#ws-chip` not found. Record the baseline phone header height.

- [ ] **Step 3: Implement.**
  - **Markup.** The chip is `<button id="ws-chip" class="ws-chip">` holding a `<span class="ws-chip-label">` and a 12px chevron SVG in the style of the existing icons. It sits immediately after `.brand`, separated by a 1px `--line` divider.
  - **Styles.** `--text` label, `--muted` chevron, ghost button. In `.ws-chip-off`, the label goes `--muted` with `title="Today and Files cover the whole vault"` and stays clickable.
  - **Menu.** A dropdown anchored under the chip that uses the existing popover surface, with a selected item styled as in Task 5's "selected" rule (until then: `--panel-2` fill, `--text`).
  - **Keyboard.** ↑/↓ move, Enter picks, Escape closes.
  - **Picking.** `closeWsMenu(); setWorkspace(key)`.
  - **Wiring.** `renderWorkspaceSwitcher()` also sets the chip label and re-renders the open menu. `setMode()` toggles `ws-chip-off` for `today` and `files`.
  - **Phone.** The label is truncated with `max-width: 38vw` and ellipsis.
  - **Settings.** Keep the Settings radio list; it is still where workspaces are hidden.

- [ ] **Step 4: Run.** Run `node t2.js` (expected PASS), then `node shoot.js t2`. Read the desktop and phone Board and Today shots in both themes.

- [ ] **Step 5: Commit and hand over.** Use the commit message `Header: workspace chip with a switcher menu; "Workspaces" in Settings`. This task is front end only, so the hand-over is `! cd /opt/vault/board && git merge --ff-only look-and-feel` (no restart). Then diff `app.js` live against the repo.

---

### Task 3: Files loads in stages

**Files:**
- Modify: `public/workbench.js:94-109` (`fxLoad`), plus the Recent renderer and the `#fx-view` empty state (find where `fxRenderAll` draws them)
- Modify: `public/styles.css` (loading and error rows, using existing `--muted` text and no spinner art)

**Interfaces:**
- Consumes: `fxLoadDir(dir)`, `fxLoadRecent()`, `renderTree()`, `fxRenderAll()`
- Produces: `FX.recentState: 'loading' | 'ok' | 'error'` and `FX.rootState: 'loading' | 'ok' | 'error'`, both read by the renderers

- [ ] **Step 1: Write the failing check.** Create `/opt/vault/look-check/t3.js`, which uses puppeteer request interception on the preview:
  - With `/api/fs/recent` delayed 4s, the tree's root rows are visible within 1500ms of clicking Files, and Recent shows `Loading…`.
  - With `/api/fs/recent` aborted, the tree shows and Recent shows `Couldn't load recent changes` with a `Retry` button that refetches.
  - With the root tree request aborted, `#fx-view` shows `Couldn't open the vault` with `Retry`, not a blank pane.
  - Before the root arrives, `#fx-view` shows `Loading the vault…`.

- [ ] **Step 2: Run to confirm it fails.** Run `node t3.js`. Expected: FAIL, with the tree not visible until the 4s Recent delay ends.

- [ ] **Step 3: Implement.** In `fxLoad`:
  1. Set both states to `loading` and render.
  2. Await the root. On success, set `FX.loaded = true` and render the tree and any open tab straight away (keep the existing tab-restore lines).
  3. Load the expanded folders in the background (`Promise.all(...).then(renderTree)`), keeping the existing drop-missing logic and the `lsSet`.
  4. Run `fxLoadRecent()` independently, setting `recentState` and re-rendering Recent only.
  
  A root failure sets `rootState='error'` (pane message plus Retry, which calls `fxLoad()`). The toast is kept only for later refreshes.

- [ ] **Step 4: Run.** Run `node t3.js` (expected PASS) and `node shoot.js t3`.

- [ ] **Step 5: Commit and hand over.** Use the commit message `Files: show the tree as soon as the root loads; Recent and errors load in place`. The hand-over is front end only.

---

### Task 4: Readability floor (contrast and type scale)

**Files:**
- Modify: `public/styles.css`. That covers the `:root` tokens (~58-100), the sepia block (~140-150), every `font-size` declaration, and `::placeholder`.
- Test: create `test/look-tokens.test.js`, which reads `public/styles.css` as text (no browser).

**Interfaces:**
- Produces: type tokens `--t-xs: 12px; --t-sm: 13px; --t-md: 14px; --t-lg: 16px; --t-xl: 20px; --t-2xl: 26px; --t-3xl: 32px;` in the first `:root` block

- [ ] **Step 1: Write the failing tests.**
  - `muted text meets 4.5:1 in both themes`: parse `--muted`, `--muted-2`, `--bg`, `--panel` and `--panel-2` from the dark `:root` and from `:root[data-theme="light"]`, compute the WCAG ratio, and assert ≥ 4.5 for each muted token on each of the three surfaces.
  - `every font-size uses the type scale`: outside `@font-face`, `@media print` and selectors starting `.sg-`, each `font-size:` value must be `var(--t-*)`, `calc(var(--t-*) * var(--fs))`, an `em`/`%`/`rem` value, `inherit`, or a `clamp(...)` whose minimum is ≥ 12px.
  - `no type token is below 12px`.
  - `placeholders are themed`: a rule `::placeholder { color: var(--muted)` exists outside a single component.

- [ ] **Step 2: Run to confirm they fail.** Run `T test/look-tokens.test.js`. Expected: FAIL. Dark `--muted-2` measures 3.12 on `--panel-2`, sepia `--muted-2` 2.42, sepia `--muted` 3.55, and about 270 literal sizes are flagged.

- [ ] **Step 3: Implement.**
  - **Tokens.** Dark `--muted-2` becomes `#848e9f` (4.52 on `--panel-2`). In sepia, darken `--muted` and `--muted-2` until both pass on `--panel-2` (starting points: `--muted #6a5a42`, `--muted-2 #73634a`), keeping `--muted` darker than `--muted-2`.
  - **Placeholders.** Add a global `::placeholder { color: var(--muted); opacity: 1; }`.
  - **Literal sizes.** Map each one to the scale: 10–12.5px → `--t-xs`, 13–13.5 → `--t-sm`, 14–14.5 → `--t-md`, 15–17 → `--t-lg`, 18–22 → `--t-xl`, 23–28 → `--t-2xl`, 30–32 → `--t-3xl`. Keep any existing `calc(Npx * var(--fs))` shape with the token in place of N.
  - **Today headings.** Card titles (`.td-card-h h2`) go to `--t-lg` at weight 600, and the small labels go to `--t-xs`.

- [ ] **Step 4: Run.** Run `T test/look-tokens.test.js` (expected PASS) and the full `T 'test/*.test.js'` (only the 7 known failures). Then run `node shoot.js t4` and compare against `baseline` for dense views (Board cards, KB article chips, Files rows, Settings). Fix any wrapping or overflow the 12px floor causes before moving on.

- [ ] **Step 5: Commit and hand over.** Use the commit message `Readability: muted text at 4.5:1 in both themes, a 12px floor, one type scale`. The hand-over is front end only.

---

### Task 5: Gold means "VaultOS" or "act on me", and one way to show "selected"

**Files:**
- Modify: `public/styles.css:803` (`.ss-nav button.active`), `:852` (`.seg button.on`), `:880-883` (`.ws-row`), the Task 2 `.ws-menu` selected item, and `:2915`/`:2977` (habit ticks, daily-score bars)
- Test: add to `test/look-tokens.test.js`

**Interfaces:**
- Produces: the one "selected" rule for the app: `background: var(--panel-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--accent);`

- [ ] **Step 1: Write the failing tests.**
  - `only the mode pill and primary buttons fill with gold`: collect selectors whose `background` is `var(--accent)` or `var(--brand)` and assert the set equals the allowlist you write down from the current file. It must not include `.seg button.on`, `.td-tick[aria-pressed="true"]`, `.td-cell.on` or `.td-bar.sel .td-col`.
  - `selected states share one treatment`: `.seg button.on`, `.ss-nav button.active`, `.ws-row.active` and `.ws-menu [aria-checked="true"]` each declare the selected rule above.

- [ ] **Step 2: Run to confirm they fail.** Run `T test/look-tokens.test.js`.

- [ ] **Step 3: Implement.**
  - **Selected rule.** Apply it to the four selectors, and set radios to `accent-color: var(--accent)`.
  - **Habit ticks.** A done tick and a done cell become `background: color-mix(in srgb, var(--done) 24%, var(--panel-2)); border-color: color-mix(in srgb, var(--done) 60%, transparent);` with the check icon in `var(--done)`.
  - **Gold on Today.** Today's gold ring stays. The selected day's score bar uses `var(--brand)`, and the other bars use `color-mix(in srgb, var(--done) 55%, var(--panel-2))`.
  - **What stays the same.** Don't change `--done` itself, because Board and status colours use it.
  - **Check-icon contrast.** In both themes the check icon needs ≥ 3:1 against its fill. Check it with the same contrast helper.

- [ ] **Step 4: Run.** Run the tests (expected PASS) and `node shoot.js t5`. On Today in both themes, gold (date eyebrow, today ring, Start, the selected bar) should now lead over green.

- [ ] **Step 5: Commit and hand over.** Use the commit message `Gold for brand and primary action only; one quiet "selected" style; habit green steps back`. The hand-over is front end only.

---

### Task 6: Board cards carry less, and empty columns collapse

**Files:**
- Modify: `public/app.js:670-700` (`card`), `:758` (empty column), `:769-774` (drag start and end)
- Modify: `public/styles.css:377` (`.col`), `:418-423` (`.tag`), `:481` (`.blocked-on`), and the desktop board layout
- Check: the task drawer still shows the task id. If it doesn't, add it to the drawer's facts row.

**Interfaces:**
- Produces: `.col.col-empty` (desktop rail) and `body.board-dragging` (set on dragstart, cleared on dragend and on drop)

- [ ] **Step 1: Write the failing check.** Create `/opt/vault/look-check/t6.js` (preview, desktop and phone):
  - No `.card .tag` text equals the task's id.
  - A `pri-high` tag shows on the high card, and no `pri-med`/`pri-low` tag exists.
  - On the blocked card, `.blocked-on` computed colour equals `--muted` and `.blocked-on svg` equals `--danger-fg`.
  - At 1600px, Blocked, Review and Scheduled are `.col-empty` with width ≤ 56px and show their name and `0`.
  - Dragging a card (dispatch dragstart, then dragover/drop on the Review rail through `page.evaluate` with a `DataTransfer`) widens the rail during the drag, and after the drop the card's status is `review` (preview `LOCAL_READ` refuses writes, so assert the POST was *sent* with `review` using request interception).
  - At 390px, columns are unchanged from baseline (no rails on phone), and an empty column reads `No tasks`.
  - The drawer for the high card shows its id.

- [ ] **Step 2: Run to confirm it fails.** Run `node t6.js`.

- [ ] **Step 3: Implement.**
  - **Card.** In `card()`, drop the `t.id` tag and render the priority tag only when `t.priority === 'high'`.
  - **Blocked line.** Style `.blocked-on` as `color: var(--muted)`, with `.blocked-on .icon` coloured `var(--danger-fg)`.
  - **Empty columns.** Mark an empty column `col-empty` on desktop only (a CSS media query does the collapsing; the class is always set when empty).
  - **The rail.** It is a narrow column, 48px wide, with a vertical `writing-mode: vertical-rl` header showing the dot, the name and `0`.
  - **During a drag.** `body.board-dragging .col-empty` returns to full width so it is a normal drop target. Add and remove `board-dragging` next to the existing `dragging` class lines, and also on `drop`.
  - **Copy.** The empty text becomes `No tasks`.

- [ ] **Step 4: Run.** Run `node t6.js` (expected PASS) and `node shoot.js t6`.

- [ ] **Step 5: Commit and hand over.** Use the commit message `Board: lighter cards (no slug, priority only when high, quiet blocked-by), empty columns fold to a rail`. The hand-over is front end only.

---

### Task 7: Final polish, critique re-run, notes

**Files:**
- Modify: whatever the checks below turn up
- Modify: `CLAUDE.md`. Add a short "Selected state and gold" note under the palette section, a "Type scale" note, and the header chip next to the workspace notes.

- [ ] **Step 1:** Run `node shoot.js final` and read every shot in both themes at both sizes. Fix misalignments, wraps and leftover literal colours.
- [ ] **Step 2:** Run `/root/.claude/skills/impeccable/scripts/impeccable detect --json public` from the worktree. Expected: no `tiny-text` and no `low-contrast` on `--muted-2`. Any remaining finding is either fixed or noted as a known false positive (the list is in the critique snapshot).
- [ ] **Step 3:** Run `/impeccable critique` on VaultOS again and report the score against 24/40.
- [ ] **Step 4:** Run the full `T 'test/*.test.js'`. Expected: only the 7 known failures.
- [ ] **Step 5: Commit and hand over.** Before handing over, do the private-words check on `git diff main..look-and-feel` and check for force-added `.superpowers/` files. After the final merge, remove the worktree, branch, `vb-look` container and `/opt/vault/look-check`, and update the VaultOS memory.

---

## Not in this plan (raised by the critique, not chosen)

Today's two tick targets per habit, global keyboard shortcuts, the drawer's unlabelled icon toolbar, the Settings dot, and Sign out appearing twice. Run `/impeccable critique` after Task 7 to decide on those.
