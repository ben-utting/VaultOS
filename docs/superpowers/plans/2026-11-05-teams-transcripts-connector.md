# Teams transcripts connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A built-in "Teams transcripts" connector: VaultOS signs in through an app registration the user supplies (device code), and Claude and Cursor read that user's meeting transcripts through `/mcp/transcripts`.

**Architecture:** Two new modules: `lib/connector-msapp.js` (device code, polling and single-flight refresh for a public-client Microsoft app, plain HTTPS) and `lib/connector-transcripts.js` (VTT conversion, the three MCP tools, Graph calls; same `handle`/`probe` interface as `connector-entra.js`). `connector-service.js` stops assuming every built-in rides the Azure sign-in, and gains msapp start/status/cancel. `public/connectors.js` gains one card.

**Tech Stack:** Node 22 CommonJS, `node:test`, Express routes in `server.js`, vanilla JS front end. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-05-teams-transcripts-connector-design.md`

## Global Constraints

- **Nothing organisation-specific** in code, tests, fixtures, docs or commit messages: no real tenant ID, client ID, company name or domain. Tests use made-up GUIDs (e.g. `11111111-2222-3333-4444-555555555555`) and `alex@example.com` / `Acme Ltd`.
- Connector id `transcripts`, label `Teams transcripts`, by-line `Meeting transcripts from an app you register`, kind `builtin`, `signIn: ['msapp']`.
- Scopes, exactly: `OnlineMeetingTranscript.Read.All OnlineMeetings.Read Calendars.Read User.Read offline_access`.
- Authority `https://login.microsoftonline.com`, Graph `https://graph.microsoft.com/v1.0`; overridable only by env `CONNECTOR_UPSTREAM_TRANSCRIPTS_LOGIN` / `CONNECTOR_UPSTREAM_TRANSCRIPTS_GRAPH` (e2e preview).
- Every Graph call is GET, `redirect: 'manual'`, 30 s timeout. Tokens never reach agents, logs or the view.
- Store record `connectors.transcripts = { method: 'msapp', tenantId, clientId, refreshToken, account, lastTest }`; sign-out keeps only `{ method, tenantId, clientId }`.
- Caps: `transcripts_list` `days` 1–30 (default 7), at most 100 lines; `transcript_get` output at most 400 KB.
- Copy for tool errors is the spec's wording, verbatim.
- Work in `/opt/vault/board-transcripts` (branch `transcripts`). Run the suite in the image:
  `docker run --rm -u 0 --entrypoint node -v /opt/vault/board-transcripts:/app -w /app vault-board:latest --test 'test/*.test.js'`
  (single file: replace the glob with the file path). The live board (:7684) is never touched.

## Review Focus

1. **VaultOS restarts while signed in.** Expect: tools work after restart with no new sign-in (record rebuilt from the store). Test in Task 4.
2. **A refreshed token is used, then VaultOS restarts.** Expect: the store holds the newest refresh token before `accessToken()` resolves, so the old (now spent) one is never reused. Test in Task 1.
3. **Sign-in refused for a reason the spec doesn't list** (e.g. a Conditional Access block, an unknown `AADSTS` code). Expect: the card shows the first line of Microsoft's `error_description`, not "unknown error". Test in Task 1.
4. **VTT with a BOM, CRLF line endings, cue IDs and no voice tags.** Expect: readable `[hh:mm] Unknown: text` lines. Test in Task 2.
5. **Many transcripts, some meeting lookups failing (429/404).** Expect: the list still returns, capped at 100, with `(no subject)` for the failed lookups, and a nextLink off the Graph origin is not followed. Test in Task 3.

---

### Task 1: Microsoft app sign-in (`lib/connector-msapp.js`)

**Files:**
- Create: `lib/connector-msapp.js`
- Test: `test/connector-msapp.test.js`

**Interfaces:**
- Produces:
  - `SCOPES` (string, Global Constraints value), `isGuid(s) -> boolean`.
  - `classify(status: number, body: object|null) -> { kind: 'refused'|'config'|'transient'|'pending'|'slow_down'|'expired', message: string }`.
  - `createMsApp({ fetch, now = Date.now, sleep = (ms) => new Promise(r => setTimeout(r, ms)), authority = 'https://login.microsoftonline.com', scopes = SCOPES, onRefreshToken: async (rt) => void })` returning:
    - `start({ tenantId, clientId }) -> Promise<{ url, code, expiresAt }>` — begins polling in the background.
    - `status() -> { status: 'idle'|'waiting'|'done'|'failed', error?: string }`.
    - `cancel() -> void`.
    - `restore({ tenantId, clientId, refreshToken }) -> void` — load a saved sign-in, no network.
    - `accessToken() -> Promise<string>` — throws `MsAppError` with `.kind` (`'refused'|'transient'|'config'|'signed-out'`).
    - `forget() -> void` — drop the in-memory access token only.
    - `signOut() -> void` — drop everything in memory.
  - `class MsAppError extends Error { kind }`.

- [ ] **Step 1: Write the failing tests** in `test/connector-msapp.test.js`, with a scripted fake `fetch` (records each call's URL and form body) and `sleep = async () => {}`:
  - `isGuid` accepts `11111111-2222-3333-4444-555555555555`, refuses `abc`, `../x`, and a GUID with spaces.
  - `start` refuses a non-GUID tenant or client with `MsAppError` kind `config` and makes no request.
  - `start` POSTs to `${authority}/${tenantId}/oauth2/v2.0/devicecode` with form `client_id` and `scope === SCOPES`; resolves `{ url: 'https://microsoft.com/devicelogin', code: 'ABCD1234', expiresAt: now + 900000 }` from `{ user_code, verification_uri, expires_in: 900, interval: 5, device_code }`.
  - polling: token endpoint answers `authorization_pending`, then `slow_down`, then success `{ access_token, refresh_token: 'rt1', expires_in: 3600 }` → `status()` goes `waiting` → `done`; `onRefreshToken` called once with `'rt1'`; the poll after `slow_down` sleeps `interval + 5` seconds (assert the sleep argument).
  - `expired_token` → `failed`, error `'The code expired before it was entered. Start again.'`.
  - `{ error: 'invalid_client', error_description: 'AADSTS7000218: The request body must contain … client_assertion …\r\nTrace ID: …' }` → `failed`, error says public client flows must be allowed on the app registration.
  - `AADSTS700016` → error says the app wasn't found in that directory; `AADSTS90002` → the directory (tenant) wasn't found.
  - **Review Focus 3:** `{ error: 'invalid_grant', error_description: 'AADSTS53003: Access has been blocked by Conditional Access policies.\r\nTrace ID: x' }` at sign-in → `failed` with error exactly `'AADSTS53003: Access has been blocked by Conditional Access policies.'`.
  - `restore(...)` then `accessToken()` → one refresh POST with `grant_type=refresh_token`, `refresh_token`, `client_id`, `scope`; returns the new access token; a second call within expiry makes no request; one at `expiresAt - 4 min` refreshes again.
  - **Review Focus 2:** refresh returns `refresh_token: 'rt2'` → `onRefreshToken('rt2')` has resolved before `accessToken()` resolves (use an `onRefreshToken` that awaits a deferred; assert `accessToken()` is still pending until it resolves).
  - single flight: two concurrent `accessToken()` calls → exactly one refresh request, both get the same token.
  - refresh `invalid_grant` → throws kind `refused`; a fetch that rejects (network) or a 503 → kind `transient`; neither clears the saved refresh token for `transient`.
  - `accessToken()` with nothing restored → kind `signed-out`.
- [ ] **Step 2: Run** `… --test test/connector-msapp.test.js` — Expected: FAIL (`Cannot find module '../lib/connector-msapp'`).
- [ ] **Step 3: Implement** `lib/connector-msapp.js`. POST bodies are `application/x-www-form-urlencoded`, 30 s timeout. `classify` maps `authorization_pending`→`pending`, `slow_down`, `expired_token`/`code_expired`→`expired`, `invalid_grant`/`interaction_required`/`AADSTS50173`/`AADSTS700082`→`refused`, `AADSTS7000218`/`AADSTS700016`/`AADSTS90002`/`invalid_scope`/`invalid_client`→`config`, status ≥500 or no body→`transient`; the message for codes without fixed copy is the first line of `error_description`. Polling stops when `expiresAt` passes or on `cancel()`. Refresh is single-flight via one shared promise.
- [ ] **Step 4: Run** the file — Expected: all PASS.
- [ ] **Step 5: Commit** `git add lib/connector-msapp.js test/connector-msapp.test.js && git commit -m "Connectors: sign-in for a user-supplied Microsoft app (device code, single-flight refresh)"`

### Task 2: VTT to text and ID checks

**Files:**
- Create: `lib/connector-transcripts.js` (pure helpers only in this task)
- Test: `test/connector-transcripts.test.js`

**Interfaces:**
- Produces: `vttToText(vtt: string) -> string`, `checkId(s: unknown) -> string` (throws `TranscriptsError`), `class TranscriptsError extends Error`.

- [ ] **Step 1: Write the failing tests:**
  - two cues `<v Alex Smith>Hello</v>` (00:00:01.000) and `<v Alex Smith>there</v>` (00:00:04.000) then `<v Sam Lee>Hi</v>` (00:01:05.500) → `'[00:00] Alex Smith: Hello there\n[00:01] Sam Lee: Hi'`.
  - a cue over two text lines joins with one space.
  - a cue at `01:02:03.000` → `[01:02]`; short form `02:03.000` → `[00:02]`.
  - **Review Focus 4:** input with a leading `﻿`, `\r\n` endings, numeric cue IDs and NOTE blocks, no voice tags → `[00:00] Unknown: …` lines, no `WEBVTT`, no IDs, no NOTE text.
  - empty string and `'WEBVTT\n\n'` → `''`.
  - `checkId('MSo1N2Y5ZGFj_LTQ3=')` returns it; `checkId('a/b')`, `checkId('../x')`, `checkId('')`, `checkId(5)`, a 2001-char string → throw `TranscriptsError`.
- [ ] **Step 2: Run** `… --test test/connector-transcripts.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** both helpers. `checkId` regex `^[A-Za-z0-9_=\-]{1,2000}$`. `vttToText` strips other inline tags (`<c>`, `<b>`) from text and decodes `&amp; &lt; &gt;`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Transcripts: VTT to readable text, ID checks"` (both files).

### Task 3: The transcripts MCP server

**Files:**
- Modify: `lib/connector-transcripts.js`
- Test: `test/connector-transcripts.test.js` (append)

**Interfaces:**
- Consumes: `MsAppError` kinds from Task 1 (via the injected `token`), `vttToText`, `checkId` from Task 2.
- Produces: `TOOLS` (3 tools: `transcripts_list`, `transcript_get`, `transcripts_help`), `createTranscripts({ fetch, token: () => Promise<string>, forget: () => void, now = Date.now, graph = 'https://graph.microsoft.com/v1.0' })` returning `{ handle(rpc) -> Promise<object|undefined>, probe() -> Promise<{ ok, tools, error, account }>, list({ days }) -> Promise<Array<{ start, subject, meetingId, transcriptId }>>, get({ meetingId, transcriptId, raw }) -> Promise<string> }`. `list`/`get` are exported for the later ingest.

- [ ] **Step 1: Write the failing tests** with a fake Graph `fetch` keyed by URL path:
  - `initialize` → `serverInfo.name === 'VaultOS Teams transcripts'`; `tools/list` → the three names; unknown method → `-32601`; a notification → `undefined` (same shape as Entra's tests).
  - `transcripts_list {}` → requests `/me` once (cached across two calls), then `/users/{id}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='{id}',startDateTime=<now-7d ISO>,endDateTime=<now ISO>)`; follows one nextLink; one meeting lookup per distinct meetingId with `$select=subject,startDateTime,endDateTime`; output lines newest first like `2026-11-04 14:00 · Weekly planning · meetingId=m1 transcriptId=t1`.
  - `days: 0`, `days: 31`, `days: 'x'` → tool error naming 1–30.
  - `transcripts_help {}` → text naming both other tools and the three limits (organised by you, transcription on, expiry).
  - empty result → text includes `only meetings you organised`, `transcription`, and `expire`.
  - **Review Focus 5:** 150 transcripts over 3 pages → 100 lines plus a note that more exist; lookups answering 429 or 404 → `(no subject)`, no error; a nextLink on `https://evil.example/` → not fetched, list returns what it has.
  - `transcript_get` → header `Subject:`/`Start:`/`End:` then `vttToText` output; request path `/me/onlineMeetings/m1/transcripts/t1/content` with `$format=text/vtt`; `raw: true` returns the VTT unchanged; 500 KB of text → cut at 400 KB with `[cut at 400 KB]`; bad ID → tool error, no request made.
  - Graph errors, exact copy from the spec: 403 with `GraphAccessToTranscriptsDisabled` → "Your organisation has turned off transcript access through Graph."; other 403 → the app-registration permission sentence; 404 on get → the "Not found…" sentence.
  - 401 then 200 → `forget()` called once, request retried once, success.
  - `token()` throwing `MsAppError` kind `refused` or `signed-out` → tool error "The Teams transcripts sign-in has run out. Open Settings → Connectors in VaultOS and sign in again."; kind `transient` → "Couldn't reach Microsoft. Try again in a moment."
  - `probe()` → `{ ok: true, tools: 3, error: null, account: 'alex@example.com' }` from `/me` `userPrincipalName`; on failure `{ ok: false, tools: 0, error: <tool error text> }`.
  - every recorded request has method `GET` and `redirect: 'manual'`.
- [ ] **Step 2: Run** — Expected: new tests FAIL.
- [ ] **Step 3: Implement** in `lib/connector-transcripts.js`, following `connector-entra.js`'s `handle`/`text()` pattern. Meeting lookups run at most 5 at a time. Header times are shown as `YYYY-MM-DD HH:MM` UTC.
- [ ] **Step 4: Run** the file — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Transcripts: MCP tools over Microsoft Graph (list, get, help)"`.

### Task 4: Catalogue, service and routes

**Files:**
- Modify: `lib/connectors.js` (catalogue entry; `entryFor` already handles `builtin`)
- Modify: `lib/connector-service.js` (builtin routing, msapp actions, view, test, disconnect, init)
- Modify: `server.js` (three routes beside the Azure ones, ~line 1602)
- Test: `test/connector-transcripts-service.test.js` (new, modelled on `test/connector-entra-service.test.js`), `test/connectors.test.js` (catalogue assertion)

**Interfaces:**
- Consumes: `createMsApp`, `isGuid` (Task 1); `createTranscripts` (Task 3).
- Produces on the service: `msappStart(id, { tenantId, clientId }) -> Promise<{ url, code, expiresAt }>`, `msappStatus(id) -> Promise<{ status, error? }>`, `msappCancel(id) -> void`. Routes: `POST /api/connectors/transcripts/start` (body `{ tenantId, clientId }`), `GET /api/connectors/transcripts/status`, `POST /api/connectors/transcripts/cancel`, all behind `settingsGuard` and `connectorRoute`. View row for `transcripts` adds `tenantId`, `clientId` (also when signed out, if saved) and `state: 'connecting'` while the device code is waiting.

- [ ] **Step 1: Write the failing tests** (fake `fetch` answering both the login host and Graph, `sleep` injected so polling finishes at once — add a `sleep` option to `createConnectorService` and pass it to `createMsApp`):
  - catalogue: `CONNECTORS.transcripts` matches Global Constraints; `entryFor('transcripts', { port: 7684, key: 'k' })` is the http entry for `/mcp/transcripts`.
  - `msappStart('transcripts', { tenantId: 'x', clientId: … })` → `ConnectorError` "That doesn't look like a Directory (tenant) ID."; same for client ("Application (client) ID").
  - start → poll success → `msappStatus` `done`; store record has `method: 'msapp'`, the IDs, `refreshToken`, `account: 'alex@example.com'`; file mode 0600; `~/.cursor/mcp.json` has `transcripts` with the relay key and no token anywhere in the file.
  - Entra unchanged: with Azure signed out, `transcripts` stays connected and Entra's existing tests still pass (run them).
  - relay: `tools/call transcripts_list` through `createRelay` returns lines (as `post()` does in the Entra service test).
  - **Review Focus 1:** a second service on the same `home` after `init()` answers `transcripts_list` with no new sign-in (one refresh request, the saved refresh token used).
  - refresh `invalid_grant` during a tool call → record gets `needsSignIn: true`, view state `needs-sign-in`, `needsAttention()` true.
  - `disconnect('transcripts')` → record is exactly `{ method: 'msapp', tenantId, clientId }`, agent entries removed, view `not-connected` with the IDs still present.
  - `test('transcripts')` → `lastTest.ok` true with `account`.
  - `server-connectors.test.js`-style check that the three routes need the settings session (401/403 without it).
- [ ] **Step 2: Run** both test files — Expected: FAIL.
- [ ] **Step 3: Implement.** In the service: replace the Entra-only `isBuiltin` branches with `ridesAzure(id) = CONNECTORS[id].signIn.includes('azure')`; `connected('transcripts') = !!rec.refreshToken`; `relayTarget` picks `serve` by id (`entra.handle` / `transcripts.handle`); `enable('transcripts')` throws "Sign in first." The msapp's `onRefreshToken` patches the record; tool-call `refused` patches `needsSignIn: true`; after `done`, a fold (like `foldLogin`) calls `transcripts.probe()`, saves `account`, clears `needsSignIn`, runs `sync()`. `init()` calls `restore()` when a saved refresh token exists. Env overrides per Global Constraints. If the file passes ~560 lines, move the transcripts glue into `connector-transcripts.js` as `attach(service internals)` instead.
- [ ] **Step 4: Run** the whole suite — Expected: all PASS (previous count + new).
- [ ] **Step 5: Commit** `git commit -m "Connectors: Teams transcripts on its own app sign-in"`.

### Task 5: The card

**Files:**
- Modify: `public/connectors.js` (new `transcriptsBody(c, st, now)`, dispatch in `paneHtml`, actions in `mountConnectors`)
- Modify: `public/style.css` only if a class is missing (reuse `ap-*` and the Azure code panel)
- Test: `test/connectors-ui.test.js` (append)

**Interfaces:**
- Consumes: view row fields from Task 4 (`state`, `tenantId`, `clientId`, `account`, `lastTest`, `error`, `agents`); routes from Task 4; existing `codePanelHtml(st, now)`, `testedLine`, `agentRowsHtml`, `errP`, `btn`.

- [ ] **Step 1: Write the failing tests** (render with `C.paneHtml({ view, picked: 'transcripts' })`):
  - signed out → inputs `#tr-tenant` and `#tr-client` (prefilled from the row), a `<details>` "What the app registration needs" listing the four scope names, "public client flows", "admin consent", and a **Sign in** button.
  - connecting with `st.code` → reuses the code panel (code, Copy code, `https://microsoft.com/devicelogin`, Cancel).
  - connected → "Signed in as alex@example.com", **Test**, **Sign out**, agent rows; no inputs.
  - needs-sign-in → **Sign in again** button with the IDs kept.
  - escaping: a row with `account: '<img src=x>'` and `error: '<b>x</b>'` renders escaped.
- [ ] **Step 2: Run** `… --test test/connectors-ui.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the card and its actions: Sign in → POST start with the two inputs, then poll `GET …/status` every 2 s until `done`/`failed` (same loop as Azure's); Cancel → POST cancel; Test / Sign out → existing `/:id/test` and `/:id/disconnect`.
- [ ] **Step 4: Run** the suite — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Connectors: Teams transcripts card"`.

### Task 6: End to end in a throwaway preview

**Files:**
- Create: `scripts/fake-msapp.js` (node:http only: devicecode + token endpoints at `/{tenant}/oauth2/v2.0/…`, Graph `/v1.0/me`, `getAllTranscripts(...)`, meeting lookup, VTT content; a control port to approve the pending code and to make the next refresh answer `invalid_grant`)
- Modify: `scripts/connectors-e2e.js` (case `C9`, and allow `C9` in the argument check)

- [ ] **Step 1: Start the preview** from the worktree as the earlier connectors previews were (`connectors-preview`, 127.0.0.1:7695, its own data dir under `/opt/vault/connectors-preview`, never :7684), with `CONNECTOR_UPSTREAM_TRANSCRIPTS_LOGIN` and `CONNECTOR_UPSTREAM_TRANSCRIPTS_GRAPH` pointing at the fake on 127.0.0.1:5557.
- [ ] **Step 2: Write C9:** run C1 first for the agents; then start with made-up GUIDs → code shown → approve via control port → status `done` → row `connected` as `alex@example.com` → both agent files have `transcripts` (relay URL + key, no token) → `claude mcp list` and `agent mcp list` from `/vault` and `/tmp` show it connected/ready → `transcripts_list` and `transcript_get` through the relay return the fake meeting's lines → restart the preview container, list again without signing in → set the fake to refuse refresh, call a tool → row `needs-sign-in` → disconnect → entries gone, IDs kept.
- [ ] **Step 3: Run** `node scripts/connectors-e2e.js C1 C9` — Expected: all PASS lines, exit 0.
- [ ] **Step 4: Commit** `git commit -m "Connectors e2e: Teams transcripts against a fake Microsoft (C9)"`; stop and remove the preview container and its data dir.

### Task 7: Hand-over

- [ ] **Step 1: Private words and IDs.** `git -C /opt/vault/board-transcripts diff main..HEAD | grep '^+' | grep -iE -f <(grep -v '^#' /opt/vault/board/scripts/private-words.txt)` prints nothing except `Ben` in `docs/`; `git diff main..HEAD | grep -Eio '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | sort -u` prints only the made-up test GUIDs. `git show --stat main..HEAD` has no `.superpowers/` files.
- [ ] **Step 2: Full suite** in the image — Expected: all PASS; record the count.
- [ ] **Step 3: Hand Ben the release line** (server and lib change, so a restart; his open VaultOS terminals end): `! cd /opt/vault/board && git merge --ff-only transcripts && docker restart vault-board`. Rollback: `git reset --hard <main sha before merge>` + restart.
- [ ] **Step 4: After his paste-back:** `/health` 200, `diff <(curl -s http://localhost:7684/connectors.js) public/connectors.js` empty, existing agent entries untouched. Remove the worktree and branch. Push to GitHub only on Ben's word.
- [ ] **Step 5: Ben's real test at work:** paste the two IDs, sign in, ask an agent to list this week's transcripts and fetch one. If sign-in fails with the public-client error, the app's owner turns on "Allow public client flows".
