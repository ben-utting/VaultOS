# KB reading history and the morning read — design

2026-10-28. Ben wants to stay up to date with his own Knowledge Base: a prompt each morning, "you
haven't read this in a while, have a read", and read tracking he can trust.

## Why

The KB already tracks reads (`kbReadMap`/`markArticleRead` in `app.js`), checked on the live
board 2026-10-28: opening an article stamps it, the unread count drops and the article leaves
"Pick this up again". But:

- **History lives in localStorage.** Phone, laptop and work laptop each keep their own, clearing
  site data wipes it, and the server can't see it, so it can't choose a morning read.
- **Opening counts as reading.** A two-second peek counts the same as reading to the end, and
  so does pressing Refresh in the reader.
- **Reads are keyed by file path.** Moving or renaming a job folder resets its article to
  "Not read yet".
- **Nothing says an article changed after you read it.** For keeping up to date, that's the
  signal that matters most.

## Goals

1. Read history is kept on the server, shared by every browser, and survives folder moves.
2. A read counts when the article was actually read, not when it was opened.
3. The KB shows reading time, when you last read an article, and whether it changed since.
4. Once each morning, VaultOS pops up one article from the open workspace for you to read.

## Non-goals

- Phone push (Telegram, web push). In-app only, Ben's choice.
- One pool across workspaces. The pick comes from the open workspace, Ben's choice.
- Remembering the reading position, a "mark as unread" button, or reading stats.
- Changing the window or thresholds from the UI. They are constants in `lib/kb-reads.js`.

## Rules (the numbers in one place)

| Rule | Value |
|---|---|
| Morning window | 05:00 to 12:00 in `settings.today.timezone` (Europe/London on the box) |
| Cards per day | One per VaultOS, across every workspace and device |
| "Read in a while" | Last read 30 or more days ago |
| Skip this one | Left out of the morning read for 90 days |
| A read counts | The article's end scrolls into view, or it is on screen (tab visible) for half its reading time, never less than 20 seconds |
| Reading time | Words in the body ÷ 200, rounded, at least 1 minute |
| Updated since read | The article's `updated:` date is later than the date (in the time zone) it was last read |

## Components

### `lib/kb-reads.js`

The store plus pure functions. No new dependencies.

**File.** `.vaultos/kb-reads.json` in the vault, next to `settings.json`. Files mode and search
already skip dot-folders.

```json
{
  "version": 1,
  "articles": {
    "personal": {
      "38-cloudflare-access-public-hostnames": { "read": 1793194785119 },
      "11-npm-reverse-proxy-rebuild": { "read": 1790000000000, "skipUntil": 1800000000000 }
    }
  },
  "morning": { "date": "2026-10-29", "ws": "personal", "key": "57-vaultos-today-mode", "at": 1793260800000, "reason": "unread", "done": false }
}
```

**Keys.** Workspace key, then the article's job folder name (`basename(dirname(path))`), so a
move into `_done/` or to another area keeps the history. Two articles in one workspace with the
same folder name would share an entry. The folders are numbered, so this is not expected.

**Store.** `createReadStore(vaultDir)` → `{ get(), update(fn) }`. Loaded once, then held in
memory. Writes go through one promise queue and `atomicWrite`. A missing file is an empty store.
A file that won't parse is never replaced, the same rule as `settings.json`: reads see an empty
store, and every write fails with "`.vaultos/kb-reads.json` is damaged. Fix or delete it." in the
server log and the response.

**Pure functions** (each takes `now` and `tz` where it needs them, so tests pass a fixed clock):

- `articleKey(relPath)` → job folder name.
- `readingMinutes(body)` → the reading time rule. Fenced code blocks and HTML comments are left
  out of the word count.
- `readState(article, entry, tz)` → `'unread' | 'read' | 'updated'`.
- `inMorning(now, tz)` → whether the local hour is in the window.
- `morningPick(articles, entries, now, tz)` → `{ article, reason }` or `null`. Candidates are
  published articles (`status` absent or `published`) whose `skipUntil` has passed. In order:
  1. `updated`: updated since read, most recently updated first.
  2. `unread`: never read, newest `updated:` first (else `created:`).
  3. `stale`: last read 30 or more days ago, longest ago first.

  Anything else (read inside 30 days and unchanged since) is not a candidate. Ties break on title.
- `mergeImport(state, boards, map, now)` → new state. `map` is `{ path: ms }` from a browser's
  old localStorage. Each path goes to the board whose `dir` it starts with, keyed by folder name.
  Paths outside every board, non-numbers and timestamps later than `now` are dropped. Where both
  sides have a read, the newer one wins.

### `server.js`

- **Article meta.** `loadArticleRaw` adds `minutes`. `GET /api/kb` and `GET /api/kb/article`
  add `lastRead` (ms or `null`) and `readState` to each article from the store.
- **`POST /api/kb/read?ws=` `{ path }`.** Signed-in sessions only (`sessionAuthed`; the same-box
  read path gets 401, as with Today's writes). The path must pass the same checks as
  `GET /api/kb/article`, pulled out into one helper both routes use; otherwise 400. Stamps
  `read: now`, returns `{ lastRead, readState }`.
- **`POST /api/kb/reads/import` `{ reads }`.** Signed-in only. Runs `mergeImport`, returns
  `{ imported }`. 400 if `reads` isn't an object.
- **`GET /api/kb/morning?ws=`** → `{ card: null }` or
  `{ card: { ws, wsLabel, path, title, excerpt, collectionName, minutes, lastRead, reason } }`.
  1. `null` if `features.morningRead` is off or `inMorning` is false.
  2. If `morning.date` is today: `null` if `done`. Otherwise the stored pick, whatever workspace
     was asked for (so phone and laptop show the same card). If that article has gone, or has
     been read since it was picked, mark the day done and return `null`.
  3. No pick yet today: run `morningPick` on the asked-for workspace. `null` stores nothing, so
     opening a workspace that has articles later the same morning can still pick. A pick is
     stored as `{ date, ws, key, at, reason, done: false }` (found again by `key`, so a folder
     moved after the pick still resolves; "read since" means `read > at`), unless the request is
     on the same-box read path, which sees the card but writes nothing.
- **`POST /api/kb/morning` `{ action }`.** Signed-in only. `action` is `open`, `later` or `skip`,
  else 400. With no pending pick for today, 409 (already handled on another device; the client
  just closes the card). All three mark the day done. `skip` also sets the article's `skipUntil`
  to now + 90 days. `open` does not count as a read; the reader's rule does that.

### Settings

- `lib/settings.js`: `features.morningRead`, default `true`. The existing loop over default keys
  validates it, and a `settings.json` without it reads as on.
- `/api/settings/features` accepts `morningRead`. `/api/me` already passes `features` through.
- Settings → Features gets a third switch, **Morning read**: "Once each morning, one Knowledge
  Base article you haven't read in a while." The Time zone hint becomes "Today's days start at
  midnight here, and the morning read comes between 05:00 and 12:00."

### Frontend

**Reader (`app.js`).** `openArticle` starts a read tracker for the article, and `keepScroll`
refreshes leave a running tracker alone. Two triggers, whichever comes first:

- an `IntersectionObserver` on a `.kb-read-end` sentinel placed after the article body, before
  Related (viewport root, so it works for both the desktop `#kb-reader` scroller and the phone's
  window scroll). The observer's first report, made as observing starts, doesn't count: an
  article short enough to fit on one screen has its end in view at once, and the timer counts it
  instead, so a peek at a short article is still a peek;
- visible time: counted only while `document.visibilityState === 'visible'`, KB mode is on screen
  and this article is the open one, until it reaches `max(20, minutes × 30)` seconds.

One `POST /api/kb/read` per opening. Not sent on the same-box read path (`ME.localRead`). On
success the meta line updates and the article in `STATE.kb.articles` takes the new `lastRead` and
`readState`, so the dashboard is right without a reload. Opening another article or leaving KB
mode stops the tracker.

The reader's meta row gains a line: "4 min read · Read 1 month ago" (the existing
`readStaleness` wording), "4 min read · Not read yet", or "4 min read · Updated since you read
it". It changes to "4 min read · Read today" when the read lands.

**Dashboard.** `kbReadMap`, `markArticleRead` and the `vaultboard.kbReads` key go.
`recommendedArticles` sorts updated, then unread, then oldest read, the same order as
`morningPick` but without the 30-day floor. Card meta shows "Updated since you read it" (styled
like `.kb-unread`), "Not read yet", or `readStaleness(lastRead)`. The unread stat counts
`readState === 'unread'`.

**Import.** After `/api/me` says signed in (not `localRead`), if `vaultboard.kbReads` exists,
post it to `/api/kb/reads/import` and remove the key on 200. Each browser does this once.

**Morning card (`public/kb-morning.js`, loaded after `app.js`, using its globals the way
`today.js` does).**

- Checks `GET /api/kb/morning` on load once workspaces are known, on `visibilitychange` to
  visible, and after a workspace switch. Only when `ME.features.morningRead` is on.
- Not shown over another overlay (task drawer, doc or diagram viewer, Settings sheet, setup or
  login), and not while a terminal has focus. It waits for the next check instead.
- Layout: eyebrow "Morning read · 4 min", the title, the TL;DR excerpt (three lines at most), a
  meta line with workspace and collection, the reason ("Updated since you read it", "Not read
  yet", or the `readStaleness` wording such as "Read 1 month ago"), then **Read now** (primary), **Not today**, and
  **Skip this one** as a text button.
- A centred card over a scrim on desktop, a bottom sheet at ≤700px. Tokens only, checked in Dark
  and Sepia. The entrance animation follows the global reduced-motion override.
- Focus goes to Read now. Escape and a scrim click are Not today. Its Escape handler runs in the
  capture phase and is the only one that acts while the card is open, the same chain as `DGV` and
  `DOCV` in CLAUDE.md.
- **Read now** posts `open`, then switches workspace if the card's `ws` isn't the open one, goes
  to KB mode and calls `openArticle(path)`. It navigates even if the post fails. **Not today**
  posts `later`, **Skip this one** posts `skip`. Both close the card at once, and a failed post
  shows a toast.

## Testing

- **`test/kb-reads.test.js`** (`node --test`): `articleKey`, `readingMinutes`, `readState` around
  a date boundary in the time zone, `inMorning` at 04:59, 05:00, 11:59 and 12:00, `morningPick`
  order and exclusions (drafts, skipped, read inside 30 days, an updated-since article read
  yesterday), `mergeImport` (newer wins, unknown board, a future timestamp, a moved folder), and a
  damaged file that is never overwritten.
- **`test/server-kb-reads.test.js`**, on the `startServer` helper like `server-kb-search.test.js`:
  the new fields on `/api/kb`; `POST /api/kb/read` gives 401 without a session and 400 for a path
  outside the workspace or a non-article file; import; and the morning routes: the day's pick
  stored once, the same pick from another workspace, 409 after `later`, `skip` setting
  `skipUntil`, off when the feature is off. The tests don't fake the clock in the server. They set
  `today.timezone` to the `Etc/GMT±N` zone where the current hour falls inside (or outside) the
  window.
- **`scripts/kb-reading-e2e.js`** (puppeteer, as `today-e2e.js`) against a preview container
  `kb-preview` on `127.0.0.1:7693`, mounting the worktree's `server.js`, `lib/` and `public/`
  over a synthetic vault from a sandbox script (two workspaces, some articles with recent
  `updated:` dates), with its own config and a minted cookie. Never `:7684`. Scenarios:
  - K1, reader: a peek doesn't count; reaching the end counts; the visible-time trigger counts.
  - K2, dashboard: unread, read and "Updated since you read it" labels; picks order.
  - K3, card: shows in the window; Not today hides it in a second browser context too.
  - K4, Read now from another workspace switches workspace and opens the article.
  - K5, Skip this one: the card closes and the store holds `skipUntil`.
  - K6, import: localStorage history arrives on the server and the key is removed.

  K3 and K4 run on desktop and phone in Dark and Sepia, with screenshots to `/tmp/kb-shots/`.

## Building and release

- Work happens on branch `kb-reading` in a worktree at `/opt/vault/board-kb-reading`. The main
  tree's `public/`, `server.js` and `lib/` are bind-mounted into the live container, so edits
  there go live at once.
- Shipping is a merge to `main` plus `docker restart vault-board`. No rebuild: `package.json` and
  the Dockerfile don't change. Check `lib/` is in the `volumes:` block before trusting that. The
  restart ends every open terminal, so it happens only with Ben's OK.
- Rollback: revert the merge and restart. `.vaultos/kb-reads.json` can stay; the old code
  ignores it. The old code reads localStorage only, and browsers that already imported have
  removed theirs, so after a rollback the KB shows everything as unread again. The history is
  still in the server file for a later re-release.
- CLAUDE.md gets a "KB reading and the morning read" section listing the rules and these traps.
