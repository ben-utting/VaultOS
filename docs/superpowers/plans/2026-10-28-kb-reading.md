# KB Reading History and Morning Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read history for KB articles lives on the server and counts only real reads. The KB shows reading time and "updated since you read it". Each morning VaultOS pops up one article from the open workspace.

**Architecture:** A new `lib/kb-reads.js` holds the rules as pure functions plus a small JSON store at `.vaultos/kb-reads.json`. `server.js` adds read state to the KB routes and four routes: read, import, morning GET and POST. `app.js` gets a read tracker in the reader and a server-fed dashboard. A new `public/kb-morning.js` draws the morning card.

**Tech Stack:** Node 22, Express 5, node:test, vanilla browser JS (classic scripts sharing app.js globals), puppeteer e2e against a preview container. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-28-kb-reading-design.md`

## Global Constraints

- Branch `kb-reading`, worktree `/opt/vault/board-kb-reading` (`$WT` below). Never edit `/opt/vault/board/{public,server.js,lib}`: they are bind-mounted into the live container.
- Tests run inside the image, because the host's Node 18 lacks `getSetCookie` and node-pty. `KT <files>` below means:
  `docker run --rm -u 0 -v /opt/vault/board-kb-reading:/src:ro --entrypoint bash vault-board:latest -lc 'cp -a /src /tmp/w && cd /tmp/w && rm -rf node_modules && cp -a /app/node_modules . && node --test <files>'`. The full suite is `KT 'test/*.test.js'`.
- Never run tests or e2e against `:7684`. The preview is `kb-preview` on `127.0.0.1:7693`.
- No change to `package.json`, `package-lock.json` or the Dockerfile. Release is a restart, not a rebuild.
- Rules, verbatim from the spec: window 05:00 to 12:00 in `settings.today.timezone`; one card per day per VaultOS; stale = last read 30 or more days ago; skip = 90 days; reading time = words ÷ 200, rounded, at least 1; a timed read needs `max(20, minutes × 30)` seconds visible.
- Dates and hours in the time zone go through `zonedDate` / `zonedTime` from `lib/today-note.js`. Never `toISOString().slice(0, 10)`.
- Text from the vault reaches the DOM through `textContent` or `esc()`, never raw.
- Colours come from tokens in `styles.css`. Every UI check runs in Dark and Sepia.
- Copy, exactly: "Morning read · N min", "Read now", "Not today", "Skip this one", "Updated since you read it", "Not read yet", "N min read", the Settings switch "Morning read" with hint "Once each morning, one Knowledge Base article you haven't read in a while.", and the Time zone hint "Today's days start at midnight here, and the morning read comes between 05:00 and 12:00." Read ages use the existing `readStaleness` wording ("Read today", "Read 3 days ago", "Read 1 month ago").
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Two devices act on the same card.** The phone says Not today, then the laptop's Read now posts and gets 409. Read now still opens the article. Not today and Skip close the card with no toast on 409. Tests: Task 5 (409), Task 7 (K4b).
- **The day's pick moves or goes before anyone acts.** A job moved into `_done/` is found by its folder key and the card shows the new path. A deleted one ends the day with no card. Test: Task 5.
- **A damaged `kb-reads.json`** (a hand edit, a half-written file). `/api/kb` still answers with everything unread, writes fail with the "damaged" message, and the file's bytes never change. Tests: Tasks 3 and 4.
- **A card on screen at 11:59, clicked at 12:01.** The POST checks today's pending pick, not the window, so it succeeds. Test: Task 5.
- **Junk in an old browser's localStorage**: non-numbers, future timestamps, `..` segments, boards that no longer exist. Each is dropped, the rest import, and nothing crashes. Test: Task 2.

---

### Task 1: Worktree, docs and baseline

**Files:**
- Move: `/opt/vault/board/docs/superpowers/specs/2026-10-28-kb-reading-design.md` and `/opt/vault/board/docs/superpowers/plans/2026-10-28-kb-reading.md` (untracked in the main checkout) into the same paths under `$WT`.

- [ ] **Step 1:** Use superpowers:using-git-worktrees to run `git -C /opt/vault/board worktree add /opt/vault/board-kb-reading -b kb-reading main`. Expected: the worktree's HEAD is `2fd80f9`.
- [ ] **Step 2:** `mv` both docs into `$WT/docs/superpowers/{specs,plans}/`. `git -C /opt/vault/board status --short` then shows nothing untracked.
- [ ] **Step 3:** Run the baseline `KT 'test/*.test.js'`. Expected: all pass. Write the count into the commit message.
- [ ] **Step 4:** Commit: `git add docs && git commit -m "Spec and plan: KB reading history and the morning read"`.

### Task 2: Reading rules in `lib/kb-reads.js`

**Files:**
- Create: `lib/kb-reads.js`, `test/kb-reads.test.js`, `test/helpers/zone.js`

**Interfaces:**
- Produces (`lib/kb-reads.js`):
  - Constants: `READS_REL = '.vaultos/kb-reads.json'`, `MORNING_START = 5`, `MORNING_END = 12`, `STALE_DAYS = 30`, `SKIP_DAYS = 90`, `WORDS_PER_MIN = 200`.
  - `emptyState() → { version: 1, articles: {}, morning: null }`
  - `articleKey(relPath: string) → string`: the job folder name.
  - `readingMinutes(body: string) → number`
  - `readState(article: { updated?: string }, entry: { read?: number } | undefined, tz: string) → 'unread' | 'read' | 'updated'`
  - `inMorning(now: number, tz: string) → boolean`
  - `morningCandidates(articles, entries: { [key]: { read?, skipUntil? } }, now: number, tz: string) → Array<{ article, reason: 'updated' | 'unread' | 'stale' }>`, in pick order.
  - `morningPick(...same) → { article, reason } | null`, the first candidate.
  - `mergeImport(state, boards: Array<{ key, dir }>, map: object, now: number) → { state, imported: number }`. Pure: it returns a new state.
- Produces (`test/helpers/zone.js`): `zoneAtHour(hour: number, now = Date.now()) → string`. An `Etc/GMT±N` zone whose local hour at `now` is `hour`. Remember the inverted sign: `Etc/GMT-8` is UTC+8. Keep the offset within -12..+14 by adding or subtracting 24.

- [ ] **Step 1: Write the failing tests** in `test/kb-reads.test.js`:
  - `articleKey('Personal/1. apps/_done/38-cloudflare/article.md') === '38-cloudflare'`
  - `readingMinutes`: 400 words → 2. 50 words → 1. 1,000 words plus a 600-word fenced block → 5. Words inside `<!-- -->` are not counted.
  - `readState` with tz `Europe/London`: no entry → `'unread'`. `{ skipUntil }` only → `'unread'`. Read `2026-10-01T10:00Z` with `updated: '2026-10-01'` → `'read'`, and with `'2026-10-02'` → `'updated'`. Read `2026-10-01T23:30Z` (00:30 on the 2nd in London) with `updated: '2026-10-02'` → `'read'`. `updated: ''` → `'read'`.
  - `inMorning` in `UTC`: 04:59 false, 05:00 true, 11:59 true, 12:00 false. In `Europe/London`, `2026-07-01T04:30Z` → true.
  - `zoneAtHour`: `inMorning(now, zoneAtHour(8, now))` is true and `inMorning(now, zoneAtHour(15, now))` is false, for `now` at each UTC hour 0..23 of one day.
  - `morningCandidates` with `now = 2026-10-29T08:00Z`, tz `UTC`, and these articles (key = folder, `status: 'published'` unless stated):
    - A: updated 10-20, read 09-01
    - B: updated 10-25, read 10-26
    - C: unread, updated 10-10
    - D: unread, updated 10-27
    - E: updated 08-01, read 09-10
    - F: updated 07-01, read 08-01
    - G: `status: 'draft'`, unread
    - H: unread, `skipUntil` tomorrow
    - I: updated 10-28, read 10-27
    - J: unread, `skipUntil` yesterday, updated 10-01

    Expected order by key: `I, A, D, C, J, F, E` with reasons `updated, updated, unread, unread, unread, stale, stale`. B, G and H are absent. `morningPick` gives I. `morningPick([], …)` gives null. Two unread articles with the same `updated` order by title.
  - `mergeImport`, boards `personal → Personal` and `work → Work`. The state has `personal['38-x'].read = 5000`. The map is:
    - `'Personal/1. apps/38-x/article.md': 4000` (older, ignored)
    - `'Personal/1. apps/_done/39-y/article.md': 6000`
    - `'Work/2. ops/05-z/article.md': 7000`
    - `'Archive/1. a/09-q/article.md': 8000` (no board)
    - `'Personal/a/../40-w/article.md': 1` (`..`)
    - `'Personal/1. apps/41-v/article.md': 'yesterday'`
    - `'Personal/1. apps/42-u/article.md': now + 2 days`

    Expected: `imported === 2`. `personal['38-x'].read === 5000`, `personal['39-y'].read === 6000`, `work['05-z'].read === 7000`, and no other keys. The input state is unchanged.
- [ ] **Step 2:** Run `KT test/kb-reads.test.js`. Expected: FAIL, `Cannot find module '../lib/kb-reads'`.
- [ ] **Step 3:** Implement `lib/kb-reads.js` and `test/helpers/zone.js` to those interfaces.
  - For the hour, use `Number(zonedTime(new Date(now), tz).slice(0, 2))`.
  - Candidate filters: drop `status` other than `published` (empty means published) and any `skipUntil > now`.
  - Sorts: `updated` by `updated` desc, `unread` by `updated || created` desc, `stale` by `read` asc, each then by title.
  - Stale means `now - read >= STALE_DAYS * 86400000` with state `'read'`.
  - `mergeImport` keeps an entry only if: the value is a finite number in `(0, now]`, the path has no `..` segment, it starts with a board's `dir + '/'`, and it ends in `/article.md`.
- [ ] **Step 4:** Run `KT test/kb-reads.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `lib/kb-reads.js test/kb-reads.test.js test/helpers/zone.js` as "KB reads: reading rules, morning pick order, import merge".

### Task 3: The read store

**Files:**
- Modify: `lib/kb-reads.js`
- Create: `test/kb-reads-store.test.js`

**Interfaces:**
- Consumes: `emptyState`, `READS_REL` (Task 2); `atomicWrite` from `lib/atomic-write.js`.
- Produces: `createReadStore(vaultDir: string) → { get(): State, update(fn: (draft: State) => State): Promise<State>, damaged(): string | null }`.
  - `get` loads the file synchronously the first time, then serves memory.
  - `update` runs queued, one at a time. It passes `fn` a deep copy, writes the result with `atomicWrite` (making `.vaultos/` if needed), then swaps memory.
  - `DAMAGED_MSG = '.vaultos/kb-reads.json is damaged. Fix or delete it.'`. `update` rejects with `Object.assign(new Error(DAMAGED_MSG), { status: 500 })`.

- [ ] **Step 1: Write the failing tests**, each in its own `fs.mkdtempSync` vault:
  - With no file, `get()` deep-equals `emptyState()` and `damaged()` is null.
  - `update` writes the file as 2-space JSON, and a second `createReadStore` on the same dir reads the same state.
  - 20 parallel `update`s, each adding its own key, leave all 20 keys in memory and on disk.
  - With `{not json` on disk: `get()` is empty, `damaged()` is `DAMAGED_MSG`, `update` rejects with that message and `status` 500, and the file's bytes are unchanged.
  - `{"version":2}` and `{"version":1,"articles":[]}` count as damaged too.
- [ ] **Step 2:** Run `KT test/kb-reads-store.test.js`. Expected: FAIL, `createReadStore is not a function`.
- [ ] **Step 3:** Implement `createReadStore` and export `DAMAGED_MSG`.
- [ ] **Step 4:** Run `KT test/kb-reads.test.js test/kb-reads-store.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit as "KB reads: the .vaultos/kb-reads.json store, never overwriting a damaged file".

### Task 4: Server: read state on articles, read and import routes, the feature switch

**Files:**
- Modify: `lib/settings.js:18` (defaults), `server.js` (KB section near `app.get('/api/kb'`, `/api/me`, `setFeatures`)
- Create: `test/server-kb-reads.test.js`
- Modify: `test/settings.test.js`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - Article meta from `loadArticleRaw` gains `minutes`. `/api/kb` and `/api/kb/article` articles also gain `lastRead: number | null` and `readState`.
  - `async function articleFrom(wsKey, relPath) → { ws, article }`. It holds the checks both `/api/kb/article` and `/api/kb/read` use (normalise, inside `ws.dir`, basename `article.md`, `realInWorkspace`, present in `scanKB`). It throws `Error('Not an article file' | 'Article not found')`, which the routes turn into a 400. `/api/kb/article` switches to it.
  - `POST /api/kb/read?ws=` `{ path }` → `{ lastRead, readState }`.
  - `POST /api/kb/reads/import` `{ reads }` → `{ imported }`.
  - `/api/me` `features.morningRead: boolean`. `/api/settings/features` accepts `morningRead`.
  - Module-level `const READS = createReadStore(VAULT_DIR)` and `const kbZone = () => SETTINGS().today.timezone`.
  - The write routes check `sessionAuthed(req)` themselves (401 otherwise), even though the `/api` gate already refuses non-GET local reads.

- [ ] **Step 1: Write the failing tests.** Seed like `server-kb-search.test.js`, with boards `personal → Personal` and `work → Work`, articles `Personal/1. a/01-a/article.md` and `Work/1. b/05-s/article.md`, and a `task.md` beside 01-a.
  - `GET /api/kb?ws=personal`: each article has `minutes >= 1`, `lastRead === null` and `readState === 'unread'`.
  - `POST /api/kb/read` without a cookie → 401.
  - With a cookie, it returns 200 with a numeric `lastRead` and `readState: 'read'`. `/api/kb` then shows the same `lastRead`, and the file holds `articles.personal['01-a'].read`.
  - These return 400 and leave the file absent: the sibling `task.md`; the Work article under `ws=personal`; `Personal/../Work/1. b/05-s/article.md`.
  - `GET /api/kb/article` carries `minutes`, `lastRead` and `readState`.
  - Import of `{ reads: { 'Personal/1. a/01-a/article.md': <now-1000>, 'Work/1. b/05-s/article.md': <now-2000> } }` → `{ imported: 2 }`, and `/api/kb?ws=work` shows that `lastRead`. `{ reads: [] }` and `{}` → 400.
  - With `{bad` in `.vaultos/kb-reads.json` before start: `/api/kb` is 200 with everything unread. `POST /api/kb/read` → 500 and the error contains `kb-reads.json is damaged`. The file is unchanged.
  - `/api/me` has `features.morningRead === true`. `POST /api/settings/features {morningRead:false}` → 200, then `/api/me` shows false. `{morningRead:'no'}` → 400.
  - In `test/settings.test.js`: `defaults().features.morningRead === true`. A settings file without the key loads as true. `"morningRead": "yes"` throws `features.morningRead must be true or false`.
- [ ] **Step 2:** Run `KT test/server-kb-reads.test.js test/settings.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement.
  - `features: { today: false, terminal: true, morningRead: true }` in `lib/settings.js`.
  - `minutes: readingMinutes(body)` in `loadArticleRaw`.
  - A `withReads(articles, wsKey)` mapper used by both GET routes.
  - `articleFrom`, the two POST routes, and the `/api/me` and `setFeatures` additions. `setFeatures` validates `morningRead` like `terminal`.
- [ ] **Step 4:** Run `KT 'test/*.test.js'`. Expected: all pass, including `server-kb-search.test.js`.
- [ ] **Step 5:** Commit as "KB reads on the server: read state on articles, read and import routes, Morning read setting".

### Task 5: Server: the morning routes

**Files:**
- Modify: `server.js`
- Create: `test/server-kb-morning.test.js`

**Interfaces:**
- Consumes: `READS`, `kbZone`, `articleFrom`, `withReads` (Task 4); `morningPick`, `inMorning`, `articleKey`, `SKIP_DAYS` (Task 2); `zonedDate`.
- Produces:
  - `GET /api/kb/morning?ws=` → `{ card: null | { ws, wsLabel, path, title, excerpt, collectionName, minutes, lastRead, reason } }`.
  - `POST /api/kb/morning` `{ action: 'open' | 'later' | 'skip' }` → `{ ok: true }`. 400 for a bad action, 409 with no pending pick for today.
  - The stored pick is `morning: { date, ws, key, at, reason, done }`. It is found again by `key` in `ws`'s current `scanKB`, so a moved folder still resolves. "Read since the pick" means `entry.read > at`. A local-read GET computes the card but never calls `READS.update`.

- [ ] **Step 1: Write the failing tests.** Boards: personal (articles `01-new` updated yesterday, `02-old` read 40 days ago), work (`05-s`), business (no articles). The time zone is `zoneAtHour(8)` unless a test says outside, where it is `zoneAtHour(15)`.
  - Outside the window → `{ card: null }`, and no file.
  - `features.morningRead: false` → null.
  - Inside, `ws=personal`: the card is `01-new` with `ws: 'personal'`, `wsLabel: 'Personal'`, `reason: 'unread'`, `lastRead: null` and `minutes >= 1`. The file's `morning.date === zonedDate(new Date(), tz)` and `done === false`.
  - `ws=work` the same day → the same card, still `ws: 'personal'`.
  - On a fresh server, `ws=business` first → null and `morning` still null. Then `ws=personal` → a card.
  - `later` → 200, then GET → null, then `later` again → 409.
  - `skip` → `articles.personal['01-new'].skipUntil` is within 60 s of `now + 90 days`. GET → null.
  - `open` → done, and `articles.personal['01-new'].read` stays unset.
  - `{ action: 'nope' }` → 400. No cookie → 401.
  - Pick, then `POST /api/kb/read` for it, then GET → null with `morning.done === true`.
  - Pick, then rename `Personal/1. a/01-new` to `Personal/1. a/_done/01-new`, then GET → the same card with the new `path`.
  - Pick, then delete the folder, then GET → null with `done` true.
  - Outside the window with a seeded pending pick for today in that zone, `later` → 200.
  - `LOCAL_READ=1` with no cookie, inside the window: GET → a card, and no `kb-reads.json` exists afterwards.
- [ ] **Step 2:** Run `KT test/server-kb-morning.test.js`. Expected: FAIL (404s).
- [ ] **Step 3:** Implement both routes following spec "server.js → GET /api/kb/morning" steps 1-3 and the POST rules. `wsLabel` comes from `boards()`.
- [ ] **Step 4:** Run `KT 'test/*.test.js'`. Expected: all pass.
- [ ] **Step 5:** Commit as "Morning read: the day's pick, shared across devices, and its open/later/skip actions".

### Task 6: Reader, dashboard, import and the Settings switch, with the preview and its e2e

**Files:**
- Create (outside the repo, not committed): `/opt/vault/kb-preview/compose.yml`, `reset.sh`, `mint-cookie.js`, `data/`
- Create: `scripts/kb-sandbox.js`, `scripts/kb-reading-e2e.js`
- Modify: `public/app.js` (`ME` defaults ~112, `fetchMe`, KB welcome ~1209-1240, `renderKBWelcome`, `openArticle` ~1476, `setMode` ~1116, `goToKBHome`, `setWorkspace` ~2027, `start` ~2395, Settings features ~2228-2245), `public/index.html` (~181-196), `public/styles.css` (near `.kb-unread`, ~1164)

**Interfaces:**
- Consumes: the Task 4 API.
- Produces, as app.js globals for Task 7: `readStaleness(lastRead: number) → string` (the signature changes from `(p, reads)`), `stopReadTracker()`, plus the existing `openArticle`, `setMode`, `setWorkspace`, `STATE`, `api`, `ws`, `toast`, `esc`, `sheetOpen`, `DGV`, `DOCV`, `ME`.
- Preview: `compose.yml`
  - Container `kb-preview` from image `vault-board:latest`, `user: "1000:1000"`, `init: true`, port `127.0.0.1:7693:8080`.
  - Env: `VAULT_DIR=/vault`, `DATA_DIR=/data`, `PORT=8080`, `SECURE_COOKIE=0`, `TERMINAL=0`, `TODAY_QUOTES=0`.
  - Volumes: `./vault:/vault`, `./data:/data`, and `$WT/{server.js,lib,public,scripts}` read-only over `/app/…`.

  `data/config.json` is made once, with `node -e "require('$WT/lib/password').writePassword('/opt/vault/kb-preview/data', 'kb-preview-only')"` and then chowned to 1000. `mint-cookie.js` is `today-preview/mint-cookie.js`, reading `data/config.json`. `reset.sh` wipes `vault/`, runs `node $WT/scripts/kb-sandbox.js vault --zone="$(node -e "console.log(require('$WT/test/helpers/zone').zoneAtHour(8))")"`, chowns, then `docker restart kb-preview`.
- `scripts/kb-sandbox.js <outDir> --zone=<tz>` writes, with D = today in the zone:
  - `.vaultos/settings.json`: boards `personal`/Personal, `work`/Work, `business`/Business (empty); `features { today: false, terminal: false, morningRead: true }`; `today { dir: 'Personal/Today', timezone: zone }`.
  - A `_tasks/Board.md` per board.
  - Articles, each with a `> **TL;DR**` line:
    - `Personal/1. apps/01-long-read` "Long read", D-1, about 1,300 words in 8 `##` sections
    - `Personal/1. apps/02-short-note` "Short note", D-40, about 60 words
    - `Personal/1. apps/_done/03-moved-job` "Moved job", D-60
    - `Personal/2. platform/04-draft-idea` "Draft idea", `status: draft`, D-5
    - `Work/1. ops/05-work-runbook` "Work runbook", D-2
  - `.vaultos/kb-reads.json` with `02-short-note` read at noon UTC on D-50 and `03-moved-job` read on D-45.
- `scripts/kb-reading-e2e.js [--phone] [--theme=sepia] K1 …`: the harness is `scripts/today-e2e.js`, adapted.
  - It allows only `http://127.0.0.1:7693` and refuses port 7684.
  - Before each scenario it runs `reset.sh` and waits for a signed-in `/api/kb?ws=personal` 200.
  - Contexts start with `vaultboard.workspace` set to `personal` unless a scenario says otherwise.
  - Output is PASS/FAIL lines, exit code 1 on any failure and 2 on bad usage. Screenshots go to `/tmp/kb-shots/<K>-<desktop|phone>-<dark|sepia>.png`.

- [ ] **Step 1:** Build the preview and the sandbox. Run `reset.sh`. Expected: a signed-in `curl` to `127.0.0.1:7693/api/kb?ws=personal` returns 5 articles, and `03-moved-job` has `readState: 'read'` (Task 4's server code is already mounted).
- [ ] **Step 2: Write the failing e2e scenarios.**
  - **K1, reader.** Open "Short note" (it fits one screen) and wait 3 s, then go back: `/api/kb` gives it `lastRead` null. Reopen it and wait 32 s: `lastRead` is set and `#kb-readline` reads `1 min read · Read today`. Open "Long read" and wait 2 s: `lastRead` null. Then scroll `.kb-read-end` into view: within 3 s `lastRead` is set.
  - **K2, dashboard.** The unread stat shows `2`. The picks' `h3`s are `['Short note', 'Long read', 'Draft idea']`, with meta `['Updated since you read it', 'Not read yet', 'Not read yet']`. Opening "Moved job" gives `#kb-readline` `1 min read · Read 1 month ago`.
  - **K6, import.** Before load, set `vaultboard.kbReads` to `{"Personal/1. apps/01-long-read/article.md": <now - 2 days>}`. After load, the key is gone and `/api/kb` gives 01-long-read that exact `lastRead`.
- [ ] **Step 3:** Run `node scripts/kb-reading-e2e.js K1 K2 K6`. Expected: FAIL on readline, picks order and import.
- [ ] **Step 4: Implement in `app.js`.**
  - **Remove** `kbReadMap`, `markArticleRead` and every `vaultboard.kbReads` read except the import.
  - **Dashboard.** `recommendedArticles(arts)` orders `readState` `updated` (by `updated` desc), then `unread` (by `updated` desc), then `read` (by `lastRead` asc). Card meta comes from one `readLabel(a)`: `Updated since you read it` (class `kb-unread`), `Not read yet` (class `kb-unread`), or `readStaleness(a.lastRead)`. Unread counts `readState === 'unread'`.
  - **Reader.** Add `<p class="kb-readline" id="kb-readline">${a.minutes} min read · ${readLabel(a)}</p>` after `d-meta`, and `<div class="kb-read-end" aria-hidden="true"></div>` after `${a.html}`.
  - **Tracker.** One object `KBREAD = { path, needed, seconds, timer, observer, sent }`:
    - `startReadTracker(a)` runs from `openArticle` unless `keepScroll` is set and `KBREAD.path === a.path`.
    - A 1 s interval adds a second while `document.visibilityState === 'visible' && STATE.mode === 'kb' && STATE.kb.article === path`. `needed = Math.max(20, a.minutes * 30)`.
    - An `IntersectionObserver` (root null) on `.kb-read-end` ignores its first callback and counts a later `isIntersecting`.
    - `sendRead()` posts once and is skipped when `ME.localRead`. On success it updates the `STATE.kb.articles` entry and `#kb-readline` (to `N min read · Read today`).
    - `stopReadTracker()` clears both. It is called from `goToKBHome`, `setWorkspace`, and `setMode` when leaving `'kb'`.
  - **Import.** `importLocalReads()` runs in `start()` after `loadWorkspaces()` when `ME.authed && !ME.localRead`. It posts the parsed map and removes the key on success. A parse failure removes the key.
  - **Settings.** `ft-morning` loads from `d.settings.features.morningRead` and saves as `morningRead`. `ME` and `fetchMe` default `morningRead: false`.
  - **`index.html`.** Add a `su-row` switch `ft-morning` with hint `ft-morning-d`, between Today's time zone field and Terminal, and update the `ft-tz-hint` copy.
  - **`styles.css`.** `.kb-readline` uses `--ui-font`, `--muted`, 13px, `margin: 4px 0 18px`. `.kb-read-end` is `height: 1px`.
- [ ] **Step 5:** Run `node scripts/kb-reading-e2e.js K1 K2 K6`, then `--phone K1 K2`, then `--theme=sepia K2`. Expected: PASS. Look at the K2 screenshots in both themes.
- [ ] **Step 6:** Run `KT 'test/*.test.js'` (still green). Commit `public scripts` as "KB reader: reads count when read, server-backed dashboard, one-time import, Morning read switch".

### Task 7: The morning card

**Files:**
- Create: `public/kb-morning.js`
- Modify: `public/index.html` (the card markup before the scripts; `<script src="kb-morning.js">` after `today.js`), `public/styles.css` (a "Morning read" block), `public/app.js` (`start()`, end of `setWorkspace`), `scripts/kb-reading-e2e.js`

**Interfaces:**
- Consumes: the Task 5 API; the app.js globals listed in Task 6.
- Produces: `const KbMorning = { init(), check() }`, in the `today.js` IIFE style.
  - `init()` runs once from `start()` after `setMode(homeMode())`, only when `ME.features.morningRead`. It binds `visibilitychange` (when visible, `check()`) and runs `check()`.
  - `setWorkspace` ends with `if (window.KbMorning && ME.features.morningRead) KbMorning.check()`.
- Markup ids:
  - `km-scrim`
  - `km-card` (`role="dialog" aria-modal="true" aria-labelledby="km-title"`)
  - `km-eyebrow`, `km-title`, `km-excerpt`, `km-meta`, `km-reason`
  - `km-read` (`su-btn primary`), `km-later` (`su-btn`), `km-skip` (text button)
- Blocked (skip this check, the next one retries) when any of these hold: `sheetOpen()`, the drawer is not `.hidden`, `DGV`, `DOCV`, `#login` is not hidden, `document.activeElement?.closest('.xterm')`, or the card is already open.

- [ ] **Step 1: Write the failing e2e scenarios.** K3 and K4 run at all four of desktop/phone × dark/sepia.
  - **K3.** Load on personal. The card shows `Morning read · 1 min`, title `Short note`, `km-reason` `Updated since you read it`, and `km-meta` containing `Personal`. Its rect lies inside the viewport, and `document.activeElement.id === 'km-read'`. Take a screenshot. Click Not today: the card is hidden and `GET /api/kb/morning` → `card: null`. A new context, waited 3 s, shows no card.
  - **K4.** Make the pick with a signed-in `GET /api/kb/morning?ws=personal`. A context opening on `work` shows the card with `Short note` and `Personal`. Read now → `STATE.workspace === 'personal'`, `STATE.mode === 'kb'`, the reader's `h1` is `Short note`, and the card is hidden. **K4b:** reset, POST `later` through the API, then click Read now in a page that still shows the card. It still opens the article, with no toast.
  - **K5.** Skip this one → the card is hidden. `/opt/vault/kb-preview/vault/.vaultos/kb-reads.json` has `articles.personal['02-short-note'].skipUntil` within 60 s of `now + 90 days`.
  - **K7.** Open on `business` (nothing qualifies, so no card). Open Settings, then run `setWorkspace('personal')` in the page: no card while the sheet is open. Close the sheet and dispatch `visibilitychange`: the card shows. Escape → hidden, and the API says null.
- [ ] **Step 2:** Run `node scripts/kb-reading-e2e.js K3 K4 K5 K7`. Expected: FAIL (no `#km-card`).
- [ ] **Step 3: Implement `kb-morning.js`.**
  - Render with `textContent`. The eyebrow is `Morning read · ${minutes} min`. The meta is `${wsLabel} · ${collectionName}`. The reason maps `updated → 'Updated since you read it'`, `unread → 'Not read yet'`, `stale → readStaleness(lastRead)`.
  - Show: remember the focused element, unhide the scrim and card, focus `km-read`. Hide: restore that focus.
  - POSTs use `fetch` directly, so the status is visible: 401 → `showLogin()`; 409 → quiet; any other failure → `toast("Couldn't save that: " + msg)`, except Read now, which still navigates.
  - Read now: post `open`, then `if (card.ws !== STATE.workspace) setWorkspace(card.ws); setMode('kb'); openArticle(card.path)`.
  - Escape: `window.addEventListener('keydown', h, true)`, acting only while the card is open, with `e.stopPropagation()`. A scrim click is Not today.
- [ ] **Step 4: Add the styles.**
  - `.km-scrim`: like `.ss-scrim` at z-index 72.
  - `.km-card`: fixed and centred, z-index 73, `width: min(92vw, 480px)`, `--panel` background, `--line` border, `--radius-2xl`, `--shadow-3`, padding 22px 24px, `pop-in` animation.
  - Eyebrow like `.kb-eyebrow`. Title 20px, weight 600. Excerpt clamped to 3 lines in `--muted`. Reason `.kb-unread` for updated/unread, `--muted` for stale. `km-skip` a muted text button.
  - At `max-width: 700px`: a bottom sheet (`left/right/bottom: 0`, top corners rounded, `padding-bottom: env(safe-area-inset-bottom)`, full-width buttons with `min-height: 44px`).
  - `.km-card.hidden, .km-scrim.hidden { display: none; }`
- [ ] **Step 5:** Run all of these. Expected: PASS.
  - K3 K4 K5 K7 (desktop dark)
  - `--phone K3 K4 K7`
  - `--theme=sepia K3 K4`
  - `--phone --theme=sepia K3 K4`

  Look at every K3 and K4 screenshot. The card should be legible, inside the viewport and on tokens in both themes.
- [ ] **Step 6:** Run `KT 'test/*.test.js'`. Commit as "Morning read card: once a day, one article to pick back up".

### Task 8: Notes, full verification, release prep

**Files:**
- Modify: `CLAUDE.md` (new section "KB reading and the morning read", after "Export PDF…")

- [ ] **Step 1: Write the CLAUDE.md section.**
  - The rules table, from the spec.
  - Where things live: `lib/kb-reads.js`, `.vaultos/kb-reads.json`, `public/kb-morning.js`.
  - Keys are job folder names, so a move keeps history.
  - The local read path sees the card and writes nothing.
  - The observer's first report never counts.
  - A damaged file is never replaced.
  - The preview (`kb-preview`, :7693, `reset.sh`, `mint-cookie.js`) and the e2e command list.
- [ ] **Step 2:** Run `KT 'test/*.test.js'` and every e2e combination from Tasks 6 and 7. Expected: all PASS, with the counts recorded.
- [ ] **Step 3:** Commit as "CLAUDE.md: KB reading and the morning read".
- [ ] **Step 4:** Stop and ask Ben before releasing. The restart ends every open terminal. After his OK:
  - `git -C /opt/vault/board merge --ff-only kb-reading`
  - Check that `/opt/vault/docker-compose.yml` still mounts `public`, `server.js` and `lib`.
  - `docker restart vault-board`
  - Confirm with `diff <(curl -s http://localhost:7684/app.js) /opt/vault/board/public/app.js` (empty) and with `/api/kb?ws=personal` from 127.0.0.1 carrying `readState`.
  - Then `docker compose -f /opt/vault/kb-preview/compose.yml down` and remove the worktree.
  - Update the memory notes `vault-board-app` (MEMORY.md line) and `vaultos-security-audit-2026-10` (the manifest change is committed in `2fd80f9`).
