# Search Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the header's search box with a Search button and a Ctrl+F / Ctrl+K panel that finds tasks, articles, notes and files across every visible workspace. Hide the workspace chip when there is only one workspace.

**Architecture:**
- **Server:** a new session-authed `GET /api/search` sits on the existing in-memory index (`lib/search.js`). The index now returns task `status`. The route filters to visible workspaces and adds `ws`, `wsLabel` and `folder`.
- **Client, pure logic:** `public/search-core.js`, a UMD module tested under node. It covers key intent, grouping and the visible-path filter.
- **Client, DOM:** `public/search-panel.js` owns the overlay. `app.js` swaps the header box for `#search-btn` and `#search-chip`, and exposes the per-mode filter setters.

**Tech Stack:** Node/Express (`server.js`), vanilla JS front end, node:test, and puppeteer for browser checks.

**Spec:** `docs/superpowers/specs/2026-11-01-search-panel-design.md`

## Global Constraints

- Font sizes come only from the `--t-*` tokens, with a 12px floor. Text is ≥ 4.5:1 in dark and sepia. Add no new solid-gold fills (`test/look-tokens.test.js` allowlist). A selected row uses the shared selected rule.
- UI copy says "workspace", never "board", when it means a workspace. Exact strings:
  - `Search tasks, articles, notes and files` (the input placeholder)
  - `Filter Board to '<q>'`, `Filter Knowledge Base to '<q>'`, `Filter the Files tree to '<q>'`
  - `Nothing matches '<q>'`, `Clear filters`, `Search is unavailable`, `Show all <N>`, `Recent`
- **Results exclude:** hidden workspaces, folders that are not a workspace, the Today dir (`settings.today.dir`), `_tasks/`, and `_Templates`.
- The filter row's Type is `All · Tasks · Articles · Notes · Files`. Status shows only for Tasks. Filters persist in memory for the session only.
- **Shortcuts:** Ctrl+F / ⌘F and Ctrl+K / ⌘K open the panel. A second Ctrl+F / ⌘F while it is open closes it *without* `preventDefault`. Inside `.xterm`, `#fx-edit-box`, a sheet cell editor, or any input/textarea/contenteditable outside the panel, the shortcuts are left alone.
- Work happens in `/opt/vault/board-search` (branch `search-panel`). Preview container `vb-search` on `127.0.0.1:7697` with `TERMINAL=1`. Never touch the live `vault-board`.
- Tests run in the image, not on host Node: `source /opt/vault/search-check/T.sh; T <files>`.
- Fixture workspace names are neutral (`Work`, `Home`, `Archive`). Run the private-words check (`scripts/private-words.txt`) on the added lines before the hand-over.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A query that is only stopwords or punctuation** (`the`, `?`): the panel shows the Recent group, not "Nothing matches", and makes no failed request. Test in Task 3 (`intentForQuery`).
2. **Typing fast:** an older, slower response must never overwrite a newer one. Test in Task 5 (stale-response check).
3. **A task title with HTML or `&`** (the fixture has `<b>&amp;`): rendered as text in titles and snippets, never as markup, and `<mark>` wraps only matched words. Test in Task 5.
4. **The workspace the panel opens a task in is different from the header's:** the header chip, Board and drawer all switch together, and the old workspace's filter doesn't carry over. Test in Task 5.
5. **Ctrl+F while focus is in the Settings sheet's or KB dashboard's input:** left to the browser (it's an input outside the panel). Test in Task 3 (`keyIntent`).

---

### Task 0: Preview, check harness, baseline

**Files:** create the `/opt/vault/search-check/` folder (outside the repo): `build-fixture.js`, `T.sh`, `vault/`, `data/`, `baseline-failures.txt`.

- [ ] **Step 1: Build the fixture vault** at `/opt/vault/search-check/vault`.
  - `.vaultos/settings.json`:
    - boards: `work` (Work), `home` (Home), and `archive` (Archive, `hidden: true`)
    - `features: { today: true, terminal: true }`
    - `today.dir: "Home/Today"`
  - Each workspace has `_tasks/Board.md` (the kanban header).
  - **Work tasks:**
    - `Work/1. Ops/01-boiler/task.md`: title "Fix the boiler pressure", status `in-progress`
    - `Work/1. Ops/02-long/task.md`: title `Review <b>&amp; ship</b> the planning pack`, status `review`
    - `Work/1. Ops/03-garden/task.md`: "Plan the garden beds", `backlog`
  - **Home:**
    - `Home/2. Admin/01-dentist/task.md`: "Book the dentist", `scheduled`
    - `Home/2. Admin/01-dentist/article.md`: "Dentist notes"
    - `Home/notes/meeting-notes.md`: a plain note containing "boiler"
    - `Home/notes/invoice-boiler.pdf`: any bytes
    - `Home/Today/days/2026-11/2026-11-01.md`: a day note containing "boiler"
  - **Archive:** `Archive/1. Old/01-boiler-old/task.md`: "Old boiler job"
  - **Outside every workspace:** `Loose/boiler-thoughts.md`
- [ ] **Step 2: Start `vb-search`.** `docker run -d --name vb-search -p 127.0.0.1:7697:8080 --user 1000:1000 -e TERMINAL=1 -e SHELL=/bin/bash -e HOME=/data -e TZ=Europe/London`, with the worktree's `server.js`, `lib/` and `public/` mounted read-only over `/app`, `vault/` on `/vault`, `data/` on `/data`, image `vault-board:latest`. Write the password `search-preview-1` with `lib/password`'s `writePassword` into `data/`.
- [ ] **Step 3: Write `T.sh`.** Copy the round-2 pattern: `docker run --rm --user 1000:1000 --entrypoint node -e HOME=/tmp -e TZ=Europe/London`, with the worktree's `server.js`, `lib`, `public`, `scripts` and `test` mounted `:ro` on `/app`, `-w /app vault-board:latest --test "$@"`.
- [ ] **Step 4: Record the baseline.** Run `T 'test/*.test.js'` and write the failing test names to `baseline-failures.txt`. Expected: empty (main passed 1039/0 on 2026-11-01).

### Task 1: The index returns task status

**Files:** Modify `lib/search.js` (`parseDoc` ~line 93, the `search()` return ~line 229). Test `test/search.test.js`.

**Interfaces:** Produces: each `search()` result has `status: string` when `kind === 'task'` (the frontmatter `status:` value, `''` if missing) and no `status` key otherwise.

- [ ] **Step 1: Write the failing test** `a task result carries its status; a note does not`:
  - Seed `W/1. p/a/task.md` with `fm({ title: 'Boiler', status: 'review' })` and `W/n.md` containing `boiler`.
  - Assert the task hit's `status === 'review'`, and `!('status' in noteHit)`.
- [ ] **Step 2: Run** `T test/search.test.js`. Expected: FAIL on `status`.
- [ ] **Step 3: Implement.** Keep `status` on the doc in `parseDoc` (tasks only), and spread it into the result object.
- [ ] **Step 4: Run** `T test/search.test.js test/vault-recall.test.js test/server-kb-search.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `Search index: task results carry status`.

### Task 2: `GET /api/search`

**Files:** Modify `server.js` (next to `/api/fs/find`, ~line 2426). Create `test/search-route.test.js`.

**Interfaces:**
- Consumes: Task 1's `status`. Also uses `visibleBoards(SETTINGS())` from `lib/settings` and `searchIndex`.
- Produces: `GET /api/search?q=&kind=&ws=&status=&limit=` returns `{ results: [{ path, kind, title, date, snippet, ws, wsLabel, folder, status? }] }`.
  - `folder` is the path segments between the workspace dir and the file, joined with ` / `, with a trailing `task.md`/`article.md` (and, for a note, the file name) dropped.
  - Example: `Home/2. Admin/01-dentist/task.md` gives `2. Admin / 01-dentist`.
  - Example: `Home/notes/meeting-notes.md` gives `notes`.

- [ ] **Step 1: Write the failing tests.** Use `startServer`, `login` and `seedVault` from `test/helpers/server.js`, with the Task 0 fixture's shape (3 boards, `archive` hidden, today dir `Home/Today`):
  - `search requires a session`: no cookie gets 401.
  - `search requires q`: `q=` gets 400 `{ error }`.
  - `search finds tasks, articles and notes across visible workspaces`: `q=boiler` includes the Work task and the Home note.
  - `search leaves out hidden workspaces, loose folders and Today`: `q=boiler` has no path starting `Archive/`, `Loose/` or `Home/Today/`.
  - `kind, ws and status narrow results`:
    - `kind=task&status=review` gives only `Work/1. Ops/02-long/task.md`
    - `ws=home&kind=article` gives only the dentist article
    - a `status` param without `kind=task` is ignored
  - `results carry ws, wsLabel and folder`: the dentist task gives `{ ws: 'home', wsLabel: 'Home', folder: '2. Admin / 01-dentist', status: 'scheduled' }`.
  - `limit is clamped to 1..50`: `limit=500` returns ≤ 50, and `limit=0` behaves as 1.
  - `an unknown kind or ws gives 400`.
- [ ] **Step 2: Run** `T test/search-route.test.js`. Expected: FAIL, 404.
- [ ] **Step 3: Implement the route:**
  - Validate the params.
  - Call `searchIndex.search(q, { prefix: true, kind, under: ws ? dir + '/' : undefined, limit: limit * 3 })`.
  - Keep hits whose first path segment is a visible board's `dir`, and that aren't under the Today dir or a `_tasks/` segment.
  - Apply `status` when `kind === 'task'`, map the extra fields, and slice to `limit`.
- [ ] **Step 4: Run** `T test/search-route.test.js`, then `T 'test/*.test.js'`. Expected: PASS, with baseline failures only.
- [ ] **Step 5: Commit** `GET /api/search: whole-vault search over visible workspaces`.

### Task 3: `public/search-core.js`, the pure logic

**Files:** Create `public/search-core.js` (UMD: copy the head and tail of `public/today-next.js`, global `window.SearchCore`). Create `test/search-core.test.js`. Add `<script src="search-core.js">` before `app.js` in `public/index.html`.

**Interfaces:** Produces:
- `keyIntent({ key, ctrlKey, metaKey, shiftKey, altKey, isMac, panelOpen, inPanel, inEditable, inTerminal }) → 'open' | 'close-to-browser' | null`
  - `inEditable` means the event target is an input, textarea or contenteditable outside the panel, or `#fx-edit-box`, or a sheet cell editor.
  - The modifier is `metaKey` on a Mac, `ctrlKey` elsewhere. Shift or Alt held means `null`.
- `intentForQuery(q) → 'recent' | 'search'`: `'recent'` when `q` has no word characters (`/[\p{L}\p{N}]/u` fails).
- `filterLabel(mode, q) → string | null`, using the exact copy from Global Constraints. It is `null` for `'today'`.
- `visibleFileHits(items, workspaces, todayDir) → items`: drops directories, `.md` files, and paths outside the workspace dirs or under `todayDir`.
- `groupResults(results, files, { type }) → [{ key, label, items, total }]`:
  - The order is `task`/`Tasks`, `article`/`Articles`, `note`/`Notes`, `file`/`Files`, with empty groups omitted.
  - `items` is capped at 5 when `type === 'all'`, and uncapped otherwise.
- `highlight(text, q) → string`: HTML-escapes `text` first, then wraps each case-insensitive match of each query word (length ≥ 2) in `<mark>`.

- [ ] **Step 1: Write the failing tests**, one per function. They must include:
  - `keyIntent`: Ctrl+F with the panel closed gives `'open'`, and the same in a terminal gives `null`. Ctrl+F with `panelOpen` and `inPanel` gives `'close-to-browser'`. Ctrl+K with `panelOpen` gives `null`. ⌘F on a Mac gives `'open'`. Ctrl+F on a Mac gives `null`. Ctrl+F in the Settings input (`inEditable`) gives `null`. Ctrl+Shift+F gives `null`.
  - `intentForQuery('the ?')`: `'search'` only if a word character exists. `intentForQuery('  ')` and `intentForQuery('?!')` both give `'recent'`.
  - `filterLabel('board', 'x')` gives `Filter Board to 'x'`. `filterLabel('today', 'x')` gives `null`.
  - `visibleFileHits` drops `Archive/a.pdf`, `Loose/b.pdf`, `Home/Today/c.pdf`, `Home/n.md` and directories, and keeps `Home/notes/invoice-boiler.pdf`.
  - `groupResults`: correct order; a cap of 5 with `total` kept; an empty group omitted.
  - `highlight('<b>&amp; ship</b>', 'ship')` equals `'&lt;b&gt;&amp;amp; <mark>ship</mark>&lt;/b&gt;'`.
- [ ] **Step 2: Run** `T test/search-core.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `public/search-core.js`.
- [ ] **Step 4: Run** `T test/search-core.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `search-core: key intent, grouping, visible files, highlight`.

### Task 4: The header — Search button, filter chip, one-workspace chip

**Files:** Modify `public/index.html` (header ~line 35-42), `public/app.js` (`renderWorkspaceSwitcher` ~2116, `setMode` ~1197, the `#search` input handler ~2033, `clearAllFilters` ~594, `setWorkspace` ~2242, `kb-dash-search` ~1471), `public/workbench.js` (~371, `$('search')`) and `public/styles.css` (remove `.ws-chip-single`, add `#search-btn` and `#search-chip`). Create `/opt/vault/search-check/t-header.js`.

**Interfaces:** Produces, in `app.js`, as globals for Task 5:
- `currentFilter() → string`: the active mode's query (`STATE.query` / `STATE.kb.query` / `FX.query`), or `''` on Today.
- `applyFilter(q: string)`: sets the active mode's filter through its existing path (`render()`, `kbSearch`, `fxSearch`), then calls `renderSearchChip()`.
- `renderSearchChip()`: shows `#search-chip` as `"<q>" ×` when `currentFilter()` isn't empty, and hides it otherwise.

- [ ] **Step 1: Write the failing check `t-header.js`.** Use puppeteer on `vb-search`, at 1600×1000 and 390×844, signed in. It checks:
  - `#search` doesn't exist.
  - `#search-btn` is visible in Today, Board, KB and Files. At 1600 its text includes `Search` and `Ctrl F`; at 390 it is the icon only, with `aria-label="Search"`.
  - In Board, `applyFilter('boiler')` shows `#search-chip` containing `"boiler"`, and leaves only the matching card. Clicking its × clears the filter and hides the chip.
  - Switching to KB hides the chip, and switching back shows it again.
  - With settings changed to one visible workspace (through `PATCH /api/settings/boards/home` with `{hidden:true}`, restored afterwards; mind `settingsGuard`), `#ws-chip` is hidden. With two it is visible and opens `#ws-menu`.
  - The header stays one row at 1600 and 1100 with `#termbtn` visible.
- [ ] **Step 2: Run** `node /opt/vault/search-check/t-header.js`. Expected: FAIL.
- [ ] **Step 3: Implement:**
  - Replace the input with `#search-btn` (search icon, `Search`, `<kbd class="search-kbd">Ctrl F</kbd>` or `⌘F` on a Mac) and an empty `#search-chip` (`hidden`).
  - Remove the `#search` listener, and route every former `$('search').value` write through `renderSearchChip()`.
  - In `renderWorkspaceSwitcher`, hide the chip when `WORKSPACE_LIST.length < 2`.
  - Delete `ws-chip-single` and its CSS.
  - `#search-btn` click calls `SearchPanel.open()` if it exists (Task 5 adds it), so leave the call guarded.
- [ ] **Step 4: Run** `node t-header.js` (PASS), then `T 'test/*.test.js'` (baseline only, `look-tokens` included).
- [ ] **Step 5: Commit** `Header: Search button and filter chip; no workspace chip with one workspace`.

### Task 5: The panel

**Files:** Create `public/search-panel.js` (global `SearchPanel`) and add `<script src="search-panel.js">` after `workbench.js`. Modify `public/styles.css` (`.sp-*` rules) and `public/app.js` (wire the button). Create `/opt/vault/search-check/t-search.js`.

**Interfaces:**
- Consumes: `SearchCore.*` (Task 3), `currentFilter` / `applyFilter` / `renderSearchChip` (Task 4), `GET /api/search` (Task 2), `GET /api/fs/find`, `GET /api/fs/recent`, `STATE.tasks`, `WORKSPACE_LIST`, `setWorkspace(key)`, `setMode(mode)`, `openTask(path)`, `openArticle(path)`, `fxOpen(path, { reveal: true })`.
- Produces: `SearchPanel.open({ q?: string })`, `SearchPanel.close({ restoreFocus = true })`, `SearchPanel.isOpen() → boolean`.

- [ ] **Step 1: Write the failing check `t-search.js`** (1600×1000 and 390×844):
  - Ctrl+F opens `#search-panel` with the input focused. The fallback check: `Ctrl+K` does too. After `page.evaluate` sets `navigator.platform` to `MacIntel`, ⌘F does too.
  - A second Ctrl+F closes it, and the dispatched event's `defaultPrevented` is `false`.
  - Ctrl+F with focus in an open terminal's `.xterm-helper-textarea`, and in `#fx-edit-box`, doesn't open it.
  - Empty input shows a `Recent` group.
  - Typing `boiler`:
    - groups appear in the order Tasks, Notes, Files
    - the Work task, the Home note and `invoice-boiler.pdf` are present
    - no `Archive/`, `Loose/` or `Home/Today/` path appears
    - the first row reads `Filter Board to 'boiler'` (when opened from Board)
  - Typing `ship` shows the long-title task with `&lt;b&gt;` as text and `<mark>ship</mark>`, and no `<b>` element inside the row.
  - **Stale responses:** with `/api/search` delayed 800ms for `q=boi` and served immediately for `q=boiler` (puppeteer request interception), the final list is the `boiler` result.
  - **Picks:**
    - With the header on Home, picking the Work task switches `#ws-chip` to Work, shows Board, and opens the drawer on that task.
    - Picking the article opens the KB reader on it.
    - Picking the note opens it in Files.
    - Picking the PDF opens it in Files.
  - The Filter row on Board sets the chip and filters the cards.
  - Type → Tasks reveals Status, and Status → Review narrows the list to the long-title task. `Show all N` switches Type.
  - ↑/↓ move the selected row (it has the shared selected background), and Enter picks it.
  - Escape closes the panel and returns focus to `#search-btn`.
  - **Failure:** with `/api/search` aborted, the panel shows `Search is unavailable` and no toast.
  - **At 390:** the panel fills the viewport, and the input is within the top 120px.
- [ ] **Step 2: Run** `node t-search.js`. Expected: FAIL, `#search-panel` not found.
- [ ] **Step 3: Implement `public/search-panel.js`:**
  - **The key listener:** a capture-phase `keydown` on `document` uses `SearchCore.keyIntent`. On `'open'` it calls `preventDefault` and opens the panel; on `'close-to-browser'` it closes the panel and does *not* `preventDefault`. It bails when `DGV` or `DOCV` is open (the overlay Escape chain in CLAUDE.md).
  - **Searching:** debounce 150ms, using one `AbortController` per query and a sequence number so a stale response is dropped. Run `/api/search` and `/api/fs/find` in parallel; Files only when Type is All or Files, passed through `visibleFileHits`.
  - **Rendering:** render with `SearchCore.groupResults` and `highlight`. The Filter row comes from `filterLabel(STATE.mode, q)`.
  - **Picks:**
    - A task calls `setWorkspace(r.ws)` if it differs, then `setMode('board')`, then `openTask(r.path)` after the board loads.
    - An article: the same with `'kb'` and `openArticle`.
    - A note or file: `setMode('files')`, then `fxOpen(path, { reveal: true })`.
  - **Recent:** the top 8 by time from `/api/fs/recent?hours=720` merged with `STATE.tasks` (by `mtime`).
  - **Workspace filter:** use `MoreMenu`, with radios for All plus `WORKSPACE_LIST`.
  - **Styles:** desktop 640px wide, max-height 70vh, top 12vh, on a backdrop. At ≤700px it's a full-screen sheet. Use only `--t-*` sizes and existing tokens.
- [ ] **Step 4: Run** `node t-search.js` and `node t-header.js` (PASS), then `T 'test/*.test.js'` (baseline only).
- [ ] **Step 5: Commit** `Search panel: Ctrl+F / Ctrl+K across tasks, articles, notes and files`.

### Task 6: Notes and final pass

**Files:** Modify `CLAUDE.md`: a new "Search panel (2026-11-01)" section; update the workspace chip paragraph and the overlay Escape chain note.

- [ ] **Step 1:** Shoot Today, Board, KB, Files, the panel empty and the panel with results, at 1600, 1100 and 390, dark and sepia (reuse round 2's `shoot.js` pattern, rebuilt in `search-check/`). Read every image and fix any misalignment.
- [ ] **Step 2:** Run `/root/.claude/skills/impeccable/scripts/impeccable detect --json public`. Expected: no findings beyond main's 21 (compare by antipattern + file).
- [ ] **Step 3:** Re-run `t-header.js`, `t-search.js` and the full `T`.
- [ ] **Step 4:** Run the private-words check on `git diff main..search-panel` added lines. Expected: no hits.
- [ ] **Step 5: Commit** `CLAUDE.md: search panel, one-workspace chip`. Then hand the owner the release line: `! cd /opt/vault/board && git merge --ff-only search-panel && docker restart vault-board` (it ends open terminals).
