# VaultOS (vault-board) — working notes for Claude

Kanban board + Knowledge Base web app over the vault's `task.md`/`article.md` files.
`server.js` (Express, scans workspace dirs live, no build step) + a single-page
frontend at `public/index.html` / `public/app.js` (no bundler — edits to `app.js`
are served as-is via `express.static`, no restart needed, **as long as
docker-compose.yml's `./board/public:/app/public:ro` bind mount is in place** —
without it the Dockerfile's `COPY public ./public` bakes the frontend into the
image and edits need `docker compose up -d --build board` to appear at all.
Confirm live edits reached the container with
`diff <(curl -s http://localhost:7684/app.js) public/app.js`). Runs on :7684.

**Deploying backend changes: restart, don't rebuild.** Since 2026-09-18
`server.js` is bind-mounted read-only (`./board/server.js:/app/server.js:ro`), so
an edit ships on `docker restart vault-board`. No `--build` needed.

**Still baked into the image. These need `docker compose up -d --build board`:**
`set-password.js`, `package.json`, `package-lock.json`, `Dockerfile`. The spreadsheet
feature changed the last three (`exceljs`/`jszip`, `COPY lib`), so the image is rebuilt
once when it ships; after that rebuild nothing baked in is stale. One edit to any of them
without a rebuild and the container silently keeps running the old copy, with
nothing to warn you. Check the list against the `volumes:` block before trusting it.
(`lib/` is mounted like `server.js`, so a `lib/` change restarts rather than
rebuilds. See "Spreadsheets in Files".)

`docker-compose.yml` and `Caddyfile` live in this repo since 2026-09-22. **Only the
Caddyfile is symlinked** (`/opt/vault/Caddyfile -> /opt/vault/board/Caddyfile`). The compose
file is *not*: `/opt/vault/docker-compose.yml`, the one `docker compose` reads, is a separate
regular file from the repo's `/opt/vault/board/docker-compose.yml`, and they are kept identical
by hand (edit both, then `diff` them). Keep both mode `0600` (git does not track that). The
spreadsheet feature's three `board` lines (the `lib` and `sheet-backups` mounts, `SHEET_BACKUP_DIR`)
are in the repo's copy; the live file gets them when the feature is deployed.
Workspaces (`?ws=` param, see `WORKSPACES` in `server.js`): personal, business, lancashire
(Work), sucden, health — each an independent tree, own Board + KB state client-side.

## Visually verify UI/design changes — don't just read the diff

For anything touching layout, styling, or interaction in `public/app.js` /
`public/styles.css` / `public/index.html`: **use the `claude-in-chrome` skill to
actually load the app in the browser, click through the change, and take
screenshots** — before making the change (to see the current behavior) and after
(to confirm the fix looks and behaves right), not just that the code compiles or
that a static read of the logic looks correct. This app has no automated test
suite and several bugs here have been pure state/timing issues invisible from
reading source alone (e.g. a mode switch that silently rendered stale/empty data).

### Fastest path: headless Chrome on this box, no login (since 2026-09-20)

The board grants an unauthenticated **read** to requests whose socket peer is
this host, so an agent here can photograph the live board directly. No second
container, no second password, no session cookie:

```sh
CHROME=/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome
"$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=1600,1000 --screenshot=/tmp/board.png \
  --virtual-time-budget=8000 "http://127.0.0.1:7684/"
```

`--no-sandbox` is required (running as root). `--virtual-time-budget` is
*virtual* time, not a wall-clock wait: Chrome fast-forwards timers and still
settles the `/api/tasks` fetch before shooting. Measured 2026-09-20 — a 300ms
budget produced the same fully-populated 95-task board as 8000ms. Keep a few
seconds anyway as headroom for a slow scan; don't assume a bigger number is
waiting longer in real time.

**Three traps, in the order they bite:**

1. **Use `127.0.0.1`, never `192.168.1.188` and never `vb.ctrlaltautomate.com`.**
   The read path trusts the *socket peer*, and only the host's loopback arrives
   as trusted (it reaches the container from the bridge gateway `172.18.0.1` —
   see the "Same-box read path" comment in `server.js`). The LAN address and the
   tunnel are deliberately untrusted, so those URLs photograph the login overlay.
2. **Reads only.** Anything that writes — a status change, a comment, ticking a
   checklist item — returns 401 from an unauthenticated local session. A
   screenshot of a *write* path needs a real session, which needs Ben's password;
   ask, or use `claude-in-chrome` against his browser. Don't report a write path
   as visually verified when the POST 401'd.
3. **There are no deep links.** `app.js` reads no URL params and no hash, so
   every fresh load opens on the default: Today mode, workspace Personal (the
   switcher is a single radio pick over every workspace; the old show/hide in
   `workspace-visibility.json` is no longer read by the UI). To reach a specific workspace, task or article
   you must click, which means a puppeteer script, not the one-shot
   `--screenshot` flag. Puppeteer is in the npx cache:
   `require('/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer')`.

### Interactive click-paths: `claude-in-chrome`

Still the right tool when the check is behavioural rather than visual, when a
write path is involved, or when Ben is watching. It drives *his* Chrome, not a
browser on this box.

1. Invoke `claude-in-chrome` skill first (required before any `mcp__claude-in-chrome__*` calls).
2. Navigate to the board and log in if prompted (his browser is not this host, so the local read path does not apply to it).
3. Reproduce the reported behavior (click through the same steps the user described) and screenshot it.
4. Make the code change.
5. Re-run the same click-path and screenshot again to confirm the fix, checking both light/dark theme if the change touches styling.
6. If the extension isn't connected in this session, say so plainly and fall back to code-level reasoning — don't claim visual verification that didn't happen.

## Subtasks fold into their parent (added 2026-09-22)

A batch fan-out puts 8-9 child cards on the board for one piece of work — 32 of
Personal's 121 cards were subtasks — which buries the standalone tasks between
them. The Columns popover (now headed **On the board**) has a **Subtasks**
checkbox above the column list; unticking it drops the children and leaves the
parent's chip to speak for them: dashed border, an eye-off after the count
(`8 subtasks · 3/8 done`), so "this card has work behind it, and it's hidden"
reads at a glance. Remembered per workspace under
`vaultboard.hideSubtasks.<ws>`, off by default.

Four things hold this together — don't undo them piecemeal:

1. **Checked means on the board**, matching every column box below it, hence the
   label "Subtasks" rather than "Hide subtasks". `STATE.hideSubtasks` stores the
   inverse; only `renderSubtaskToggle()`/the change handler flip it.
2. **Only children with a parent card collapse** (`isCollapsibleChild`). A
   parentless batch (ceph, bonus-drills — `parentOfBatch()` in server.js) has no
   other representation on the board, so hiding those deletes work from view
   instead of folding it away.
3. **A batch filter and a live search both override it** (`subtasksCollapsed()`).
   Clicking a parent chip is how you get the children back, and a search whose
   only matches were hidden would read as an empty, broken board.
4. **The cols badge counts hidden columns *plus* the toggle**, so a collapsed
   board never looks like a board that's simply short of cards, and `Show all`
   clears both — it's the badge's own reset.

`renderSubtaskToggle()` runs on every `render()`, not just while the popover is
open: the row's count comes off `STATE.tasks`, and the checkbox has to be right
the first time the popover opens after a reload.

## Known-fixed bug (for context, don't re-break this)
`setMode('board')` used to call `render()` unconditionally with no "has this
ever been loaded" guard, unlike KB mode which had `if (!STATE.kb.loaded) loadKB()`.
Combined with `setWorkspace()` wiping `STATE.tasks` on every workspace switch but
only refetching data for whichever mode was *currently active*, switching
workspace while in Knowledge Base mode left the Board silently empty until a
manual Refresh. Fixed by giving board state its own `STATE.loaded` flag with the
same lazy-load guard KB already had. Keep both branches symmetric if either mode
gains new lazy-loaded state in the future.

## Refresh keeps your place — don't add a repaint path without it

Every refresh repaints by replacing `innerHTML`, which collapses the scroller
for an instant and makes the browser clamp the offset to 0 — so a refresh used
to fling you back to the top of a long task, article or doc. `holdScroll(...els)`
(top of `app.js`) captures the offsets (element *and* window), and the function
it returns puts them back; call it again after `hydrateDiagrams()` resolves,
since diagrams land late and change the height. It no-ops if anything moved the
scroll in between, so a reader scrolling during the fetch isn't yanked back.

In place (keeps position): `d-refresh`, posting a comment, a status change that
reopens the drawer, `docv-refresh` and the doc's refresh-on-focus, and
`render()` / `renderKB()`. (`#refresh` is no longer in this list — see "Settings sheet".)
A new page (starts at the top): opening a *different* task/doc/article,
`goToKBHome()`, `setWorkspace()`. The last two reset scroll explicitly *because*
the renderers now preserve it — keep that pairing if you add a third.

Note `showTask`/`paintDoc` run their "start at the top" write while the panel is
still `.hidden` (no layout box, so the write does nothing); `openTask`/`openDoc`
redo it after removing the class. Don't "simplify" either one away.

## Refresh buttons show they were pressed

`withRefreshFeedback(btn, work)` in `app.js` wraps the two in-place Refresh controls
(`#d-refresh`, `#docv-refresh`): `[data-busy]` on the button turns
its icon one continuous **brand-gold** revolution while the work runs, then a
`.refresh-done` pulse settles it. Gold (`--brand`), not `--accent` — this is the
app answering you, not an interactive affordance.

The busy state is held for at least `SPIN_MS` (620ms, mirroring `--dur-spin` in
styles.css — change both together). A local rescan finishes in well under 100ms,
so without the floor the spin is two frames and reads as a dead button. A second
click mid-spin is swallowed rather than queueing a second rescan, and a failure
gets the toast with no success pulse.

Two things not to undo: the `@media (prefers-reduced-motion: reduce)` override
right below those rules — the file's global `animation-duration: 1ms !important`
would otherwise turn the *infinite* spin into a strobe — and the `void
btn.offsetWidth` reflow, which is what lets the pulse replay on back-to-back
refreshes. The doc viewer's refresh-on-focus stays deliberately silent; only
presses animate.

`#refresh` is an icon-only header button now, beside Terminal.

**The board refreshes itself (2026-09-30).** `pollBoard()` rescans `/api/tasks`
every 10s while Board mode is on screen, plus on focus/visibility. It repaints
only if the JSON differs (`BOARD_SIG`), skips mid-drag, and drops an answer if a
write (`WRITES`, bumped in `api()` for non-GET) or workspace switch happened while
it was in flight. If the open task's mtime changed, the drawer re-reads it too.

## The palette is gold, not blue — and it's all tokenised

`--accent` (interactive: links, focus ring, drag target, filled seg buttons like
the task view's side/centre/full) used to be `#5b9dff`. It is now gold —
`#e8c67e` dark, `#8a5a12` sepia — a *half-step brighter* than `--brand`
(`#d7b46a` / `#6b4b12`) rather than identical to it: `--brand` means "this is
VaultOS" (wordmark, app icon, active workspace/mode pill), `--accent` means "act
on me". Keep that gap; making them the same value makes every link look like the
logo. `--on-accent` went warm (`#1a1408`) to match `--on-brand`.

Blues left in deliberately: `--in-progress` and `--scheduled` are *status*
colours (gold there would collide with `--review`'s amber), and dark's
`--stack-*` chips. Everything else follows the token — the last hardcoded blue,
`.col-body.over`'s drag tint, is now `color-mix(... var(--accent) 8% ...)`.
If you're adding colour, take a token; don't type a hex.

The app icons (`public/icons/*.png`) are the gold "V" — recoloured from the blue
originals by projecting each pixel onto the old blue→tile axis and recomposing
with `--brand`, which preserves the antialiasing. There's no SVG source and no
image tooling on the box (no ImageMagick, no PIL); the recolour was a pure-stdlib
Python PNG round-trip. `theme-color` in index.html/manifest.json stays `--bg` on
purpose — it tints browser chrome to match the app, and app.js:162 swaps it with
the theme.

## needs-decision is magenta, not teal (changed 2026-09-18)

`--needs-decision` was `#14b8a6` teal, which sat **31° of hue from `--done`'s green with 5%
lightness between them** — at the 9px `.dot` the board draws, the two statuses read as the same
colour. Ben spotted it on the board, not in the code.

Now **`#c2649b` dusty rose (dark) / `#b0428a` (sepia)**. Magenta is the only hue family no other
status occupies: blue is in-progress, violet is scheduled, red is blocked, amber is review, green
is done, grey is backlog. Perceptual distance (CIE Lab ΔE) to `--done` went **46 → 120** in dark
and **29 → 88** in sepia. Sepia was the worse theme before the change — its teal was also only
ΔE 26 from `--backlog`.

**The first attempt shipped and was rejected, which is the useful part.** It was `#ee2ba6` — same
hue family, but 85% saturation — and Ben called it out on sight as neon against the warm gold
palette. Two lessons:

1. **Score against the *saturated* statuses only.** Grey `--backlog` (9% saturation) has no hue to
   confuse with a coloured dot, but including it in the minimum drags the score down and pushes the
   search toward louder and louder colours. That is exactly how the neon got picked. Re-scored
   without it, dusty rose's nearest saturated neighbour is `--blocked` at ΔE 56 versus the neon's
   58 — so dropping from 85% to 44% saturation cost essentially nothing.
2. **Constrain by hue family as well as ΔE.** The raw search happily suggested another *green* for
   sepia: perceptually distant, but two greens of different lightness still both read "green".

If you change any status colour, re-run the check rather than guessing, with both constraints.

**Pre-existing collisions this did not touch**, both worth knowing before adding UI:
`--review` amber is **3° of hue from `--brand`** gold, and in sepia `--backlog` / `--review` /
`--brand` are all within 1° of each other, separated only by lightness.

## Export PDF is rendered server-side (since 2026-09-23)

The KB reader's **Export PDF** used to be `window.print()`, which can't do a cover,
running header/footer or page numbers. It now downloads from
`GET /api/kb/article.pdf?path=&ws=`: server.js lays the article out as a
standalone document and prints it with the **Chromium baked into the image**
(`apk add chromium font-inter font-jetbrains-mono …` in the Dockerfile — the one
feature that needs the image, not just the bind mounts).

- Look lives in `public/pdf.css`, read on every export — tune it with no restart.
  `&format=html` on the same URL returns the HTML instead of the PDF for tuning.
- Layout: dark cover band (collection, title, dates, tickets), stack chips, the
  TL;DR blockquote lifted into a panel, a Contents list; then **every H2 on its
  own page**, numbered. "Page X of Y" + running header are `@page` margin boxes.
- Left out on purpose (the PDF goes to people outside the vault): the Related
  panel, any H2 matching `references|related|see also`, and wikilinks (→ label).
- Diagrams are inlined as SVG and screenshots as data: URIs, so Chromium never
  calls back to the server.
- **Traps:** every page has zero *side* margins and content pads itself
  (`--gutter`) — giving page 1 different side margins makes Chromium rescale it.
  `--disable-dev-shm-usage` is required (without it Chromium aborts in Docker's
  64MB /dev/shm). `TMPDIR` points at the per-render temp dir or Chromium leaves
  `org.chromium.*` dirs in /tmp forever.

## KB reading and the morning read (added 2026-10-28)

Read history lives on the server and counts real reads; once each morning a card offers one article
to pick back up. Spec: `docs/superpowers/specs/2026-10-28-kb-reading-design.md`. Code: `lib/kb-reads.js`
(rules + store), the "Knowledge Base API" and "The morning read" parts of `server.js`, the "Counting a
read" block in `app.js`, and `public/kb-morning.js` (the card).

| Rule | Value |
|---|---|
| Morning window | 05:00 to 12:00 in `settings.today.timezone` |
| Cards per day | One per VaultOS, across every workspace and device |
| Stale | Last read 30+ days ago |
| Skip this one | Out of the morning read for 90 days |
| A read counts | The end (`.kb-read-end`) scrolls into view, or `max(20, minutes × 30)` s on screen |
| Reading time | Body words ÷ 200, rounded, at least 1 (code fences and comments left out) |
| Updated since read | `updated:` later than the day (in the zone) of the last read |

- **The history is `.vaultos/kb-reads.json`**, per workspace, keyed by the **job folder name**, so a
  job moved into `_done/` keeps its reads. The day's pick is stored the same way (`morning.key`).
  The old per-browser `vaultboard.kbReads` localStorage map is sent to `/api/kb/reads/import` once
  per browser at startup, then removed.
- **A damaged file is never replaced.** Reads see empty history, writes 500 with
  "`.vaultos/kb-reads.json` is damaged. Fix or delete it.", and the morning card stays away.
  While damaged, the store re-reads the file on every use, so a fix (or deleting it) works at once,
  with no restart. A single entry whose `read` isn't a number just reads as unread (`readAt`).
- **The observer's first report never counts.** An article that fits on one screen has its end in
  view at once; the timer counts it, so a peek stays a peek. Leaving KB mode pauses the count, and
  `setMode` re-arms the end watch on the way back, so a return trip (or a phone scroll clamped to
  the article's bottom) isn't a read either.
- **The same-box read path** (`LOCAL_READ`, headless screenshots) sees the card and read states but
  writes nothing: no pick stored, no read sent.
- **The card never opens over another overlay** (drawer, `DGV`, `DOCV`, Settings, login, a focused
  terminal). That check is skipped; the next (`visibilitychange` to visible, a workspace switch)
  asks again. Its Escape handler sits on `window` in the capture phase, ahead of the
  document-level ones. A 409 on its POST means another device answered first: no toast.
- **Switch:** Settings → Features → Morning read (`features.morningRead`, default on).
- **Preview:** `kb-preview` on `127.0.0.1:7693`, files in `/opt/vault/kb-preview/`. `reset.sh`
  regenerates the synthetic vault (`scripts/kb-sandbox.js`) with Today's zone set to wherever it is
  08:00 now, so the window is always open; `mint-cookie.js` makes a session from its `data/config.json`.
  Server tests use the same trick (`test/helpers/zone.js`) instead of faking the clock.
- **E2E:** `node scripts/kb-reading-e2e.js [--phone] [--theme=sepia] K1 … K7`. K1 the read rule
  (takes ~45 s), K2 the dashboard, K3 the card + Not today, K4 Read now across workspaces (+K4b, a 409),
  K5 Skip, K6 the import, K7 waiting behind Settings + Escape. Screenshots to `/tmp/kb-shots/`.

## Connectors (added 2026-10-29)

Settings → Connectors signs in to a service once and adds it to every agent VaultOS can set up
(Claude Code and the Cursor CLI), so it works in every folder. Agents never see a password or token.
Spec: `docs/superpowers/specs/2026-10-29-connectors-design.md` (the last section lists what was
decided or changed during the build). Code: `lib/connectors.js` (catalogue, copy), `lib/connector-store.js`,
`lib/connector-oauth.js`, `lib/connector-relay.js`, `lib/connector-relayed.js` (GitHub and Microsoft Learn credentials), `lib/connector-agents.js` (config writers),
`lib/connector-azure.js`, `lib/connector-service.js` (the glue), the `/api/connectors/*` and `/mcp/:id`
parts of `server.js`, and `public/connectors.js` (the pane).

- **Sign-ins live in `~/.vaultos/connectors.json`** (version 1, file `0600`, folder `0700`): the relay
  key, each connector's tokens, and what VaultOS wrote into each agent. Never in the vault, never in
  logs or API responses (the relay key is absent from `GET /api/connectors` too). Azure's sign-in is
  `az`'s own, under `~/.azure`.
- **Atlassian is relayed.** Agents get an entry named `atlassian` pointing at
  `http://127.0.0.1:<port>/mcp/atlassian` with an `X-VaultOS-Key` header (`~/.claude.json` top-level
  `mcpServers`; `~/.cursor/mcp.json`). VaultOS adds the real credential and streams to
  `https://mcp.atlassian.com/v1/mcp`. Sign-in is OAuth 2.1 with dynamic client registration and PKCE,
  or an API token. Pending sign-ins live 10 minutes; the token refreshes 60 s before `expires_at`.
  `POST /api/connectors/atlassian/cancel` drops this session's pending sign-ins (the pane's Cancel).
- **GitHub and Microsoft Learn are relayed too** (spec `docs/superpowers/specs/2026-10-29-github-mslearn-connectors-design.md`),
  through the generic `lib/connector-relayed.js` and the same relay. GitHub takes a personal access token
  (`POST /api/connectors/github/token`, `{ token }`, trimmed, probed with `initialize` + `tools/list` first (`get_me` only reads the login, best-effort); a refused token
  is not saved and the old one stays) and goes to `https://api.githubcopilot.com/mcp/`. Microsoft Learn needs
  no sign-in (`POST /api/connectors/mslearn/enable`) and goes to `https://learn.microsoft.com/api/mcp`.
  A stored credential of `''` means "connected, no credential": the relay sends no `Authorization` header
  and it never reads as not connected. `POST /api/connectors/:id/token|enable|disconnect|test` work for any
  relayed connector. Entry names are `github` and `mslearn`; the token never reaches `view()`, logs or
  agent configs.
- **Azure is local.** An `azure` entry runs `azmcp server start`, read-only (`--read-only`) unless the
  person allows changes. That switch only governs Azure's own tools for agents: `az` is on PATH with one
  shared full-rights login, so an agent that can run shell commands can still use `az` (R21; the pane says
  so). The server is pinned (`@azure/mcp@4.0.0-beta.3`, the version whose `--read-only` was checked). Install is about 900 MB (`@azure/mcp` plus a venv with `azure-cli`): check
  `df -h /` first. Sign-in is `az login --use-device-code`; the device page is `login.microsoft.com/device`.
- **Relay rules.**
  - **Loopback only, key required.** Wrong or missing key, or a peer that isn't loopback: `403`,
    nothing forwarded, and the key header is never sent upstream. It runs before the JSON parser and is
    exempt from the Host check only under `/mcp/`.
  - **Never a `401` to an agent.** A 401 would start the agent's own OAuth flow, which can't finish.
    Every "not usable" answer is HTTP 200 or a 5xx, never 401.
  - **Messages, exactly:** `${label} isn't connected yet. Open Settings → Connectors in VaultOS to
    connect it.` and `${label} sign-in has run out. Open Settings → Connectors in VaultOS to sign in again.`
  - **R7, the placeholder tool.** With no usable sign-in the relay still answers `initialize`, lists
    one tool, `vaultos_sign_in`, whose description is the sentence, returns the sentence as an
    `isError` result when it's called, and answers every other method with JSON-RPC error `-32001`
    carrying the sentence. So the agent shows the person what to do instead of "failed to connect".
  - **Concurrent calls share one refresh** (`serialised`), and a stale access token is renewed once
    then retried.
  - **SSE passes through as it arrives**, and a hang-up from the agent aborts the upstream request.
- **Transient vs refused refresh (R16).** Only a refused refresh (a 400 or 401 from the token endpoint, not
  one that names a temporary fault, or a record with no refresh token once the access token has run out)
  marks the connector `needsSignIn` ("Sign in again", `attention: true`). A network error, a timeout (20 s),
  408, 429 or 5xx during refresh throws: the relay answers with an HTTP error, no sentence, and nothing is
  marked. A blip must not log anyone out. A failed refresh inside the last 60 s still serves the access
  token while it is valid. A renewal that worked and is still answered 401 does not lock the sign-in.
- **Credentials are kept out of agent configs, which is not isolation.** An agent with a shell runs as the
  same user and can read `~/.vaultos/connectors.json`. The relay keeps tokens out of the agent's config
  and context, nothing more.
- **VaultOS never overwrites an agent's own entry.** If the agent already has its own entry under the connector's name (`atlassian`, `github` or `mslearn`), or
  `~/.cursor/mcp.json` isn't valid JSON (or its `mcpServers` isn't an object), nothing is written to that
  agent, the file stays byte-for-byte, and the row says why ("Has its own entry").
- **Fake Atlassian:** `scripts/fake-mcp-oauth.js` (node:http only; OAuth with registration and PKCE,
  token and refresh, an SSE `tools/list`; modes `normal`, `expire`, `refuse-refresh`, `slow-sse`;
  env `CONNECTOR_UPSTREAM_ATLASSIAN` points the app at it; `CONNECTOR_UPSTREAM_GITHUB` does the same for
  GitHub, which accepts `Bearer svc-key` and has a `get_me` tool returning `alex-example`). Microsoft Learn
  has no fake: leave `CONNECTOR_UPSTREAM_MSLEARN` unset and the e2e hits the real service. `expire` keeps whatever access token is current dead
  until the mode goes back to `normal` (a refresh alone doesn't recover); the e2e's wrapper returns the fake
  to `normal` on the first refresh.
- **Preview:** `connectors-preview` on `127.0.0.1:7695`, files in `/opt/vault/connectors-preview/`
  (compose bind-mounts the worktree's `server.js`, `lib/`, `public/`, `scripts/` read-only, so edits are
  live after `docker restart connectors-preview`; the fake dies with a restart:
  `docker exec -d connectors-preview node /app/scripts/fake-mcp-oauth.js --port 5555`). Never test
  against :7684.
- **E2E:** `node scripts/connectors-e2e.js C1 C2 C3 C4 C5 C6 C7 C8`, in order. C1 installs Claude Code and the
  Cursor CLI into the preview's home if missing (about 1.5 minutes) and signs in through the fake; C2
  checks both agents' configs and `claude mcp list` / `agent mcp list` from `/vault` and `/tmp`; C3 an MCP
  call through the relay; C4 an expired access token (one refresh); C5 a refused refresh (the sentence,
  `attention: true`, the placeholder tool); C6 disconnect, other entries untouched. It restarts the fake
  with a small control port (:5556) and ends signed out. C7 saves a GitHub token against the fake
  (agent entries, `get_me` through the relay, disconnect); C8 turns Microsoft Learn on against the real
  service (needs internet), searches the docs through the relay, turns it off. Preview HOME is `/home/vaultos`.
- **Tests:** `node --test test/connector-*.test.js test/connectors-ui.test.js test/server-connectors.test.js`
  on the host; the full suite needs the image (terminal tests):
  `docker run --rm -v "$PWD":/src:ro --entrypoint bash vaultos:connectors -lc 'cp -a /src /tmp/w && cd /tmp/w && rm -rf node_modules && cp -a /app/node_modules . && npm test'`.

## Hardened after an outside audit (2026-10-28)

A security audit of a fork, run at `c792a11`, led to these. Each has a test; don't undo them.

- **A new password signs every other browser out.** `writePassword` always writes a fresh
  `sessionSecret` (setup passes `PENDING_SECRET`, the one its middleware already holds).
  `SESSION_KEYS` is the array cookie-session reads on every request, so `/api/settings/password`
  swaps `SESSION_KEYS[0]` in place, re-issues the caller's cookie with `req.session = { authed: true }`
  (setting `authed` again is no change, and no cookie would go out), and closes every open terminal
  socket. The ptys live on, and the caller's panes reconnect on the new cookie. `set-password.js`
  still takes effect at the next restart, and signs everyone out then.
- **Board/KB path guards follow symlinks.** `safeTaskPath`, `safeJobDocPath`, `safeScreenshotPath`,
  `safeDiagramPath` and the two article routes end in `realInWorkspace()`: where the path really
  leads must be inside the workspace, as `safeVaultPath` already required for Files. The vault's CIFS
  mount is `symlink=native`, so a symlink made on the NAS shows up here. There were none in the
  vault on 2026-10-28, and a symlink that stays inside the workspace still works.
- **The PDF page carries a CSP** (`default-src 'none'; style-src 'unsafe-inline'; img-src data:`).
  Chromium runs `--no-sandbox` with JavaScript on over a `file://` page, and `marked` passes an
  article's raw HTML through, so before this `<iframe src="file:///app/config.json">` in an article
  printed the session secret into the PDF. Anything the PDF shows must be inline or a data: URI,
  which the inlining above already guarantees; a real 8-page article with diagrams came out the
  same, byte for byte bar the timestamp.
- **Still open:** the app renders the same unsanitised HTML into `innerHTML` (`#d-body`,
  `#docv-body`), so `<img onerror=…>` in any vault markdown runs on the board's own origin. It
  needs a sanitiser or a page-wide CSP, and a browser pass over every mode.

## Workbench: Files mode + terminal dock (merged 2026-09-27, live on :7684)

A third mode, **Files**, next to Board and Knowledge Base: the whole vault as a lazy tree, a
**Changed recently** list (polled every 8s while the mode is on screen), VS Code-style tabs
(single click = italic preview tab, double click = keep), and Rendered | Source for `.md`.
A **terminal dock** (header `>_` button or Ctrl+`) runs a real shell in any mode; vault paths
printed in it are clickable and open as tabs. Code: `public/workbench.js` (Files + dock),
`public/term.js` (xterm + socket, shared with the pop-out `public/terminal.html`), and the
"Workbench" sections of `server.js`.

- **`safeVaultPath` is the Files guard, and it is structural, not an allowlist.** Files mode
  exists to read anything, so unlike `diagrams/`/`screenshots/`/sibling docs there's no parent
  folder rule. What it does enforce: inside `VAULT_DIR`, no `..`, no dot-segment anywhere
  (`.git`, `.stfolder`, `.obsidian`, `.claude`), no `node_modules`, and `realpath` still inside
  the vault (symlink escape). `/api/fs/raw` serves images only, with a `sandbox` CSP so an `.svg`
  opened directly can't run script on this origin.
- **The terminal never honours the same-box localRead path.** `/api/term` is a websocket upgrade
  handled outside Express: it runs `sessionMw` by hand and requires `session.authed`, and it
  requires `Origin` host == `Host`. The headless-Chrome screenshot trick above therefore gets a
  "sign in to use the terminal" note, by design. To test it locally, mint a `board_sess` cookie
  from `config.json`'s `sessionSecret` (Keygrip/sha1) and never store it.
- The terminal is **off unless `TERMINAL=1`**. A pty outlives its socket (keyed by a
  client id in localStorage `vaultboard.term.id`), so a reload or mode switch reattaches with
  scrollback; × in the dock kills it. Opening the same id elsewhere (Pop out) closes the old
  socket with code 4000 and the dock shows "in its own window". The pop-out sends clicked paths
  back over `BroadcastChannel('vaultos-workbench')`.
- **Detached terminals live as long as something runs in them (2026-10-01).** It used to be a flat
  5-minute grace, which killed Ben's overnight Claude sessions whenever the laptop slept or the
  browser closed; on wake the tab reconnected with the same id and silently got a fresh bash. Now
  `sweepTerms()` (every 60s) only reaps a detached shell sitting at a bare prompt for 24h
  (`TERM_IDLE_MS`); "busy" = node-pty's foreground `process` isn't the shell itself. At `TERM_MAX`
  the longest-idle detached shell is evicted to make room. `GET /api/term/list` (signed-in only, no
  localRead) lists every pty; termui.js shows the ones no window has open as dimmed "detached" rows
  in the sidebar, and a click reattaches them (Historical: until 2026-10-07 this was an "N detached"
  button in the bar). term.js keeps retrying a failed connect (6× backoff, not
  1×) and reconnects at once on `visibilitychange`/`online`, so waking a laptop doesn't strand a
  pane on "sign in". A container restart still ends every terminal.
- **Base image is `node:22-bookworm-slim`, not alpine**, because the `claude` binary mounted from
  the host is glibc-linked. `node-pty` compiles in a builder stage. Chromium comes from apt, so
  `CHROMIUM_PATH=/usr/bin/chromium` is set in the Dockerfile. uid 1000 is renamed `node` → `coder`.
- Live compose (`docker-compose.yml`, board service) carries what the terminal needs: `TERMINAL=1`,
  `HOME=/home/coder`, `init: true`, code-server's home volume at `/home/coder` (so `claude` in the
  terminal is already logged in, with the same skills), and the host `claude` binary read-only. It was
  developed on branch `workbench` against a preview container on :7690 (`docker-compose.preview.yml`,
  both since removed). For a throwaway preview again: separate compose project, own port,
  `SECURE_COOKIE=0`, live `config.json` mounted read-only.
- **Terminal rendering is tuned to match VS Code's (also xterm.js); don't drop these.** WebGL renderer
  (`@xterm/addon-webgl`; the DOM renderer leaves gaps in box-drawing/block glyphs, which is what made
  Claude Code's interface look "broken up"), Unicode 11 widths (`@xterm/addon-unicode11`; without it
  lines containing ✻ ⏺ ⎿ wrap one cell early), `lineHeight: 1`, 14px, VS Code's Dark+/Light+ ANSI
  palette, and a font stack of Cascadia → Consolas → Menlo → self-hosted JetBrains Mono (re-measured once
  the webfont loads). Keys: Ctrl+C copies when text is selected, Ctrl+V pastes, Shift+Enter sends ESC+CR
  (Claude Code's newline), Ctrl+` goes to the page.
- **Ctrl+A in Files selects the open file only** (not when focus is in an input or the terminal), and
  a `copy` handler rebuilds the text from the selected `.ln` spans, because block spans copy with
  unpredictable newlines. Verified byte-exact against the file source. There's also a **Copy file** button.
- **Several terminals, grouped into spaces, in the bottom dock (rewritten 2026-10-07; details in
  "Terminal spaces" below).** The workspace (sessions, spaces, split trees, dividers, keys) is
  `createTermWorkspace()` in **`public/termui.js`**. It's shared by the dock (`workbench.js`, store
  `vaultboard.term`, persists `vaultboard.term.sessions` so each id reattaches after a reload) and the
  pop-out window (`terminal.html`, store `vaultboard.termwin`, doesn't persist). termui.js and the other
  `term*.js` modules need only term.js, not app.js; keep it that way or the pop-out breaks.
  A space is the Board task a terminal is linked to, otherwise its folder. Inside a space you split
  right or down, drag the borders, zoom a pane or close it; the sidebar (or the dock's slim rail) is the
  switcher. The focused pane gets the `--accent` border. "Terminal here" always opens a *new* session, so
  a running agent never gets a `cd` typed into it. Keys: Ctrl+` dock, Ctrl+Shift+` new pane in the active
  space, Alt+1…9 the space numbered N (spaces with a pane here), Ctrl+Space prefix. Server cap
  `TERM_MAX = 12`. The header order is **Board · Files · Knowledge Base**. A full-page Terminals mode was tried and removed at Ben's request
  (2026-09-27); he wants terminals in the dock, not as a mode.
- **Historical (replaced 2026-10-07): the Tabs | Tile toggle, `.tw-tab*`, the "N detached" button.**
  Tile used Hyprland's *dwindle* layout (`dwindle()`, `TM.ratios`, `vaultboard.term.layout` and
  `.ratios`): each new pane halved the previous one's space along its longer side. Both storage keys
  are deleted on first load (migration below). Don't resurrect any of it.
- **Pop-out = one "VaultOS Terminals" window, a full workspace.** Pop out takes the **whole active space**
  *out of the dock* (`TW.popSpace(key)`: each pane goes via `remove(id, {kill:false})`, the ptys live on
  server-side) and gives it to the window named `vaultos-terminals`. `window.open('', name)` runs synchronously in the
  click so it isn't blocked as a pop-up, and it returns the existing window without reloading it. An open
  window takes the session via `w.twAdopt()`; a new one is pointed at `terminal.html?adopt=[…]`, which
  strips the param at once so a reload can't re-take it. **On `pagehide` (close *or* reload) the window hands
  every session back:** a BroadcastChannel `{returned}` for an open VaultOS, plus
  `vaultboard.term.returning` in localStorage for the next load. Nothing is killed by closing the window.
  **`.term-host { isolation: isolate }` keeps a pane's note clickable**: xterm's layers carry z-indexes up to
  11 and otherwise sat above the "Bring it back here" button.
- **Place a pane before its terminal opens** (`add()` calls `layout()` before `createTerminal`). A pane that opens
  full-size and then shrinks into its tile leaves an already-drawn TUI (Claude's status line) wrapped.
- **`init: true` in the compose file is load-bearing.** node as PID 1 doesn't reap orphans, so a `claude`
  still running when its terminal is closed turned into a zombie.
- **A server restart doesn't kill browser sessions quietly, it replaces them.** Open pages reconnect and
  get a *fresh* shell under the same id (the old pty died with the process), so a shell you didn't start
  may appear in `ps` straight after a restart. It's a browser that has the preview open, not a leak.
- **Dividers drag.** Each space's tree gives `TermTree.layout(root).splits`; `renderSplits()` draws one
  handle per split and `setRatio()` clamps the drag to 12–88%. Handles are rebuilt on every layout, so the
  drag uses window listeners, not pointer capture, and re-checks on every move that its node still exists
  (a hand-over can remove it mid-drag). For the same reason double-click-to-even is timed by hand (400ms,
  `W.lastSplitDown`): a real `dblclick` never lands, and `pointerdown`'s `e.detail` is always 0. Test it
  with two separate `mouse.click`s, not Puppeteer's `clickCount: 2`, which sends a single press.
- **Drawer header icons** `#d-files` (Show in Files) and `#d-agent` (Start agent / Go to agent; it replaced
  `#d-term` "Terminal here" on 2026-10-03) sit beside Refresh and
  share its square-button rules. They use the app's `[data-tip]` tooltip (CSS-only, `\n` for a second
  line, naming the real folder). It is hidden under `@media (hover: none)`, and headless Chrome reports
  `hover: none`, so a screenshot needs `[data-tip]::after{display:block !important}` injected to show it.
- **Show in Files → back to Board reopens the task.** `#d-files` stores `RETURN_TASK` (path, workspace,
  drawer scroll). The next click on `#mode-board` reopens it via `openTask()` and restores the scroll, once.
  It's skipped if the workspace changed in between.
- **No Claude-specific buttons.** "+ Claude" and "Start Claude" were removed at Ben's request (2026-09-27):
  the terminal is agent-neutral (claude, pi, anything). `createTerminal`/`create()` still accept `run` if a
  launcher is ever wanted again.

## Files: upload by drag-and-drop, download, right-click menu (added 2026-09-28)

Ben drags files from his desktop into a folder, the way he did in VS Code.
- **Drop targets** (`workbench.js`, "Upload"): a folder row → that folder; a file row → its
  folder; the open file's view → its folder; empty tree space → vault root. Hovering a closed
  folder for 700ms opens it. A dropped *folder* uploads with its sub-folders
  (`webkitGetAsEntry`); `.DS_Store`/`Thumbs.db`/dot-files are skipped.
- **`POST /api/fs/upload?dir=&name=[&overwrite=1]`**, raw body, one file per request (no
  multipart lib). `name` may contain `/` for folder drops; each new segment follows
  `safeVaultPath`'s rules, so an upload can't create `.git`/`.obsidian`/`.claude` paths. Existing
  file → 409 and the client asks (with "do the same for the rest"). Streams to a dot-named temp
  and renames. Cap 500 MB server-side, **but Cloudflare's tunnel caps request bodies at 100 MB**
  on vb.ctrlaltautomate.com. It's the only write in Files and needs a real login (localRead is GET-only).
- **`GET /api/fs/download?path=`** — any file, `Content-Disposition: attachment` + sandbox CSP.
  A Download button sits in the file bar; no folder (zip) download.
- **Right-click menu** (`.fx-menu`) on tree rows, Changed recently, tabs and the welcome list:
  Open / Download / Copy vault path / Upload files here… / Terminal here. Upload files here…
  is also the way to upload from a phone.

## Files: edit text, rename (added 2026-10-30)

**Edit.** `public/text-edit.js` (`TextEdit`, loaded before `workbench.js`): an Edit button on text files (.txt, .md,
.json…) and on a .csv's Source tab swaps the numbered read-only view for a plain `<textarea>`, with Save (Ctrl+S),
Cancel and Restore previous. A draft is kept per path, so a paste survives a tab switch; `workbench.js` asks
`TextEdit.isDirty/confirmDiscard/drop` at the same places it asks `SheetFiles`. Server: `POST /api/fs/text/save` and
`/api/fs/text/restore`, built on the sheet store (per-file lock, 409 when the file moved on, one previous version
shared with the grid's Restore). It refuses empty text and NUL bytes, caps at `FS_TEXT_MAX` (1 MB), and keeps a CRLF
file CRLF. `GET /api/fs/file` carries `backup` for text it can show. Tests: `test/text-save.test.js`.

**Rename.** Right-click → Rename… (or F2) in the tree, Changed recently and the tabs; inline box in the tree, a
prompt elsewhere. `POST /api/fs/rename` renames within the same folder only (no moves). It refuses names VaultOS reads
by name: `task.md`, `article.md`, `Board.md`, a `_tasks` folder and anything inside one, and each board's top-level
folder. Links to the old name in other notes are not rewritten (the toast says so). The previous-version backup moves
with the file. The client re-points tabs, cached files, views and open folders (`fxRenamed`), and refuses while a
tab under the path has unsaved edits. Tests: `test/fs-rename.test.js`.

## Spreadsheets in Files (added 2026-10-06)

`.csv` and `.xlsx` files open in Files as an Excel-style grid (they used to be raw text / "No
preview"), and Ben edits them there instead of download → Excel → upload. **The contract
(`SheetPayload`, `Sheet`, `CfRule`, `Op`, error codes) lives in the plan, "Shared data shapes":
`docs/superpowers/plans/2026-10-06-spreadsheet-editor.md`** (added after it was written: the request's
`saveId`, the payload's `lastWrite: { id }`, and the 200 `{ …, saved: true, reload: true }` fallback; the Sheet's
`locked` is in it). The design is
`docs/superpowers/specs/2026-10-06-spreadsheet-editor-design.md` (its last section lists what changed
while building). This section is the map and the traps; read the plan before touching either side of
the wire. Coordinates in JSON are 0-based, and `Op.sheet` is `Sheet.index`, the worksheet's position
including hidden sheets (hidden ones are left out of `sheets[]`, so it is not the tab position).

### What Ben gets

- The file's own look: frozen rows/columns, fills, fonts, borders, merges, widths, heights, hidden
  rows/columns, sheet tabs, dropdown lists (▾), formula cells' cached results, and a *subset* of
  conditional formatting (`cellIs` with literals, and `REF op LITERAL` expressions such as
  `$F3="Open"`; the rest is skipped, counted, and announced by a muted note). A CSV has Grid | Source.
- **The formula bar shows the whole active cell** (added 2026-10-28). Cells clip like Excel's, and a CSV
  column is capped at 420px, so a long note used to be unreadable: the bar was one line with `white-space: pre`.
  It now wraps (line breaks kept) and `fitBar()` grows it to fit, up to 6 lines (5 on a phone, its CSS
  `max-height`), then it scrolls inside; a short cell puts it back to one line (28px / 32px). The grid gives up
  that height: `fitBar` reveals the active cell, and the scroll box's ResizeObserver re-places the editor and
  list button. **After a press in the grid the bar holds its height** until presses stop for `BAR_HOLD_MS`
  (550ms, past Windows' 500ms double-click): growing between a double-click's two presses moved the grid, and
  the second press opened *another* cell's editor (C6 instead of C8 in E10; a phone double-tap missed). Keys
  and typing resize it at once.
- **Edit** → **Save (N)** / **Done** (Ctrl+S too). Typed text is coerced like Excel, in UK dates
  (`dd/mm/yyyy`); a text cell stays text. Paste (≤ 20,000 cells), undo/redo, insert/delete rows from
  a right-click on the row number. A new row copies the formatting of the row clicked (the op's `like`).
  Changed cells stay marked until saved; the tab carries an unsaved dot.
- **Restore previous version** ("Restore" on a phone). One backup per file; restoring swaps file and
  backup, so it is its own undo.
- **Conflict banner** when the file changes on disk under unsaved edits (Syncthing, an agent): Save
  answers 409, nothing is lost, and he picks "Reload and re-apply my N edits" or "Reload and discard".
- A view-only file shows a banner with the reason and **Download**. Formula cells, merged cells other
  than the top-left one, protected sheets, and an Excel table's header and totals rows are locked in the
  grid (typing there says why).

### Why our own grid, not Jspreadsheet CE

Researched before building, and it was rejected: it has **no frozen rows** (12 of Ben's files freeze
headers), it **wipes every merge** on a row insert/delete near one (19 files have merges), it only does
**whole-column dropdowns** (his list validation is a cell range), and its **undo fires no events**, so
changed-cell tracking and the unsaved state would have been guesswork. Don't swap it in.

### Modules

| File | Job |
|---|---|
| `public/sheet-core.js` | UMD (`window.SheetCore` / `require`), no DOM, no ExcelJS. A1 parsing, range shifting, `rebaseFormula`, client-side op application with changed-cell tracking (`changed`/`newRows` are **Sets**: never JSON round-trip the model), CF evaluation, list matching, `compactOps`. Shared by the browser and the server tests. `lib/*` requires it as `../public/sheet-core`, so `lib/` and `public/` stay siblings (they are in `/app`). |
| `lib/sheet-csv.js` | Byte-preserving CSV: decode (UTF-8 / BOM; UTF-16 and latin1 are view-only), delimiter sniff (`, ; tab \|`), record parse that keeps each untouched record's raw bytes, ops, serialise (quote style, CRLF/LF, BOM, trailing newline kept). |
| `lib/sheet-style.js` | Theme palette, theme/indexed/argb + tint → `#rrggbb`, cell style → CSS, CF dxf → CSS. |
| `lib/sheet-values.js` | Display text (number-format subset, UK dates), edit text, typed-input coercion (`007`, 16-digit ticket numbers, `1e5`, dates in date cells must never silently become other numbers). |
| `lib/sheet-xlsx.js` | ExcelJS: `loadWorkbook` (with the table-header fix), `toModel`, `anyDrawable`, `checkEditable` (the eligibility gate), `applyOps` (set + model-level row shift), `writeVerified`, `carryOverPackageParts`, `carryOverDefinedNames`, `prepareForWrite`, `cellSignature`. |
| `lib/sheet-store.js` | Guarded read, per-path lock, atomic replace with backup, restore, eligibility cache. |
| `server.js` | `fsKind` returns `'sheet'` for `.csv`/`.xlsx`; `GET /api/fs/sheet?path=`, `POST /api/fs/sheet/save`, `POST /api/fs/sheet/restore` (one marked "Spreadsheets in Files mode" block). One `buildSheetPayload` and one edit verdict (`sheetVerdict`) serve GET and save, so they can't disagree. |
| `public/sheet-grid.js` | `window.SheetGrid`: render (first screenful at once, then 2,500 cells a frame), selection, keyboard, editor, lists, clipboard, undo, row menu, tabs, formula bar. |
| `public/sheet-files.js` | `window.SheetFiles`: Files glue. One controller per path, the file-bar buttons, Save/Done/Restore, banners, save queue, conflict and refresh guard, dirty state. |
| `public/workbench.js`, `index.html`, `styles.css` | Hooks only: `fxKindOf`, `renderView` calling `SheetFiles.beforeViewChange / barHtml / mount`, the `#fx-bar` click and Ctrl+A forwards, `.unsaved` tab, `fxClose`→`confirmDiscard`/`drop`, `.fx-tools` wrapper for the phone bar. Script order: `sheet-core`, `sheet-grid`, `sheet-files`, after `app.js`, before `workbench.js`. Sheet tokens (`--sheet-*`) are in both themes; xlsx paper is white in both, colours read from the file are inline (the one allowed bare-colour exception). |

`server.js` loads `lib/*` lazily through `sheetLib()`, never at boot, so a missing mount or a missing
`exceljs` breaks only the three sheet routes (500) and the board still starts.

### Deploying it (these bite)

- **`lib/` is `COPY`'d into the image *and* bind-mounted** (`./board/lib:/app/lib:ro`), like `server.js`:
  a `lib/` edit ships on `docker restart vault-board`. **`exceljs` and `jszip` (package.json) need an image
  rebuild**: `cd /opt/vault && docker compose up -d --build board`. A restart or rebuild kills every VaultOS
  terminal, so look first: `docker exec vault-board ps -eo pid,etime,cmd`.
- **Backups live outside the vault**, so Syncthing never syncs them and Windows never shows them:
  host `/opt/vault/board/sheet-backups` mounted at `/app/sheet-backups`
  (`./board/sheet-backups:/app/sheet-backups`, env `SHEET_BACKUP_DIR=/app/sheet-backups`; with no env the
  default is `<app dir>/sheet-backups`). The host folder must be uid 1000's
  (`install -d -o 1000 -g 1000 /opt/vault/board/sheet-backups`) or every save is a 500. Layout:
  `<backup dir>/<vault path>`, one previous version per file. The `board` service needs the `sheet-backups`
  and `lib` volume lines and the env line in **both** compose files (see the top of this file); the repo's
  copy has them.
- npm audit: `uuid@8.3.2` comes from `exceljs@4.4.0` (the "fix" downgrades exceljs, so it was left);
  `proxy-addr` and `qs` come from express and were already there.

### Which workbooks are editable (`checkEditable`)

It loads a **fresh** copy of the file, writes it the way a save would (`prepareForWrite`, then
`carryOverPackageParts`), and compares source with output. Anything the save would lose makes the file
**view-only** with "Saving here would lose X — edit it in Excel". The verdict is computed on open and
before a save (cached by path + mtime + size, so the dry run repeats only when the file changed), and GET
and save share it. It refuses:

- **Lost content**: zip parts (charts, pivot tables, threaded comments, links to other workbooks, macros, slicers,
  timelines, form controls, anything else whose part count drops); drawing *anchors* (a text box or arrow
  inside a drawing that survives is "shapes or pictures"); **notes**
  (`<comment>` count), **page breaks** (`<brk>`: ExcelJS never loads them), **hidden or grouped rows**
  (ExcelJS skips a row with no cells and no height), **merged cells** (a one-cell merge counts: that is why
  `LIG Safeguard … v0.3.xlsx` stays view-only), **column widths**.
- **Validations**: a relative reference in any validation formula ("dropdowns that depend on other
  cells"); a non-list rule whose bounds aren't plain numbers or dates ("validation rules that refer to
  other cells"); and any rule ExcelJS rewrites or drops, e.g. x14 extension validations or `1E3` bounds
  ("validation rules"). These are judged from the **raw XML** (`rawValidations`) because ExcelJS has
  already mangled the parsed bounds.
- **Links to other places in the workbook**: a `<hyperlink location=…>` (to a cell, a sheet or a name)
  that the dry run doesn't write back. ExcelJS reads only links with a relationship (web and file links).
- **Excel extensions such as sparklines**: an `<ext uri=…>` in some part's `extLst` that the dry run's
  same part (a worksheet matched by sheet name) lacks. Seen: sparklines, and the x14 half of a data bar
  (ExcelJS drops it and leaves the rule's `x14:id` dangling). Ignored on purpose: the x14 validations ext
  (judged rule by rule above) and two `workbook.xml` settings Excel writes into almost every file and that
  carry nothing (`x15:workbookPr chartTrackingRefBase`, `xcalcf:calcFeatures`): with them refused,
  `linux.xlsx`, `Subnets.xlsx` and the action list's `.bak` would all be view-only.
- **Excel tables**: any table part whose name, ref, header/totals row counts or column names differ after
  the dry run.
- **Named ranges**: only if the carried-over `<definedNames>` (below) didn't come back as meant.
- **Unreadable**: ExcelJS can't load it, or it has no visible worksheet. Download only.
- Over the size cap (csv 5 MB, xlsx 3 MB): not opened at all (`tooLarge`). xlsx is lower because ExcelJS
  parses and dry-run writes on the event loop (a 10 MB workbook stalled every request, terminals included).
- No visible sheet the grid can draw (all over 60,000 cells): view-only, "too big to edit", and
  `checkEditable` isn't run at all (`anyDrawable`).

Harmless, ignored: `xl/printerSettings/*`, `customXml/*`, `docProps/app.xml`, `core.xml`, thumbnails.
**Carried over, not refused**: `docProps/custom.xml` and `docMetadata/*` are copied byte-for-byte into the
output with their relationship and content-type override (SharePoint `ContentTypeId`, and any sensitivity
label). The action list has a `custom.xml`, so without this it would be view-only.
**Defined names are carried over too** (`carryOverDefinedNames`, in the dry run and in every save): the
output's `<definedNames>` is replaced by the source's, each `<definedName>` with its attributes verbatim
(`localSheetId`, `hidden`, `comment`), its formula moved through the save's row ops on the sheet it names
(`rebaseFormula` with `definedName: true`: every row follows its target, `$` or not, whole rows too; a print
area or titles name drops an area a delete removes, and goes when none is left). A name that names no
shifted sheet keeps its bytes; with no names in the source, ExcelJS's own (print areas) stay. Then the
output is checked to hold exactly those names. The row ops come from `shiftRows` itself (a per-workbook
record), so `writeVerified(wb, srcBuf)` needs no op list. Every corpus file with a name (9, mostly hidden
`_xlnm._FilterDatabase`) used to get it rewritten by every save; now it comes back byte for byte.

Gates per sheet, separate from the file verdict: `readOnly` (protected sheet); `locked` (an Excel table's
header and totals rows: the grid explains, `applyOps` answers 400 "That cell is part of an Excel table
header — edit it in Excel", or "totals row"); `tooBig` (> 60,000
cells, `rowCount × colCount`: no cells sent, never editable, "Too large for the grid" + Download; a CSV
like that makes the whole file view-only); `rowOps` (row insert/delete refused, `set` still fine) when the
**workbook has any formula**, the sheet has an **Excel table** or **pictures**, or **another sheet's
dropdowns or colour rules point at this sheet**. CSV has no row-op restriction.

### ExcelJS traps (each one cost a probe)

- **Never use `spliceRows`/`insertRow`/`duplicateRow`.** Row ops shift the worksheet *model*
  (`shiftRows`): rows, cells, merges, validations, CF, autoFilter, print area and titles, defined names
  (ExcelJS's copy; the file gets the source's, see above), the freeze line. The model has three traps: the
  getter emits **`merges`** but the setter reads **`mergeCells`**; the setter doesn't reset `_merges`, so set **`ws._merges = {}`** first; and it **drops the
  style of merged non-master cells**, so every `type: Merge` cell model is rewritten as
  `{ address, type: Null, style }` before `ws.model = m`. (Skip that and the real action list's 42 merged
  non-master cells lose their borders.)
- **CF and validation formulas must be re-anchored when their range moves** (`$F3="Open"` → `$F4="Open"`):
  `rebaseFormula`. Relative row refs move by the anchor's shift, absolute refs follow their target. That equals
  Excel except when the anchor and the target sit on opposite sides of the insertion point (documented, not
  handled), and whole-row refs inside cell formulas (`SUM($3:$5)`) aren't shifted at all, which is why
  row ops are refused when the workbook has formulas.
- **`writeBuffer` mutates the workbook** (stamps CF `dxfId`/`ref`, assigns `priority`): take any baseline
  or snapshot first. `checkEditable` writes its own fresh copy for that reason.
- **Loaded cells with the same xf share one style object** (merged non-masters share the master's):
  never set `cell.font = …` in place. Assign a deep-cloned `cell.style`.
- **The validation optimiser sorts addresses as strings** (`F10` < `F3`) and ignores `marked` while growing,
  so a plain save wrote *overlapping* sqrefs (`F10:F15` beside `F3:F15`) on Ben's main file. `prepareForWrite`
  regroups each sheet's per-cell validations into non-overlapping rectangles and re-keys them (`F3:F15`),
  which ExcelJS writes verbatim. The action list goes 2 elements → 14: valid, same coverage. The corpus fails
  any file whose output overlaps.
- **ExcelJS parses `whole`/`decimal`/`date` bounds with `parseInt`/`parseFloat`**: `$B$1` becomes `NaN`,
  `1E3` becomes `1`. Hence the raw-XML check above.
- It never loads `stopIfTrue` (so `stop` is always false), never loads page breaks, drops a note on a
  value-less cell at load, drops `custom.xml`/`docMetadata`, treats a zip with no `workbook.xml` as 0 sheets
  (we throw `unreadable` for that), and its Date `isEqual` calls any two Dates equal.
- **Tables:** it sets `headerRow` only for `headerRowCount="1"`, but Excel leaves that attribute out (default
  1), so an Excel table would be written back as `headerRowCount="0"`. `loadWorkbook` reads the table parts
  and fixes `headerRow` (`fixTableHeaders`); any other loader skips that. Before the fix, a save of either
  table file in the corpus wrote its table headerless.
- **Defined names:** a dynamic name (`OFFSET(…)`) loads as a broken `'OFFSET(Data'!$A$2`, constants and
  whole columns vanish, scope and flags are dropped. Hence the carry-over.
- **Links and extensions:** `location=` hyperlinks are dropped at load; the worksheet's x14
  conditional-format ext (data bars) is dropped on a reload-and-write.

### Saving safely (server)

- **mtime guard**: the client sends the mtime it loaded; `readGuarded` takes the stat before and after the
  read and answers **409** when the file moved (> 1 ms). **Per-path lock** (`withLock`): save, restore *and the
  sheet GET* all queue on it, so a read can't see a half-finished save.
- **Atomic replace** (`store.replace`): temp files are dot-named (`.<name>.tmp-sheet-…`, Files never lists them),
  one in the file's own folder, one in the backup folder. It re-stats (mtime, size, inode) before writing and
  again **just before the two renames**, so a Syncthing write landing mid-save is a 409, not an overwrite.
  The backup is the exact bytes that were checked. **Never rename across mounts**: the backup temp is written
  inside the backup folder and the new file inside the vault folder, so neither rename can hit `EXDEV`.
- **Verify before replacing**: the output is re-read and compared (`writeVerified`); anything lost is **422** and
  the original is untouched. Errors with no `.status` become a generic 500 "Something went wrong, and the file
  wasn't changed" (raw fs messages carry absolute paths). If the write landed but the response couldn't be
  built, the answer is 200 `{ saved: true, reload: true }`, never "wasn't changed". XLSX sets
  `fullCalcOnLoad` only when the workbook has formulas.
- **Save identity**: the client names every save/restore with a random `saveId`; the server remembers the last
  `{ id, mtime }` per file (in memory, 200 files) and the payload carries `lastWrite: { id }` only while the
  file's mtime still matches. That is how a client whose answer was lost knows the write was *its own*.
- **Caps**: ≤ 200 row ops and ≤ 5,000 inserted rows per save (400 "save more often"; one row op costs
  ~34 ms on a 58k-cell sheet, so an unbounded list froze the server, terminals included); ≤ 50,000 ops;
  a cell ≤ 32,767 characters; the body ≤ the global `express.json({ limit: '2mb' })` (the client refuses over
  1.9 MB). Every body-parser error (too large 413, malformed JSON 400, unsupported charset or
  Content-Encoding 415, an aborted upload) answers JSON `{ error }` with its status, never Express's HTML
  stack page, even before login. "Too many changes for one save — save in smaller steps" is the 413 text on
  `/api/fs/sheet/*` only; elsewhere it is "That request is too large".
- POSTs need a real session (localRead is GET-only). Replaced files end up owned by uid 1000.

### Client save lifecycle (`sheet-files.js`)

- **Dirty = `changeCount() > 0 || hasDraft()`**. An open cell editor counts, and Save/Ctrl+S commit it first.
- Save: `mark = grid.checkpoint()` (undo can't pop groups at or below it: "Saving… undo is paused"), body =
  `{ path, mtime, saveId, ops: compactOps(ops) }`. **Always send `compactOps`**: coercion is stateful, so
  raw `[set 'abc', set '5']` on a number cell would save the text `"5"`. One save in flight (double Ctrl+S posts
  once). On 200: `later = opsSince(mark)`, load the fresh payload keeping the view, `replay(later)`
  (what was typed while saving) → `{ applied, skipped }`. A 200 with `reload` refetches. Non-200s release
  the mark and keep every edit.
- **No answer** (tunnel drop, phone asleep, the 120 s `AbortController` timeout) goes to `settle()`: GET the
  file. `lastWrite.id` is ours → landed. File unmoved since we sent → not saved, keep editing. **Anything
  else** (moved, unknown, server restarted and forgot ids) → keep every edit and show the conflict banner,
  worded "Your save may have gone through — the file changed and VaultOS can't tell whose change it is.
  Check the sheet before re-applying." (`ent.conflict === 'unknown'`; a real 409 keeps the usual text).
  There is no "looks like ours" guess: an earlier one silently dropped edits and said "Saved".
- **Nothing reloads under unsaved work.** The 8 s poll, `visibilitychange`, tab and mode switches all reach
  `renderView` → `SheetFiles.mount`; if the disk moved while dirty/saving it raises the conflict banner and
  doesn't reload. `beforeViewChange(nextPath)` suspends a grid only when the view moves to a *different*
  file; a suspended grid keeps an open draft. Grids live per path and survive tab switches; closing a tab asks
  (`confirmDiscard`) then `drop`s it; `beforeunload` asks while anything is dirty; a dirty preview tab is
  pinned, never replaced. Tab marks: unsaved = a filled dot in the × slot (`--text`); changed on disk =
  a `--brand` ring after the name.

### Testing

Everything below runs from the repo root. `node_modules` is gitignored: for a fresh checkout
`docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim npm ci --ignore-scripts` (the e2e reads saved
files back with that ExcelJS on the host).

```sh
# unit: 399 tests. Workbooks are generated with ExcelJS (test/fixtures.js, raw XML injected with JSZip);
# no vault content is committed.
docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim node --test 'test/*.test.js'
# corpus: every csv/xlsx under the REAL vault, mounted read-only. Output is paths, verdicts and counts only,
# never cell contents. Keep it that way: it is safe to run over private files.
docker run --rm -v "$PWD":/app -v /opt/vault/vault:/vault:ro -w /app node:22-bookworm-slim \
  node scripts/sheet-corpus.js /vault [--ops-smoke]
scripts/sheet-smoke.sh                      # HTTP smoke on the preview (135 checks)
node scripts/sheet-e2e.js E1 E2 … E10       # browser scenarios on the preview (host puppeteer + Chrome, paths at the top)
node scripts/sheet-e2e.js --matrix E1 … E10 # every scenario in desktop/phone × dark/sepia (~30 min)
```

- **Corpus** (2026-10-07, real vault): xlsx 27 editable / 3 view-only (PersonalEmailTrace: column widths;
  `LIG Safeguard … v0.3`: one-cell merges; `LIG Firewall Rule Form v01`: threaded comments) / 3 unreadable
  (both RVTools exports, `AllVMSubnets-20260709`); csv 39 editable, 0 equivalence failures (one xlsx and two
  csv sit under a dot-folder Files can't open, so the walk skips them). Every editable file survives a save that
  changes nothing (`cellSignature` equal, no part lost, no overlapping validation ranges). `--ops-smoke`
  inserts a row, types, deletes it and demands the same signature: 23 ok / 4 skipped (tables or formulas) /
  0 failed. Exit 1 on any failure. The names, links, extensions and tables gates changed no verdict there;
  without the two ignored `workbook.xml` extensions and the table-header fix, five editable files would
  have gone view-only.
- **E1–E10**: viewing; editing; save lifecycle; refresh safety; conflicts; tabs and close; restore; CSV round
  trip, banners and phone saves; a regression sweep over the rest of Files (.md, text, image, upload,
  right-click menu, terminal dock, Board/KB); long text in the formula bar (E10 writes its own invented
  `Long notes.csv` after the reset; its double-click aims at a fixed point, as a person's pointer stays put). Last full matrix 901/901, 0 page errors; last desktop run 260/260. The e2e resets the
  preview vault before each scenario, mints its own cookie, and writes screenshots to `/tmp/sheet-shots/`.
  Look at them. Several real bugs (a clipped banner button, a doubled heading) were visible only there.

**The preview** (a separate container, so the live board and the real vault are untouched). It lived in
`/opt/vault/sheet-preview/` during development and is deleted after a release, so recreate it like this.
**Since portable mode (2026-10-28 rebuild) the recipe below needs four changes**, or the server sits in setup
and every call is a 409: use `image: vault-board:latest` (no build) with `DATA_DIR=/data`, `./data:/data` and
`data/config.json` from `lib/password`'s `writePassword` (mint-cookie reads it there); put a
`.vaultos/settings.json` (`setupDone: true`, one `Personal` board with `_tasks/Board.md`, `features.terminal:
true` or E9's terminal checks fail) into `pristine/`; run `sheet-sandbox.js` *inside* the image
(`-e NODE_PATH=/app/node_modules`), since the host's `node_modules` has no `exceljs`; and give the checkout a real
`node_modules` (`npm ci --ignore-scripts` in `node:22-bookworm-slim`, as below), or E3/E7/E8's read-backs fail:

- `compose.yml` (mode 0600): project `vault-sheet-preview`, `build:` the checkout, `image: vault-sheet-preview:dev`,
  container `vault-sheet-preview`, `user: "1000:1000"`, `init: true`, ports `127.0.0.1:7690:8080`, env
  `VAULT_DIR=/vault PORT=8080 SECURE_COOKIE=0 SHEET_BACKUP_DIR=/app/sheet-backups` (no `TERMINAL`). Volumes:
  `./vault:/vault`, `./config.json:/app/config.json:ro`, `./lockout.json:/app/lockout.json`, the live
  `workspace-visibility.json` read-only, the checkout's `public/`, `server.js` and `lib/` read-only over `/app/…`,
  and `./backups:/app/sheet-backups`. So edits to `public/` show at once, `server.js`/`lib/` after
  `docker restart vault-sheet-preview`, and `package.json` after `docker compose -f … up -d --build`.
- **Fresh config, never the live one**: `config.json` = `{ salt, passwordHash, sessionSecret }` made as
  `set-password.js` does, from a random throwaway password nobody keeps (scrypt, 16-byte salt, 64-byte hash)
  and its own random `sessionSecret`; `lockout.json` = `{"attempts":0,"lockedUntil":0,"lockLevel":0}`; both
  mode 0600, uid 1000. Because the secret differs, a preview cookie is worthless on :7684.
- `mint-cookie.js` prints the `Cookie:` header (`board_sess=<base64 {"authed":true}>; board_sess.sig=<base64url
  HMAC-SHA1(sessionSecret, "board_sess=<value>")>`, cookie-session/Keygrip as in the Workbench note above). It is
  never written to disk; smoke and e2e call it (or take `$SHEET_COOKIE`).
- **The vault is synthetic.** `node scripts/sheet-sandbox.js <out>` writes `<out>/Sandbox/` (13 files, invented
  content, byte-identical on every run): look-alikes of the action list, a sign-off pack (4 frozen rows, hidden
  Lists sheet), `linux.xlsx` (frozen column), a formulas export, a view-only `Chart Pack.xlsx`, an unreadable
  `RVTools_export_all.xlsx`, four CSV dialects, plus `.md`/`.ps1`/`.png` for E9. `reset.sh` regenerates it
  into `pristine/` when missing, then `rsync -a --delete pristine/ vault/`, clears `backups/`, `chown -R 1000:1000`.
  **Real vault files are never copied into the preview** (Ben's decision, 2026-10-06: invented files
  only). Real files are covered only by the read-only corpus.

### Known limits

- As of 2026-10-06 nothing VaultOS wrote has been opened in real Excel (headless checks only). After the first
  real save, open that file in Excel once: the overlapping-validation bug is fixed, but "Excel takes what
  ExcelJS wrote without a repair prompt" is not proven. iOS and screen readers are untested too.
- No formula editing, formatting controls, column ops or sheet add/rename (step two). Formula cells are locked.
- Row ops are refused (per sheet, with a reason toast) when the workbook has formulas, or the sheet has a
  table or pictures, or another sheet's dropdowns/colour rules reference it. Cell edits still work there.
- Phone row numbers: in edit mode the *selected* rows' numbers grow into a ≥ 32 px band; the others keep
  their 20 px row height (adjacent 20 px rows can't each be 32 px). A tap close to the selection's edge goes
  to the selected row; tapping a non-selected row number is a small target on a phone.
- A save drops Excel's ignored-error marks (`ignoredErrors`): a green "number stored as text" triangle that
  was dismissed in Excel comes back. Cosmetic, accepted.
- An Excel table's header and totals rows can't be edited here (the table part keeps the names too).
- Percent cells edit as `0.125` and typing `12%` stays text; `[h]:mm` durations over 24 h display as time of
  day; CF `stopIfTrue` is ignored; a CSV that isn't UTF-8 is view-only; grids draw ≤ 60,000 cells a sheet.
- After a server restart, a save whose answer was lost shows the conflict banner (safe). Re-applying could
  repeat a row insert that did land, but the reloaded sheet is shown first.

## Mobile (≤700px) and where terminals open (added 2026-09-28)

Phone-only rules live in the "Responsive" block of `styles.css` (sections headed
"Mobile: …"); a desktop window never sees them. Verify at 390×844 with puppeteer
(`isMobile: true, hasTouch: true`), not by shrinking a desktop window — the key
row keys off `(pointer: coarse)`.

- **Bottom tab bar** (`#mobile-nav`): Today · Board · Files · KB · Terminal (five buttons). Each button
  `.click()`s its header twin (`#mode-*`, `#termbtn`), so every listener on those
  still runs exactly once; active state is mirrored back by MutationObservers in
  app.js. The header drops to one row (search + ⚙ Settings). `--mnav-h` is the bar's
  height (safe-area included); on a phone `--dock-space` *is* `--mnav-h`, which
  is how Files/KB/drawer heights stop at the bar without their own rules.
- **Board columns scroll on their own** on a phone: `#board-view` is exactly
  viewport − header − bar, and each `.col-body` is the scroller. This is the fix
  for "scroll deep in Backlog, swipe, land on an empty screen". `render()` holds
  each column's `scrollTop` by status across a repaint (`colTops`), next to the
  existing `holdScroll($('board'))`.
- **Terminal on a phone** is a full-screen sheet sized off `--vvh`/`--vvtop`
  (window.visualViewport, workbench.js), so it shrinks above the on-screen
  keyboard; `body.vkb-open` hides the tab bar while the keyboard is up. A tap
  focuses xterm inside the gesture (termui.js) — the only focus iOS/Android
  raise the keyboard for. The `.tw-keys` row sends Esc/Tab/arrows/⇧⏎ via
  `handle.type()`; Ctrl is sticky and rewrites the next typed char through
  `handle.onNextInput()` (term.js). Buttons `preventDefault` on pointerdown so
  tapping them never blurs the terminal.
- **Phone terminal chrome is the spaces rewrite's phone mode (2026-10-07).** At ≤700px there is no
  sidebar, rail or visible split: the top bar is a summary (`mark space · pane`) plus a `≡ N` button
  (rollup over all terminals), and tapping either opens the Go-to picker as a full-screen sheet (44px
  rows, a New terminal button). Only the focused pane shows; every other pane is drawn at the same full
  size with `visibility:hidden`, so a switch never refits a terminal or its pty (until the final review a
  hidden sibling kept its split-tree size, about 22 columns after a split). The tree is kept, just not
  drawn. No prefix keys (`installTermKeys` returns early on a phone). The key row, compose box, tap-to-focus and touch scroll
  above are unchanged. Toasts sit at the top, below the safe area. Details under "Terminal spaces".
- **`claude` key + compose box (2026-09-29).** The key row has a `claude` key
  (types `claude⏎`) and a mic key that toggles `.tw-compose`: a real textarea
  with Insert / Send ⏎. It exists because phone dictation typed straight into
  xterm comes out garbled (the voice keyboard keeps revising its guess via
  composition events and xterm forwards every revision). Send writes the text
  and the `\r` as *separate* writes 60ms apart — in one chunk Claude Code treats
  text+CR as a paste and inserts a newline instead of submitting.
- **Touch scrolling is ours (2026-10-05).** xterm 6 replaced the native
  `.xterm-viewport` scroller with VS Code's scrollable, which didn't follow a
  finger on Ben's phone — a swipe moved the page, not the scrollback. term.js
  owns one-finger drags (capture-phase touchmove, `preventDefault`): normal
  buffer → `term.scrollLines`, alternate buffer / mouse-tracking apps → a
  synthetic `wheel` on `.xterm-screen`, plus a decaying flick. CSS sets
  `touch-action: none` on `.term-host .xterm`. Don't stop `touchend`: xterm's
  Gesture listens on `document` and needs it to reset. Verified with puppeteer
  `Input.dispatchTouchEvent` on a file:// page that loads the real term.js.
- **Terminals open in a window by default** (desktop). Reading settings →
  "Terminals open in: Window | Dock", stored as `vaultboard.term.where`. Window
  mode routes `termOpen()` (Terminal here, Files' terminal, the header button)
  to the one "VaultOS Terminals" pop-out via `openTermWindow()`/`handToWindow()`;
  a blocked pop-up falls back to the dock. Closing that window still hands its
  sessions back to the dock, and the header button shows the dock while it holds
  sessions. A phone always uses the dock. Window mode also checks the 12-terminal cap
  (`TW.canOpen()`) whenever a new shell would start in the window, since the window adds without
  checking: before it mints an id (a cwd or run), and when no window is open yet (a fresh one starts a
  shell). `termOpen()` with no args and the window already open (presence says it holds a terminal) just
  raises it, at the cap too.

## Settings sheet replaced the header popovers (2026-09-29)

Ben found the Workspaces / Filter / Columns / Reading-settings popovers opening
*on top of each other*, and wanted a lighter header. The desktop header is now
just: count of open tasks, **↻ Refresh**, Terminal, **⚙ Settings**, Sign out
(phone: search + ↻ + ⚙). Refresh moved back out of the sheet into the header on
2026-09-30. Ben uses it constantly. `#setsheet` is a modal with one section per old popover (Workspace, Filter by
folder, Columns, Appearance) plus a footer with Sign out.
The sections kept the popovers' element ids (`filter-list`, `cols-list`,
`ws-list`, `segTheme`…), so their render functions are unchanged; the old
`$('xpop').classList.contains('open')` gates became `secOpen('folders'|'cols'|'ws')`.
Folders is hidden in Files mode and Columns off the Board (`secAvailable`); the
gear gets a dot (`updateSetDot`) whenever the folder filter or columns are hiding cards.
Escape is handled on `window` capture, so it closes only the sheet.

**Refresh app = `location.reload()`, deliberately.** An iOS home-screen web app
resumes the old page forever, so a data-only rescan never picked up new
VaultOS code. Mode + open KB article ride across the reload in
`sessionStorage['vaultboard.reloadState']` (`restoreAfterReload()` at startup).
Server-side terminals survive a reload.


**Files has its own refresh (2026-09-29).** With `#refresh` now a full app reload,
Files mode got `#fx-refresh` (↻ beside collapse-all on the Vault tree header) →
`fxRefresh()`: rescans every open folder, Changed recently, and the open file.
Files mode also runs `fxRefresh()` quietly on `visibilitychange` → visible, so
files an agent wrote while you were away are there when you come back.

**Task-drawer comment box removed (2026-09-29).** Ben never used it. The
composer (`.comment-box`, `#c-input`, `#c-send`, `postComment()`) is gone from
the frontend. `POST /api/task/comment` in server.js is left in place but unused,
and existing `## Comments` sections in task.md still render as ordinary body text.

**Phone status strip removed (2026-09-29).** The pill row above the board on a
phone (`#board-tabs`, `renderBoardTabs()`) highlighted the column in view but
never scrolled itself, so the active pill slid off-screen. Ben asked for it gone
rather than fixed; each column's own header already names it and counts it.

**Diagram viewer: pinch-zoom on touch (2026-09-29).** The stage used to track a
single pointer, so a second finger just restarted the drag. `DGV_PTRS` now holds
every active pointer: two = pinch (zoom about the fingers' midpoint and pan with
it, `DGV_PINCH`), one = pan, lifting one finger of a pinch continues as a pan.
Tested with CDP `Input.dispatchTouchEvent` at 390×844 (100% → 433%, then pan).

**Diagrams must be literal and light-only.** Two vault diagrams rendered dark:
one had `@media (prefers-color-scheme: dark)` in its SVG `<style>` (turns dark on
a phone in dark mode), the other used `var(--paper)` etc. inside the `<svg>` —
the page's `:root` isn't extracted, so those resolved to *VaultOS's* dark tokens.
Both fixed in place (2026-09-29). All 46 now paint #f5f5f5 paper with no dark block.

## Settings → Skills (added 2026-10-01)
Ben wanted one place to remind himself what skills Claude has in a VaultOS terminal. `GET /api/skills`
reads them live from disk (`skillMeta()` parses SKILL.md / command frontmatter, incl. `>-` block
descriptions): **vault** = `/vault/.claude/commands` + `/vault/.claude/skills`, **mine** =
`$HOME/.claude/skills/*`, **synced** = `$HOME/.claude/skills/synced/<org>/*` (claude.ai), **plugin**
= each `installPath` in `plugins/installed_plugins.json`. HOME is the code-server home volume, same
as the terminal's `claude`. Claude Code's built-ins aren't files, so `BUILTIN_SKILLS` in `app.js` is
a hand-kept list; update it when a release adds/drops one. Clicking a `/name` copies it.

## Agent badges + Start agent (added 2026-10-03, idea from herdr)

Every Workbench terminal shows Claude's state as a mark (since 2026-10-07 on its pane strip, its
agents-list row and its space's rollup; it used to be a tab dot): **working** `◐` (`--in-progress`),
**blocked** `×` (`--review`: a permission or question is waiting), **done** `✓` (`--done`: finished, not
looked at yet), **idle** `○` and none `·` (`--muted-2`). The marks are static, with no pulsing and no
Dots/Symbols setting. "done" turns into "idle" when that pane is focused, the page is visible *and* the
window has focus. The header terminal count badge turns amber (pulsing) when anything is blocked and green
when anything is done.

**How state gets here.** These are Claude Code hooks, not screen scraping.
- `attachTerm` puts `VAULTOS_TERM_ID`, `VAULTOS_TERM_TOKEN` (random per shell) and
  `VAULTOS_HOOK_URL` in the shell's environment.
- `/home/coder/.claude/settings.json` (the shared code-server home) runs
  `~/.claude/hooks/vaultos-state.js` on SessionStart, UserPromptSubmit,
  Pre/PostToolUse, PermissionRequest, Notification, Stop and SessionEnd. The hook
  is guarded by `[ -n "$VAULTOS_TERM_ID" ]`, so Claude anywhere else does nothing.
- The hook POSTs to `/api/term/agent`. That route sits **ahead of the session
  gate** on purpose: its auth is the per-terminal token plus a loopback peer.
- **The source is `board/hooks/vaultos-state.js`.** After editing it, reinstall:
  `docker exec -u 1000 -i vault-board sh -c 'cat > ~/.claude/hooks/vaultos-state.js' < board/hooks/vaultos-state.js`

**Fallbacks** are in `sweepAgents` (every 5s). They cover what the hooks can't see:
- Esc mid-turn fires no Stop hook, so working plus 20s of silence becomes idle.
- Esc on a question fires nothing, so blocked plus a keypress plus 8s of silence
  becomes idle.
- Claude exiting puts the shell back in the foreground, so the state clears.
All three were verified with real Claude on 2026-10-03.

**Start agent.** The robot button in the task drawer (`d-agent`) calls
`termOpen({cwd, task, run: AGENT_KICKOFF})`.
- **The kickoff is a check-in, not "do the work" (Ben, 2026-10-05).** He keeps
  tasks on the Board and opens the agent to hear where a task stands and what's
  next today; Claude briefs and then waits for his go before touching files.
  Keep `!` out of the prompt (it's typed into interactive bash).
- The `task` parameter links the shell to the task. The server validates it as an
  existing `…/task.md` and stores it as `t.task`.
- `inject-plan.sh` loads task.md into the kickoff prompt because the working
  folder is the task folder.
- `run` is now sent when the socket first opens, not after a 400ms timer.
- If a terminal already has that task, the button becomes "Go to agent" and
  `goToAgent(id)` focuses it (dock, Terminals window, or a reattach). It never
  starts a second agent. A held session shows the dock and focuses its space; one the window holds, or
  any session when "Terminals open in" is Window, goes to the window; otherwise it is brought into the dock.

**Board cards.** termui.js polls `/api/term/list` every 3s while the page is visible, and
`workbench.js` reads it through `TW.onList` (it no longer polls itself). The list returns
`task` and `agent` for each session, into `TASK_AGENTS`. `paintCardAgents()`
patches only the pills, with no board re-render. Clicking a pill is caught in the
capture phase on `#board`, so the card's drawer doesn't open.

**Deploy note.** Terminals opened before a `docker restart vault-board` never get
badges, because their environment predates the restart. The restart also kills
them anyway.

## Terminal spaces (added 2026-10-07, after herdr)

Ben wanted the terminal to look and work like [herdr](https://github.com/herdrdev/herdr), a TUI
multiplexer for coding agents: one overview, splits you control, fast ways to get somewhere. Built on
branch `herdr-terminals` (worktree `/opt/vault/board-herdr`), design in
`docs/superpowers/specs/2026-10-07-herdr-terminals-design.md`. **Status: built and reviewed, Tasks 0–12 done, plus the
final-review fix wave. The release (Task 13) has NOT happened yet.** Master is untouched, so none of this is live on :7684.

- **Modules and load order.** Each is an IIFE (or, for `termui.js`, the one file of globals) that exposes
  exactly one global; nothing in `term*.js` may reference `app.js` or `workbench.js`, and a clash with an
  `app.js` top-level name (e.g. `esc`) is a SyntaxError that silently kills later scripts. Order in
  `index.html` and `terminal.html`: vendor xterm → `term.js` → `termtree.js` (`TermTree`, pure, node-testable)
  → `termside.js` (`createTermSide`, sidebar and rail) → `termpick.js` (`createTermPicker`, Go-to modal and
  phone sheet) → `termkeys.js` (`installTermKeys`, prefix and `?` sheet) → `termtoast.js` (`TermToast`,
  toasts and sound) → `termui.js` (`createTermWorkspace`, plus the `TW_*`/`tw*` globals `app.js` and
  `workbench.js` use) → `app.js` … `workbench.js` (index.html only). `termui.js` is ~1400 lines;
  splitting the server-list, presence and restore parts out was deferred.
- **Space key and join rule** (`TermTree.spaceKey`). A space is `'t:'+task` (the Board task a terminal
  is linked to) or `'d:'+cwd`. Join rule: an unlinked cwd equal to the folder of any known task gets that
  task's key, so it works before the server's auto-link. Names: custom name, else task title, else task
  folder, else basename(cwd), else `vault`. The detail line: a task space shows its status word, or "task
  moved", and never a branch; a folder space shows its git branch, else its parent path, else (a top-level
  folder or the vault root) "N terminals"; either gets a "· <n> detached" / "· <n> elsewhere" suffix
  (`termtree.js` `spaces`). `TermTree.spaces()` returns `{key, num, name, detail, rollup, ids, heldIds, dim,
  goId, goWhere}` in server-list order (the held-here field is `heldIds`). **Only a space with a pane held
  here is numbered:** `num` counts 1, 2, … over those, and it is both what the sidebar and rail show and what
  Alt+N goes to. A space with no pane here has `num: null` and `dim: true`, and `goId`/`goWhere` name the row
  a click on it goes to: its most urgent (`agentOrder`), else its first.
- **Split trees** (`termtree.js`): `Node = {id} | {dir:'row'|'col', r, a, b}`. `split:'right'` makes a
  `row` split and `'down'` a `col`; the new leaf goes in `b`. A new pane with no split goes into the largest
  rect along its longer side (`insertLargest`). `add()` keeps a leaf already in the saved tree for that
  id, so a reload keeps the arrangement. A pane that would be under about 140×70px is still inserted,
  then zoomed. Divider drag clamps 12–88%.
- **Store and keys** (via `twGet`/`twSet`, sessionStorage first with a localStorage mirror so a reload
  or second tab keeps its own): `${store}.tree` (`{v:1, active, spaces:{key:{root,focus,zoom}}}`, junk
  becomes an empty store), `${store}.side` (dock `rail`, window `side`), `${store}.sessions` and
  `.focused` as before, plus `vaultboard.term.spaceNames` (`{key:name}`, shared by both hosts, carried
  over on rekey) and `vaultboard.term.sound` (default off). **Migration:** the old `${store}.layout` and
  `.ratios` are deleted on first load. If the layout was Tabs, each space is zoomed to its focused pane,
  applied lazily the first time that space's tree is built after load. **Rekey:** when the server links a
  shell to a task, or `/done` moves the task folder, a held session's key changes; its leaf moves, or if
  every pane of the space moves to the same key the space is renamed with tree, zoom and custom name kept.
- **Presence and the cross-host click table.** `rows()` has a `where` of `here | window | dock | tab |
  elsewhere | detached`. Presence rides the existing `BroadcastChannel('vaultos-workbench')`:
  `{presence:{from, host, ids}}` on any change, `{who}` on load, an empty list on `pagehide`. It counts
  only while the server list also says `attached`. A session stolen from this page (close code 4000) is
  removed with `kill:false` and a neutral toast "… opened elsewhere"; its row stays, dimmed. Dimmed rows
  (detached or elsewhere) use `--muted` italic text, not opacity, for contrast. A **space** row is dimmed
  when no pane of it is held here (detached, elsewhere, or both). It has no number (the rail shows just its
  mark, the sidebar its mark and name), and its tooltip ends in the where-note of the row a click goes to.
  Clicking it calls `goTo(goId)`, so the table below applies: the dock hands a window-held space to the
  window, anything else is brought here (a detached plain shell is reattached). Until the final review that
  click did nothing, and only an all-detached space was dimmed.

  | Session is | Row | Click (`TW.goTo`) |
  |---|---|---|
  | held here | normal | activate its space, focus the pane |
  | in the window, seen from the dock | dim, "elsewhere: open in the Terminals window" | `goElsewhere`: `openTermWindow()` + `handToWindow` (twAdopt focuses it) |
  | in the dock or another tab, seen from the window | dim | bring here (steals it, 4000) |
  | attached, holder unknown (no presence) | dim, "open in another window" | bring here |
  | detached | dim, "detached: running in the background" | bring here (reattaches) |

  The window has no `goElsewhere`: a popup can't reliably focus its opener. On the Board page,
  `goToAgent` does the same job for pills and toasts (see Agent badges). If the pop-up is blocked,
  `goTo`/`goToAgent` fall back to bringing the session into the dock, which steals it from the window.
- **Restore** (`TW.restore(saved, returning)`, called from `workbench.js`) never steals: sessions
  handed back by the window (`returning`) are adopted at once; a saved one is re-added when the server
  reports it detached or missing; one still attached is re-checked once after 2s, then dropped (another
  page has it). A 401 keeps `vaultboard.term.returning`. The focus is settled once, by one rule: a pane
  the user picked during the restore wins; else the saved focus if it is still held; else the last held
  returning pane; else the saved active space.
- **Ctrl+Space prefix** (`termkeys.js`; **not** Ctrl+B, which is Claude Code's "run in background").
  A window capture-phase keydown, because only that runs before xterm's helper-textarea listener and so
  can hold back both Ctrl+Space and the key after it. Only *plain* Ctrl+Space arms it (Ctrl+Shift, Alt
  and Meta variants are free); `term.js` returns false for the same combination. Then: `\` split right,
  `-` split down, `z` zoom, `x` close, arrows/`hjkl` move focus, `g` Go-to, `n` next agent needing you,
  `b` sidebar ⇄ rail, `?` shortcuts sheet, Ctrl+Space again sends NUL. A `PREFIX` pill (`--brand` on
  `--on-brand`, the only place in the terminal-spaces UI that uses them; the rest of the app uses them elsewhere) shows in a mode bar inside `.tw-panes`, so it never
  refits the terminals. It disarms on blur, any pointerdown, or when the host hides. **Escape:** never
  touched while focus is in xterm and the prefix is unarmed; armed, it cancels and is swallowed (anything
  unbound is). Overlays (sheet, picker, menus) take Escape on their own element with `stopPropagation()`,
  because `app.js` closes the task drawer on any document Escape. Direct keys: Alt+1…9 = the space numbered
  N in the sidebar or rail (only spaces with a pane here are numbered, so a key never brings a session),
  Ctrl+Shift+` = new pane; neither acts while the `?` sheet or the Go-to picker is open (`ctx.overlayOpen`).
  Ctrl+` stays in `workbench.js`, and the `?` sheet lists it on the dock only (the window has no dock).
- **Hidden-pane resize fix.** The old `display:none` on background panes made `connect()` send xterm's
  default 80×24, and on reattach the server resized a live pty to it, so a reload with the dock minimised
  squeezed a running Claude to 80 columns. Now panes of other spaces, and siblings of a zoomed pane, are
  `.tw-off` (`visibility:hidden` at their real size), and `term.js` never sends a size from a pane that has
  never been fitted (the server already skips the resize when absent). **Hidden reconnect** (final review):
  `term.js` keeps a `sized` flag, set the first time the fit runs on a real box. A connect from a hidden box
  sends the last real size when `sized`, none when not, and either way owes the server a size: the first
  fit on a real box with the socket open sends `{t:'resize'}` even when unchanged (`payOwedSize`; also run
  from `ws.onopen`), and a resize while the socket is down is owed too. Before, a server restart with the
  dock minimised left the fresh pty at the server's 100×30 inside, say, a 192×16 pane, because the fit on
  show found xterm already at its size and sent nothing (e2e `S11-hidden`). Related: `term.js` wraps
  `fit.fit` to drop a row when FitAddon's count overflows the box at a fractional devicePixelRatio, and
  to take the cols from the renderer's unrounded cell width (FitAddon divides by the css cell width, the
  canvas rounded to whole pixels over the cols already set, so two panes in the same box could settle a
  column apart, 51 and 52 on a phone, depending on history). `.term-host .xterm-viewport` is transparent
  (it used to leave a black band at the pane bottom).
- **Toasts and sound** (`termtoast.js`). An agent toast (blocked or done) shows only when this page has
  focus and the pane is not actually visible: visible means the workspace is shown, the pane is in the
  active space, not hidden by zoom, and on a phone only the focused pane counts. A same-id, same-kind toast
  replaces the older one; at most 4 show; 8s blocked, 5s done. Click calls `goTo`. Also toasts "opened
  elsewhere" and the cap ("12 terminals open"). Sound is a WebAudio tone, off by default, set by the footer
  menu or Settings → "Agent sound". If no VaultOS page has focus there is no toast; the window title and
  header badge still show it.
- **Server** (`lib/term-meta.js`, wired in `server.js`; `lib/` is a live read-only mount).
  `findJobTask` auto-links a shell opened inside a job folder (walks up inside a workspace, skips
  `SKIP_DIRS` and dot segments, called only for a new id with no task); `taskInfo` reads `task.md` into
  title and status (mtime cache), follows a folder moved to `_done/` or `_cancelled/`, else reports
  `missing`; `gitBranch` reads `.git/HEAD` (10s cache; only the `homelab-iac` and `infra-scripts` repos
  show a branch today). `/api/term/list` adds `taskTitle`, `taskStatus`, `taskMissing` and `branch`; nothing
  was removed and there is no new endpoint or websocket change. The frontend degrades without them: names
  fall back to the task folder or the cwd.
- **Preview recipe.** Never test against :7684; clicking a dimmed row there would steal Ben's live sessions.
  `/opt/vault/herdr-term-preview` holds `compose.yml`, `reset.sh` and `mint-cookie.js`: container
  `herdr-term-preview` on `127.0.0.1:7690`, `SECURE_COOKIE=0`, a synthetic vault from
  `scripts/term-sandbox.js` and the worktree's `public/`, `lib/`, `server.js` and `scripts/` mounted
  read-only. `public/` is live with no restart; `server.js` and `lib/` need `docker restart
  herdr-term-preview`. `reset.sh` wipes and regenerates vault and home (it also copies `/etc/skel/.profile`
  so `bash -l` sets OSC titles). `mint-cookie.js` prints a session cookie and is never stored.
  `scripts/term-fake-agent.js` stands in for Claude inside a preview terminal (keys `w b d i q`).
  Run `node scripts/term-e2e.js S0 S1 …` (puppeteer, resets the preview first, PASS/FAIL per check, exits 1
  on any FAIL, shots in `/tmp/term-shots/`). Its URL guard is an allowlist: any base but
  `http://127.0.0.1:7690` is refused unless `TERM_E2E_OTHER_BASE=1`, and port 7684 is refused either way.
  Scenarios: S0 S0b S3a S1 S1b S2 S2-moved S4 S4-twotabs S4-restore S4-restore-focus S8 S11 S11-hidden
  S12-cap S3 S3-theme S12-cap-window S2-side S2-rail S2-escape S7 S7-desktop S6 S6-sepia S5 S5-phone
  S5-hidden S5-phone-pane S12-toast S10. Phone scenarios
  use the `noGL` page option because headless `--disable-gpu` WebGL paints nothing at deviceScaleFactor 2
  (the WebGL path on a real phone is a live check). Unit tests: `docker run --rm -v "$PWD":/app -w /app
  node:22-bookworm-slim node --test test/termtree.test.js test/term-meta.test.js`. **Never kill processes
  by pattern** (`pkill`, `killall`): this host's process table includes other containers' processes,
  including Ben's live sessions in vault-board; kill only PIDs you started.
- **Release order (Task 13, not done).** 1) Fast-forward master. That makes the frontend live on :7684
  at once (`public/` is a live mount), but the server isn't restarted yet, so names fall back to folders.
  2) Restart `vault-board` for the server part, **only with Ben's OK**: a restart kills every live pty,
  including overnight `claude` sessions (check `docker exec vault-board ps -eo pid,etime,args` first). An
  open pop-out keeps running the old JS until reloaded, so the handoff stays backward compatible:
  `window.twAdopt(metas)`, `{returned: metas}` and `vaultboard.term.returning` are still arrays of
  `{id,n,title,cwd,task}`. After release, check live with Ben watching: real Claude titles and hook states,
  Ctrl+Space reaching the browser (some OS input switchers take it; every command is also in the menus
  and the picker), and WebGL on a real phone.
- **Not in this round:** resume after restart (`claude --resume`), a Telegram "needs you" ping, a `vaultos`
  CLI for agents, tabs inside a space, live cwd tracking, ahead/behind counts.

## Today mode (built on branch `today-mode`, not yet released)

VaultOS opens on **Today**: date stepper, daily quote, eight habits with a 7-day grid and streaks,
today's task checklist with rollover, and a server-held Pomodoro. Spec:
`docs/superpowers/specs/2026-10-11-today-mode-design.md` (last section lists what changed while building).
Code: `lib/today-{note,stats,quote,timer,service}.js`, `lib/atomic-write.js`, the Today routes in
`server.js`, and `public/today.js`.

- **Data is plain markdown in the vault** under `Personal/Today/`: `habits.md` (the habit table),
  `days/YYYY-MM/YYYY-MM-DD.md` (one note per day) and `.timer.json`. Focus minutes are never stored as a
  total. They are summed from the `## Focus` lines in the day note. The Board and KB scans skip this folder.
- **Dates are London time.** The container runs UTC (`TZ` unset), so a plain `new Date()` date would roll
  Today over at 01:00 in summer. Every date goes through `Intl` with `Europe/London`. Don't add a bare
  `toISOString().slice(0, 10)`.
- **The read path never writes.** The loopback read path (`127.0.0.1`) can see Today but creates nothing:
  no day note, no `habits.md`. The first signed-in load seeds them. A headless screenshot of `:7684`
  therefore shows Today with empty lists.
- **`.timer.json` is server-owned.** `startedAt`/`endsAt` are epoch milliseconds. The service saves the
  state before it updates memory, and a lazy load never overwrites newer state. The timer state machine
  leaves `lastEvent` alone. Only the service sets it, with an `id` that clients compare for any change.
- **Habit and task edits are line edits.** `setHabit` rewrites the whole owned `habits:` value, in block-list
  or inline form, because Obsidian writes block lists. Rollover marks only the tasks it carried. Task writes
  are one at a time, so a double Enter can't add twice. A section ends at the next `#` or `##` heading, new
  tasks and focus lines go after the last one, and a new quote replaces only the `>` lines: Ben's own text
  in the note stays put.
- **A stale "today" never writes.** The client works out London's date on the server-corrected clock. If
  the page is on "today" and that date has moved on (a tab left open overnight), a tick or task write isn't
  sent: the page reloads and says "New day. Refreshed." A past day stepped back to is written as asked.
- **Restarts kill live terminals.** Shipping Today means `docker restart vault-board`, which ends every
  terminal. The merge alone puts the new `public/` live before the server has the routes. Merge and restart
  together, and only with Ben's OK. The plan's "Releasing" section is the checklist.
- **Preview on `127.0.0.1:7691`** (container `today-preview`, files in `/opt/vault/today-preview/`). It runs
  a synthetic vault from `scripts/today-sandbox.js`. `reset.sh` wipes and regenerates it and restarts the
  container. `mint-cookie.js` makes a session cookie from the preview's own config. Never point tests at
  `:7684`, which holds Ben's real day notes.
- **`TODAY_SECONDS_PER_MINUTE` is preview-only.** The preview sets it to 1 so a 25-minute session takes 25
  seconds. The server accepts 1 to 60 and falls back to 60. Never set it on the live container.
- **E2E:** `node scripts/today-e2e.js [--phone] [--theme=sepia] T0 [T1 … T5]`. T0 is the shell and
  landing, T1 habits, T2 tasks, T3 the timer, T4 the stale-day guard and the wake-up retries, T5 an
  overtaken habit tick. Run all six across desktop and phone in Dark and Sepia (24 runs) before a release. Each run resets the preview first. Screenshots go to `/tmp/today-shots/`.
  T3 takes one to two minutes. Seed focus minutes by appending a line to the day note, not by running two
  sessions in one minute: the finish step skips a line it has already written.

## Portable mode (settings, setup, env)

Since the portable release the same image runs the homelab and any Docker machine. Spec:
`docs/superpowers/specs/2026-10-13-portable-vaultos-design.md` (its "Decisions made during
implementation" section is the record of what changed while building). User doc: `docs/portable.md`.

**Settings file.** `<VAULT_DIR>/.vaultos/settings.json`, schema `version: 1`: `setupDone`, `boards`
(`key`, `dir`, `label`, `hidden`; order = switcher order, first visible = default), `features`
(`today`, `terminal`), `today` (`dir`, `timezone`), `agent` (`profile`: claude|cursor|custom|none).
Code: `lib/settings.js` (load, validate, atomic save, cache), `lib/migrate.js` (homelab migration),
`lib/setup.js`, `lib/agents.js`. It replaced the hardcoded `WORKSPACES` and
`workspace-visibility.json`. An invalid file is an error on the setup page, never silently replaced.

**Setup stages** (`setupStage()`): no password and no settings = full setup (folder, password,
boards, agent, extras); settings but no password = folder, password, agent; password and boards
on disk but no settings = migration at boot, no setup; `setupDone:false` = sign in, finish the
rest. While setup is due `/` serves `setup.html` and `/api` answers `409 {"setup":true}` except
`/api/setup/*`, login/logout/me and the agent routes. Steps 1-2 (no login) only work for
`SETUP_WINDOW_MIN` minutes after boot.

**Env.** Defaults are in the code (`server.js`, `lib/password.js`); the user-facing table is in
`docs/portable.md`.

| Var | Default | Homelab |
|---|---|---|
| `VAULT_DIR` | `/vault` | `/vault` |
| `DATA_DIR` | `$HOME/.vaultos` (`config.json`, `lockout.json`, `sheet-backups/`) | `/app` |
| `LOCAL_READ` | off unless `1` | `1` |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | `vb.ctrlaltautomate.com,192.168.1.188,localhost,127.0.0.1` |
| `SECURE_COOKIE` / `TRUST_PROXY` | off unless `1` | `1` / `1` |
| `TERMINAL` | on unless `0` (hard switch, beats `features.terminal`) | `1` |
| `SETUP_WINDOW_MIN` | `15` (integer, `0` closes at once; tests use it) | unset |
| `SHEET_BACKUP_DIR` | `$DATA_DIR/sheet-backups` | `/app/sheet-backups` |
| `TZ` | unset; used only by the migration for Today's timezone | `Europe/London` |

The homelab compose `board` service carries `DATA_DIR`, `LOCAL_READ`, `TZ` and `ALLOWED_HOSTS`
in both copies (repo and `/opt/vault/docker-compose.yml`); the live file gets them at the release.

**Compose files.** The repo now has `compose.yaml` (the portable one) next to `docker-compose.yml`
(the homelab one). Running `docker compose` inside the repo directory picks up `compose.yaml`.
The live stack must be run from `/opt/vault` (its own `docker-compose.yml`), or with an explicit
`-f /opt/vault/docker-compose.yml`. Never run `docker compose up` in `/opt/vault/board` expecting the homelab.

**Tests and checks.**

- `npm test` (server tests spawn `server.js` on a free port with temp dirs, `TERMINAL=0`, no network).
- `node scripts/portable-e2e.js` (puppeteer against the portable preview at `http://127.0.0.1:7692`);
  `--with-installs` also runs the real Claude/Cursor installers and is opt-in.
- `/opt/vault/portable-preview/reset.sh` wipes the preview to a blank install.
- Today e2e against the portable preview:
  `TODAY_E2E_OTHER_BASE=1 TODAY_E2E_PREVIEW=/opt/vault/portable-preview/today TODAY_E2E_CONTAINER=portable-preview node scripts/today-e2e.js http://127.0.0.1:7692 T0 T1 T2 T3 T4 T5`
- `bash scripts/portable-migrate-check.sh` copies the real vault to a temp dir, boots the portable
  image on the copy with the homelab env, and checks the only change is `.vaultos/settings.json`.
  An EXIT trap deletes the copy even on failure.

**Never do.**

- Never run any e2e or check against `:7684` (the live board). Previews are `:7692` and `:7693`.
- Never write `config.json` or `lockout.json` with temp file + rename. The homelab bind-mounts
  `/app/config.json` and `/app/lockout.json` as single files, and a rename replaces the inode and
  breaks the mount. Write them in place. (Vault and settings writes do go through `atomicWrite`.)
- Never put personal names, workspace names from this vault, hostnames, domains or IPs in
  `starter-kit/`, `docs/portable.md`, tests or fixtures. Only `docker-compose.yml` and this file
  may name them (fixtures use `Work`, `alpha`, `Beta`).
- Never restart, rebuild or recreate `vault-board` without Ben's OK; it kills his live terminals.
- Never edit `/opt/vault/docker-compose.yml` from the repo work; the release step does that.

**Release notes (homelab).** Only with Ben's OK. Steps: `docker tag vault-board:latest vault-board:pre-portable`;
`git -C /opt/vault/board merge --ff-only portable`; copy the four env lines into
`/opt/vault/docker-compose.yml` and `diff` the `board` service against the repo copy (identical);
`cd /opt/vault && docker compose build board && docker compose up -d board`; then check
`curl -s localhost:7684/health` shows `"setup":false`, `docker logs vault-board 2>&1 | grep -E 'migrated:|host rejected:'`,
`/opt/vault/vault/.vaultos/settings.json`, `find /opt/vault/vault/.vaultos ! -uid 1000` prints
nothing, and a headless screenshot of `http://127.0.0.1:7684/`.
Before the release, the live compose must gain the four env lines above.
Caddy and the Cloudflare tunnel must pass the original `Host` header, or the Host check rejects
every request with 421. After a release check
`docker logs vault-board 2>&1 | grep 'host rejected:'`, and add any legitimate host it names to
`ALLOWED_HOSTS` (`/health` is exempt, so the healthcheck is unaffected). The migration makes
board order alphabetical, so the default board becomes Business until Ben reorders in
Settings → Boards. Rollback: retag `vault-board:pre-portable` as `latest`, remove the four env
lines, `docker compose up -d board`; the extra `.vaultos/settings.json` is harmless to old code.
