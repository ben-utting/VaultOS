# Notes mode, Release 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quick capture of a thought into its own inbox file from anywhere in VaultOS, and a Notes mode that lists the inbox and main notes, shows a note with working `[[links]]`, edits it plainly, and deletes a rough note with Undo.

**Architecture:** Pure helpers (`lib/notes-names.js`, `lib/notes-parse.js`, `public/notes-core.js`) under a small service (`lib/notes-service.js`) that owns listing, capture and delete/undo. `server.js` adds four `/api/notes*` routes. Opening and saving a note reuse the existing `GET /api/fs/file` and `POST /api/fs/text/save`. The frontend adds `public/capture.js` (the box) and `public/notes.js` (the mode), wired into `setMode`, the header and the phone tab bar.

**Tech Stack:** Node (Express, `node:test`), vanilla JS frontend with no build step, puppeteer e2e against a preview container.

**Spec:** `docs/superpowers/specs/2026-11-01-notes-mode-design.md` (Parts 1 to 3; Parts 4 and 5 are Release 2, a separate plan).

## Global Constraints

- Work only in the worktree `/opt/vault/board-notes` (branch `notes`). Never edit `/opt/vault/board`: its `public/`, `server.js` and `lib/` are bind-mounted into the live app.
- Run tests in the image, not on host Node 18: `docker run --rm -v /opt/vault/board-notes:/src -w /src vault-board:latest node --test test/<file>`. Seven tests already fail on main (connector-fixes/oauth/relay/service, fake-mcp-oauth, server-connectors, one sheet "Ruling 27"); they are not regressions.
- Every date and time goes through `zonedDate` / `zonedTime` from `lib/today-note.js` with `settings.today.timezone`. No bare `toISOString().slice(0, 10)`.
- No frontmatter in any note the app writes.
- Product defaults are neutral: `notes: { dir: 'Notes', inbox: 'Inbox', main: 'Main', tags: 'Tags', template: 'Templates/Note.md' }`. Folder names from the owner's vault never appear in code, tests, fixtures or sandboxes (check against `scripts/private-words.txt`).
- Copy: "New thought" (button label), "What's on your mind?" (placeholder), "Saved to <inbox folder name>" + "Open" (toast), "Removed" + "Undo" (toast), "Too late to undo", "Couldn't save. Check the connection and try again.", "Nothing waiting. Ctrl+J catches the next thought." (phone: "Tap the pen to catch the next thought."). No em dashes in UI copy.
- Styling: `--t-*` font-size tokens, the shared selected-row rule, no new solid-gold fills. CSS class prefixes `nt-` (Notes mode) and `cp-` (capture).
- Limits: capture text must be non-empty after trim, contain no NUL, and be at most 1 MB (`FS_TEXT_MAX`). Names are at most 60 characters before `.md`. "Old" means `mtime` more than 7 days ago. Undo lasts 30 s. Leftover trash is swept after 1 day.
- `features.notes` off means no button, no shortcut, no mode, no tab, and every `/api/notes*` route answers 404 `{ error: 'Notes is off' }`.

## Review Focus

1. **Two captures in the same minute with the same first words, or a double press** should give two files (` 2` suffix) or one file respectively, never an overwrite. Pinned in Task 3 (concurrent capture test) and Task 6 (Save disabled in flight).
2. **A first line with nothing usable** (`???`, only `[[ ]]`, only spaces before a newline) should save under the bare timestamp name, not fail. Pinned in Task 2.
3. **A rough note deleted or renamed in Obsidian while Notes is open** should get "Already gone" and a list refresh on Done, not an error page. Pinned in Task 3 (404 on remove) and Task 7 (e2e N4).
4. **A restart inside the undo window** should give "Too late to undo" for the token, and the trashed file should be swept after a day, not kept forever or lost early. Pinned in Task 3 (sweep test) and Task 4 (unknown token answers 410).
5. **A notes folder or inbox that is a symlink out of the vault, or a setting with `..`** should refuse to write anything. Pinned in Task 1 (validation) and Task 3 (realpath test).

---

### Task 1: Settings, `/api/me`, and the Features toggle

**Files:**
- Modify: `lib/settings.js` (`defaults`, `validate`)
- Modify: `server.js` (`/api/me` at ~1044, `setFeatures` at ~1440)
- Modify: `public/app.js` (`ME` default ~118, the normaliser ~125, Features section ~2451/2465)
- Modify: `public/index.html` (Settings → Features: an `ft-notes` checkbox beside `ft-morning`)
- Test: `test/settings.test.js`, `test/server-settings.test.js`

**Interfaces:**
- Produces: `settings.features.notes: boolean` (default `false`); `settings.notes: { dir, inbox, main, tags, template }` (strings, defaults as in Global Constraints); `/api/me` → `notes: { enabled, dir, inbox, main, tags }`; `POST /api/settings/features` accepts `notes: boolean`. Client `ME.notes` is always an object; `notesOn()` in app.js returns `!!ME.notes.enabled`.

- [ ] **Step 1: Write the failing tests** in `test/settings.test.js`:
  - Update `defaults validate`: `features` gains `notes: false`; the object gains `notes: { dir: 'Notes', inbox: 'Inbox', main: 'Main', tags: 'Tags', template: 'Templates/Note.md' }`.
  - `notes values must stay inside the vault`: each of `{ dir: '../x' }`, `{ dir: '/abs' }`, `{ inbox: 'a/../../b' }`, `{ main: '' }`, `{ tags: 'a\u0000b' }` throws `/notes\.\w+ must be a folder inside the vault/`.
  - `notes folders must differ`: `{ inbox: 'X', main: 'X' }` throws `/notes\.inbox, notes\.main and notes\.tags must be different folders/`.
  - `notes keeps given values`: `validate({ version: 1, features: { notes: true }, notes: { dir: 'Z', inbox: 'R' } })` gives `features.notes === true` and `notes` equal to `{ dir: 'Z', inbox: 'R', main: 'Main', tags: 'Tags', template: 'Templates/Note.md' }`.
  - In `test/server-settings.test.js`: `POST /api/settings/features { notes: true }` answers 200, and `/api/me` then has `notes: { enabled: true, dir: 'Notes', inbox: 'Inbox', main: 'Main', tags: 'Tags' }`; `{ notes: 'yes' }` answers 400.

- [ ] **Step 2: Run them and see them fail**

Run: `docker run --rm -v /opt/vault/board-notes:/src -w /src vault-board:latest node --test test/settings.test.js test/server-settings.test.js`
Expected: FAIL on the new and updated tests only.

- [ ] **Step 3: Implement.** In `validate`, read `section(raw, 'notes')`, merge over the defaults, and check every value with one helper: non-empty string, not absolute, no leading `/` or `\`, no `..` segment, no NUL. In `setFeatures`, add `notes` beside `morningRead`, including the 400 message, which becomes `'today, terminal, morningRead and notes must be true or false'`. In `/api/me`, add `notes: { enabled, dir, inbox, main, tags }` from the settings (enabled is false when there are no settings). In the client, add `notes: { enabled: false }` to the `ME` default and normaliser, and an `ft-notes` checkbox labelled "Notes (capture and the Notes mode)" sent in the Features save body.

- [ ] **Step 4: Run the tests and see them pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/settings.js server.js public/app.js public/index.html test/settings.test.js test/server-settings.test.js
git commit -m "Notes: settings section, feature flag, /api/me notes"
```

### Task 2: Pure note helpers (names and parsing)

**Files:**
- Create: `lib/notes-names.js`, `lib/notes-parse.js`
- Test: `test/notes-names.test.js`, `test/notes-parse.test.js`

**Interfaces:**
- Produces, `lib/notes-names.js`:
  - `cleanName(text: string, max = 60): string`: takes the first line only; removes `/ \ : * ? " < > | # ^ [ ]` and control characters; collapses whitespace; trims; cuts at the last space at or before `max` (hard cut if there is none); strips trailing dots and spaces. It can return `''`.
  - `captureBase(text: string, date: Date, tz: string): string`: `"YYYY-MM-DD HHMM"`, plus `" " + cleanName(text, 60 - 16)` when that is non-empty.
  - `uniqueName(base: string, taken: (name: string) => boolean): string`: `base + '.md'`, else `base + ' 2.md'`, `' 3.md'`…
  - `captureBody(text: string, date: Date, tz: string): string`: `"YYYY-MM-DD HH:MM\n\n" + text.replace(/\s+$/, '') + "\n"`.
- Produces, `lib/notes-parse.js`:
  - `isStamp(line: string): boolean`: matches `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$` after trim.
  - `firstLine(text: string): string`: the first non-blank line that isn't a stamp, a `Status…` line or a `Tags…` line, with leading `#`s and spaces removed, cut to 120 characters; `''` if there is none.
  - `readStatus(text: string): 'baby' | 'child' | 'adult' | null`: from the first line matching `^Status\b`.
  - `readTags(text: string): string[]`: the `[[…]]` targets (text before any `|` or `#`) on the first line matching `^Tags\b`.

- [ ] **Step 1: Write the failing tests** (`zone = 'Europe/London'`, `at = new Date('2026-11-01T09:12:00Z')`):
  - `captureBase('Clubhouse should announce delays\nmore', at, zone)` === `'2026-11-01 0912 Clubhouse should announce delays'`
  - In summer time, `captureBase('x', new Date('2026-07-01T23:30:00Z'), zone)` === `'2026-07-02 0030 x'`
  - `captureBase('???', at, zone)` === `'2026-11-01 0912'`; `captureBase('  \nsecond', at, zone)` === `'2026-11-01 0912'`; `captureBase('[[ ]] #tag', at, zone)` === `'2026-11-01 0912 tag'`
  - `captureBase('a'.repeat(30) + ' ' + 'b'.repeat(30), at, zone).length <= 60` and it ends with `'a'.repeat(30)`
  - `cleanName('Why: a/b? "c" <d> | e*. ')` === `'Why ab c d e'`
  - `uniqueName('n', (x) => x === 'n.md' || x === 'n 2.md')` === `'n 3.md'`
  - `captureBody('line one\nline two\n\n\n', at, zone)` === `'2026-11-01 09:12\n\nline one\nline two\n'`
  - `firstLine('2026-11-01 09:12\n\n## Big idea here\nrest')` === `'Big idea here'`; `firstLine('\n\n')` === `''`
  - `readStatus('x\nStatus #child #quote\n')` === `'child'`; `readStatus('Status\n')` === `null`; `readStatus('no status')` === `null`
  - `readTags('Tags [[productivity]] [[AI|ai]] [[Deep work#2]]\n')` deep-equals `['productivity', 'AI', 'Deep work']`; `readTags('Tags\n')` deep-equals `[]`

- [ ] **Step 2: Run them and see them fail**

Run: `docker run --rm -v /opt/vault/board-notes:/src -w /src vault-board:latest node --test test/notes-names.test.js test/notes-parse.test.js`
Expected: FAIL, "Cannot find module".

- [ ] **Step 3: Implement** both files as specified. Use `zonedDate` / `zonedTime` from `lib/today-note.js`.

- [ ] **Step 4: Run the tests and see them pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/notes-names.js lib/notes-parse.js test/notes-names.test.js test/notes-parse.test.js
git commit -m "Notes: pure helpers for capture names and note parsing"
```

### Task 3: The notes service (list, capture, delete, undo, sweep)

**Files:**
- Create: `lib/notes-service.js`
- Test: `test/notes-service.test.js`

**Interfaces:**
- Consumes: Task 2's helpers; `atomicWrite` from `lib/atomic-write.js`.
- Produces: `createNotesService({ vaultDir: string, settings: () => Settings, now = () => new Date(), undoMs = 30000 })`, which returns:
  - `list(): Promise<{ inbox: InboxItem[], main: MainItem[], tags: string[], names: { name: string, path: string }[], missing: ('dir'|'inbox'|'main'|'tags')[] }>`
    - `InboxItem = { path, name, first, mtime, old }`, newest first. Only `.md` files directly in the inbox.
    - `MainItem = { path, title, status, tags, mtime }`, newest first. Only `.md` files directly in main.
    - `tags`: basenames (without `.md`) of the `.md` files in the tags folder, sorted.
    - `names`: every `.md` under `dir` (recursive; skips dot folders, `_tasks`, `_Templates`), main notes first then by path. Each `name` is a basename without `.md`; the first path wins for a duplicate name (compared case-insensitively).
    - Paths are vault-relative with `/`. Each file is read only for its first 4 KB.
  - `capture(text: string): Promise<{ path: string, name: string }>`: validates (empty → 400 `'Type something first.'`, NUL → 400 `'That text has a NUL byte.'`, over 1 MB → 413 `'That is too long for one note.'`). Creates the inbox folder if it's missing (one level, and only when `dir` exists; otherwise 409 `'The notes folder <dir> does not exist.'`). Picks `uniqueName` and writes with `atomicWrite`. Captures are serialised through one in-process promise chain, so two concurrent calls can't pick the same name.
  - `remove(rel: string): Promise<{ token: string }>`: `rel` must realpath to a file whose parent realpath is the inbox's (else 400 `'Only rough notes can be removed here.'`; a missing file → 404 `'Already gone.'`). Renames it to `<vault>/.vaultos/notes-trash/<16 random hex>.md`, records `token → { trash, rel }`, and unlinks the trash file after `undoMs`.
  - `undo(token: string): Promise<{ path: string }>`: an unknown or expired token → 410 `'Too late to undo.'`; the original path taken again → 409 `'A note with that name exists again.'`; otherwise renames it back.
  - `sweep(): Promise<void>`: unlinks files in `notes-trash/` with `mtime` more than 1 day old.
  - `NotesError extends Error` with `status`; exported alongside.
  - All folder checks resolve `realpath` and require the result to be inside `realpath(vaultDir)`; a folder that escapes counts as missing for `list` and gives 400 `'Path outside vault'` for writes.

- [ ] **Step 1: Write the failing tests.** Use a temp vault with `Notes/Inbox`, `Notes/Main`, `Notes/Tags`, `Notes/Sources/Books/A Book.md`, `Notes/_tasks/x.md`, settings `notes` at their defaults, and `today.timezone` `'Europe/London'`. Use a fixed `now`.
  - `list` returns the inbox newest first, `first` filled, `old` true for a file whose `utimes` is 8 days ago and false at 6 days; main items carry `status` and `tags`; `names` includes `A Book` and excludes `_tasks/x`; `missing` is `[]`.
  - `list` with `Notes/Tags` absent gives `missing: ['tags']` and `tags: []`.
  - `capture('Hello there')` creates `Notes/Inbox/2026-11-01 0912 Hello there.md` with the `captureBody` text.
  - `capture` twice concurrently with the same text (`Promise.all`) creates `… Hello there.md` and `… Hello there 2.md`.
  - `capture('   ')` rejects with status 400; `capture('a\u0000')` rejects with 400.
  - `capture` with no `Notes/Inbox` but `Notes` present creates the folder; with no `Notes` it rejects with 409.
  - `capture` when `Notes/Inbox` is a symlink to a folder outside the vault rejects with 400 and writes nothing outside.
  - `remove` on an inbox file moves it out (the file is gone, `.vaultos/notes-trash` has one file); `undo(token)` puts it back with the same content.
  - `remove` on a main note rejects with 400; `remove` on a missing inbox path rejects with 404.
  - With `undoMs: 20`: after 50 ms the trash file is gone and `undo(token)` rejects with 410.
  - `undo` after a new file now sits at the original path rejects with 409.
  - `sweep` removes a trash file whose `utimes` is 2 days ago and keeps one from 1 hour ago.

- [ ] **Step 2: Run them and see them fail**

Run: `docker run --rm -v /opt/vault/board-notes:/src -w /src vault-board:latest node --test test/notes-service.test.js`
Expected: FAIL, "Cannot find module".

- [ ] **Step 3: Implement `lib/notes-service.js`** as specified.

- [ ] **Step 4: Run the tests and see them pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/notes-service.js test/notes-service.test.js
git commit -m "Notes: service for listing, capture, delete and undo"
```

### Task 4: The routes

**Files:**
- Modify: `server.js` (create the service beside the other services; routes near the Today routes; call `sweep()` once at start-up)
- Test: `test/server-notes.test.js` (harness as in `test/text-save.test.js`: `startServer`, `login`, `seedVault`)

**Interfaces:**
- Consumes: Task 3's `createNotesService`, `NotesError`; Task 1's settings.
- Produces:
  - `GET /api/notes` → `list()`.
  - `POST /api/notes/capture { text }` → `{ path, name }`.
  - `POST /api/notes/delete { path }` → `{ token }`.
  - `POST /api/notes/undo { token }` → `{ path }`.
  - All four answer 404 `{ error: 'Notes is off' }` when `features.notes` is false. A `NotesError` answers its status and message; anything else is logged and answers 500 `{ error: 'Something went wrong.' }`.
  - Opening a note uses the existing `GET /api/fs/file?path=`; saving uses `POST /api/fs/text/save` (no new route).

- [ ] **Step 1: Write the failing tests.**
  - With notes off: `GET /api/notes` → 404.
  - With notes on: capture → 200 and the file exists on disk; `GET /api/notes` lists it in `inbox`; delete → token; undo → 200, file back; undo the same token again → 410.
  - Signed out but from loopback (no cookie): `GET /api/notes` → 200; `POST /api/notes/capture` → 401, nothing written.
  - `POST /api/fs/text/save` on a main note path with its `mtime` → 200 (proves the existing save path covers Notes); with a stale `mtime` → 409.

- [ ] **Step 2: Run them and see them fail**

Run: `docker run --rm -v /opt/vault/board-notes:/src -w /src vault-board:latest node --test test/server-notes.test.js`
Expected: FAIL (404 on routes that should exist).

- [ ] **Step 3: Implement** the routes. Build the service lazily (`notesSvc()`), reading `SETTINGS()` at each call, so a Features toggle needs no restart.

- [ ] **Step 4: Run the tests, plus `test/text-save.test.js` and `test/server-security.test.js`.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js test/server-notes.test.js
git commit -m "Notes: /api/notes routes"
```

### Task 5: Client pure logic (`NotesCore`)

**Files:**
- Create: `public/notes-core.js` (UMD like `public/search-core.js`, `window.NotesCore`)
- Test: `test/notes-core.test.js`

**Interfaces:**
- Produces:
  - `wikiSegments(text: string, names: Map<string, string>): Array<{ text: string } | { label: string, target: string, anchor: string|null, path: string|null }>`: parses `[[Target]]`, `[[Target#anchor]]` and `[[Target|label]]`. `names` maps a lower-cased name to its path; `path` is null when the name isn't there.
  - `ageLabel(mtime: number, now: number): string`: `'now'` under 1 min, then `'5m'`, `'2h'`, `'3d'`, `'5w'`.
  - `captureKeyIntent({ key, ctrlKey, metaKey, shiftKey, altKey, isMac, boxOpen, inEditable, inTerminal }): 'open' | null`: Ctrl+J (⌘J on a Mac), no Shift or Alt, box not open, not in an editable or a terminal.
  - `filterMain(items: MainItem[], { status: string|null, tag: string|null }): MainItem[]`.

- [ ] **Step 1: Write the failing tests:**
  - `wikiSegments('see [[AI]] and [[Gone#2|that]].', new Map([['ai', 'N/Main/AI.md']]))` deep-equals `[{ text: 'see ' }, { label: 'AI', target: 'AI', anchor: null, path: 'N/Main/AI.md' }, { text: ' and ' }, { label: 'that', target: 'Gone', anchor: '2', path: null }, { text: '.' }]`
  - `wikiSegments('no links', new Map())` deep-equals `[{ text: 'no links' }]`; an unclosed `'[[open'` stays text.
  - `ageLabel(now - 30e3, now)` === `'now'`; with 5 min → `'5m'`, 2 h → `'2h'`, 3 days → `'3d'`, 35 days → `'5w'`.
  - `captureKeyIntent` with `{ key: 'j', ctrlKey: true }` → `'open'`; with `inTerminal` → null; with `inEditable` → null; with `boxOpen` → null; on a Mac with `ctrlKey` only → null; with `metaKey` → `'open'`; with `shiftKey` → null.
  - `filterMain` by status `'child'` keeps only those; by tag `'AI'` keeps items whose `tags` include it; with both null it returns everything.

- [ ] **Step 2: Run and see them fail:** `… node --test test/notes-core.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** `git add public/notes-core.js test/notes-core.test.js && git commit -m "Notes: client pure logic"`

### Task 6: The capture box, its preview, and its e2e

**Files:**
- Create: `public/capture.js` (`window.Capture`)
- Modify: `public/index.html` (`#capture-btn` before `#search-btn`; `<script src="notes-core.js">` after `search-core.js`, `<script src="capture.js">` after `search-panel.js`)
- Modify: `public/app.js` (`toast(msg, opts)`; show or hide `#capture-btn` from `notesOn()`; handle `?capture=1` after sign-in)
- Modify: `public/styles.css` (`.cp-*`), `public/manifest.json` (`shortcuts`)
- Create: `scripts/notes-sandbox.js`, `scripts/notes-e2e.js`
- Create (outside the repo): `/opt/vault/notes-preview/{compose.yml,reset.sh,mint-cookie.js}`, copied from `/opt/vault/kb-preview` with container `notes-preview`, port `127.0.0.1:7695`, mounts from `/opt/vault/board-notes`, `TERMINAL: "0"`

**Interfaces:**
- Consumes: `POST /api/notes/capture`; `NotesCore.captureKeyIntent`; `ME.notes`.
- Produces:
  - `Capture.open()`, `Capture.close()`, `Capture.isOpen(): boolean`.
  - `toast(msg: string, opts?: { action?: string, onAction?: () => void, ms?: number })`: with `action` it renders a button that runs `onAction` and hides the toast; the default `ms` stays 5000.
  - The `Open` action calls `Notes.open(path)` when `window.Notes` exists (Task 7), else `setMode('notes')`.
  - `scripts/notes-sandbox.js <outDir>` writes a vault with `.vaultos/settings.json` (one board `Work`, `features: { today: false, notes: true }`, the default `notes` section, `today.timezone: 'Europe/London'`), 3 inbox notes (one dated 9 days ago), 3 main notes with neutral titles (`Small steps compound`, `Tools shape thinking`, `Rest is part of work`) carrying Status and Tags lines, 3 tag files, one `Sources/Books/Sample Book.md`, and `Templates/Note.md` with the layout from the spec.

- [ ] **Step 1: Set up the preview.** Create `/opt/vault/notes-preview/` from `kb-preview`, run `reset.sh`, and check: `curl -s -H "cookie: $(node /opt/vault/notes-preview/mint-cookie.js)" http://127.0.0.1:7695/api/notes | head -c 300` shows 3 inbox items.
- [ ] **Step 2: Write the e2e scenarios** in `scripts/notes-e2e.js` (structure as in `scripts/kb-reading-e2e.js`; flags `--phone`, `--theme=dark|sepia`; reset before each; screenshots to `/tmp/notes-shots/`):
  - **C1** The pen button opens the box with focus in the textarea; typing and Ctrl+Enter saves; the toast reads "Saved to Inbox"; `/api/notes` has 4 inbox items.
  - **C2** Ctrl+J opens the box from the Board; Ctrl+J inside a focused input does not open it.
  - **C3** Type text, press Esc, reopen: the text is still there; save, reopen: it's empty.
  - **C4** With the container stopped, save: the box stays open with the text and the message "Couldn't save. Check the connection and try again."
  - **C5** `/?capture=1` opens the box after load, and the URL no longer has `capture=1`.
  - **C6** Double-click Save: exactly one new file.
- [ ] **Step 3: Run them and see them fail:** `node scripts/notes-e2e.js C1 C2 C3 C4 C5 C6`. Expected: FAIL (no `#capture-btn`).
- [ ] **Step 4: Implement** `capture.js`, the toast option, the header button (pen icon, `aria-label` and `title` "New thought (Ctrl+J)", or "⌘J" on a Mac), the `?capture=1` handling (`history.replaceState`), and the manifest entry `"shortcuts": [{ "name": "New thought", "short_name": "Thought", "url": "/?capture=1", "icons": [{ "src": "icons/icon-192.png", "sizes": "192x192" }] }]`. The shortcut listener is capture-phase on `document`, bails on the same `overlayAbove` conditions as the search panel plus `SearchPanel.isOpen()`, and ignores `e.repeat`. The draft is in `localStorage['vaultboard.captureDraft']`, wrapped in try/catch. At ≤700px the box is a bottom sheet. Settings → Appearance's key list (`.ss-keys`) gains "New thought: Ctrl+J" (⌘J on a Mac).
- [ ] **Step 5: Run the scenarios on desktop and phone, in dark and sepia, and see them pass:** `node scripts/notes-e2e.js [--phone] [--theme=sepia] C1 C2 C3 C4 C5 C6`. Phone runs skip C2. Then look at the screenshots: the box is centred on desktop and sits above the bottom bar on the phone, and the header still fits at 390px.
- [ ] **Step 6: Commit**

```bash
git add public/capture.js public/index.html public/app.js public/styles.css public/manifest.json scripts/notes-sandbox.js scripts/notes-e2e.js
git commit -m "Notes: capture box, header button, Ctrl+J, home-screen shortcut"
```

### Task 7: Notes mode

**Files:**
- Create: `public/notes.js` (`window.Notes`)
- Modify: `public/index.html` (`#mode-notes` between Board and Files; `#notes-view` with `#nt-list` and `#nt-pane`; a `#mobile-nav` button `data-for="mode-notes"`; `<script src="notes.js">` before `capture.js`)
- Modify: `public/app.js` (`setMode` toggles `#mode-notes` / `#notes-view`, dims the workspace chip on `notes` as on `files`, calls `Notes.show()` / `Notes.hide()`; the mobile-nav observer list gains `mode-notes`; the mode button and tab hide when `!notesOn()`; Refresh restores `notes` with the selected path)
- Modify: `public/search-panel.js` (a `.md` hit whose path starts with `ME.notes.dir + '/'` opens with `Notes.open(path)` when `notesOn()`)
- Modify: `public/styles.css` (`.nt-*`)
- Modify: `scripts/notes-e2e.js` (scenarios N1 to N6)

**Interfaces:**
- Consumes: `GET /api/notes`, `GET /api/fs/file`, `POST /api/fs/text/save`, `POST /api/notes/delete|undo`; `NotesCore.*`; `toast(msg, opts)`.
- Produces: `Notes.show()`, `Notes.hide()`, `Notes.open(path: string)` (switches to Notes mode and selects the note), `Notes.refresh()`, `Notes.isDirty(): boolean` (the Edit textarea has unsaved text; `setMode` asks `confirm` before leaving).

- [ ] **Step 1: Write the e2e scenarios:**
  - **N1** Notes mode lists "Inbox (3)" and "Main Notes (3)"; the 9-day-old inbox note has the "old" mark; selecting a main note shows its rendered body, with `[[Tools shape thinking]]` as a link and `[[Missing note]]` muted.
  - **N2** Clicking the `[[Tools shape thinking]]` link opens that note; a `[[Sample Book]]` link opens Files on `Sources/Books/Sample Book.md`.
  - **N3** Edit, change the text, Ctrl+S: the disk has the new text. Edit again, change the file on disk behind it, Save: the "Changed elsewhere: Load theirs / Keep mine" bar shows, Load theirs shows the disk text, and Keep mine saves over it (it re-reads the file's `mtime` with `GET /api/fs/file`, then saves with that).
  - **N4** Done on an inbox note: it leaves the list and the toast "Removed" has Undo; Undo brings it back. Delete a file on disk, then press Done on its stale row: the toast reads "Already gone." and the list refreshes.
  - **N5** The status filter "child" and a tag filter narrow Main Notes; the empty Inbox shows "Nothing waiting. Ctrl+J catches the next thought." (phone: "Tap the pen…").
  - **N6** Capture's Open goes to Notes with the new note selected; a search panel pick of a main note opens it in Notes; Refresh in Notes comes back to the same note.
- [ ] **Step 2: Run them and see them fail:** `node scripts/notes-e2e.js N1 N2 N3 N4 N5 N6`. Expected: FAIL (no `#mode-notes`).
- [ ] **Step 3: Implement** `notes.js` and the wiring. Wikilinks: after inserting `renderBody`'s HTML, walk its text nodes outside `pre` and `code`, split them with `wikiSegments`, and replace each link segment with an `<a class="nt-link">` (Main Notes → `Notes.open`; anything else under `dir` → Files) or a `<span class="nt-link-missing">`. The list re-fetches on `show()`, after each write, on Refresh, and every 15 s while visible (paused while hidden). On the phone, list and pane show one at a time with a back button, like the KB. When `missing` is non-empty, the pane names each one: "notes.inbox points at Notes/Inbox, which doesn't exist."
- [ ] **Step 4: Run all scenarios on desktop and phone, in dark and sepia, and see them pass:** `node scripts/notes-e2e.js [--phone] [--theme=sepia] C1 C2 C3 C4 C5 C6 N1 N2 N3 N4 N5 N6`. Look at the screenshots: six tabs fit the phone bar at 390px, the selected row uses the shared rule, and both themes read well.
- [ ] **Step 5: Run the whole unit suite** `… node --test test/*.test.js`. Expected: only the seven known failures.
- [ ] **Step 6: Commit**

```bash
git add public/notes.js public/index.html public/app.js public/search-panel.js public/styles.css scripts/notes-e2e.js
git commit -m "Notes: Notes mode with Inbox, Main Notes, links, edit, Done and Undo"
```

### Task 8: Docs and the release hand-off

**Files:**
- Modify: `CLAUDE.md` (a "Notes mode (added 2026-11-…)" section: files, routes, the reuse of the fs routes, trash and undo, the preview and e2e commands, the Ctrl+J choice)
- Modify: `docs/superpowers/specs/2026-11-01-notes-mode-design.md` (a closing "What changed while building" list)

- [ ] **Step 1: Write both doc changes.** If Ctrl+J was swapped for another key, record which and why.
- [ ] **Step 2: Private-words check.** `git diff main..notes | grep '^+' | grep -iFf <(grep -v '^\s*#' scripts/private-words.txt | grep -v '^\s*$')`. Expected: no output. Also `git show --stat main..notes` contains no `.superpowers/` files.
- [ ] **Step 3: Commit** `git add CLAUDE.md docs/superpowers/specs/2026-11-01-notes-mode-design.md && git commit -m "CLAUDE.md: Notes mode"`
- [ ] **Step 4: Hand over the release.** Give Ben:
  - The settings change for his vault, as one `!` line he can run. It adds `"notes": true` to `features` and the `notes` block pointing at his own folders in `/opt/vault/vault/.vaultos/settings.json`. Tell him he can do the same with Settings → Features plus a hand edit.
  - `! cd /opt/vault/board && git merge --ff-only notes && docker restart vault-board`, and tell him it ends open VaultOS terminals.
- [ ] **Step 5: After his paste-back:**
  - Check `diff <(curl -s http://localhost:7684/notes.js) /opt/vault/board/public/notes.js` is empty.
  - Check `curl -s http://127.0.0.1:7684/api/me` shows `notes.enabled: true`.
  - Take one headless screenshot of Notes mode on `:7684` (read-only, no writes).
  - Stop and remove `notes-preview`, keep the worktree for Release 2, and update the `vaultos-notes-mode` memory.
