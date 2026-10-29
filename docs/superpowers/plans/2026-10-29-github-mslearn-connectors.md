# GitHub and Microsoft Learn Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings → Connectors gains GitHub (pasted personal access token) and Microsoft Learn (no sign-in) as relayed connectors for Claude Code and the Cursor CLI, and Gitea leaves the Planned list.

**Architecture:** Both reuse the Atlassian path: agents call `http://127.0.0.1:<PORT>/mcp/<id>`, VaultOS adds the credential (Bearer token for GitHub, none for Microsoft Learn) and streams upstream. The relayed-connector credential code moves out of `lib/connector-service.js` into a new `lib/connector-relayed.js` and becomes generic over connector id; the relay learns that `''` means "connected, send no credential".

**Tech Stack:** Node 22 (host 24), Express 5, node:test, Node `fetch`, vanilla browser JS (UMD), Docker image `vault-board:latest` for the preview.

**Spec:** `docs/superpowers/specs/2026-10-29-github-mslearn-connectors-design.md` (on top of `docs/superpowers/specs/2026-10-29-connectors-design.md`).

## Global Constraints

- **Work in a worktree:** `/opt/vault/board-gh`, branch `connectors-gh`, from `main`. Never edit `/opt/vault/board`'s tree (live bind mounts) or touch the `vault-board` container.
- Preview: `connectors-preview` on `127.0.0.1:7695`, files in `/opt/vault/connectors-preview/`, image `vault-board:latest` (already has libicu72), the worktree's `server.js`, `lib`, `public`, `scripts` mounted read-only, env `CONNECTOR_UPSTREAM_ATLASSIAN=http://127.0.0.1:5555 CONNECTOR_UPSTREAM_GITHUB=http://127.0.0.1:5555 CONNECTOR_UPSTREAM_MSLEARN=http://127.0.0.1:5556`. Never :7684.
- Tests never touch a real home. Unit tests: `node --test <files>` on the host. Full suite in the image: `docker run --rm -v /opt/vault/board-gh:/src:ro --entrypoint bash vault-board:latest -lc 'cp -a /src /tmp/w && cd /tmp/w && rm -rf node_modules && cp -a /app/node_modules . && npm test'`.
- No new npm dependencies. No private names (employer, domains, LAN IPs) in code, tests or commit messages; fixtures use `alex@example.com`, login `alex-example`.
- Ids and names: connectors `github`, `mslearn`; agent entry names `github`, `mslearn`.
- Catalogue values, exactly: GitHub — label `GitHub`, by `Repos · issues · pull requests`, signIn `['token']`, base `https://api.githubcopilot.com`, mcpPath `/mcp/`, tokenHelp `https://github.com/settings/personal-access-tokens/new`. Microsoft Learn — label `Microsoft Learn`, by `Microsoft docs and code samples`, signIn `['none']`, base `https://learn.microsoft.com`, mcpPath `/api/mcp`.
- `PLANNED` ids in order: `notion`, `homeassistant`, `n8n`, `linear`, `sentry`.
- Screen copy, exactly as the spec's "The screen" section (GitHub card heading, body, field, buttons, sign-out note; Microsoft Learn body and buttons).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A GitHub token pasted with spaces or a trailing newline**, or a token that fails GitHub's check: the saved token is trimmed; a failing one is refused with GitHub's error and the previous token stays in use. Test in Task 3.
- **`''` ("connected, no credential") read as "not connected"** anywhere — relay, `missing()`, view state, sync's wanted set. Microsoft Learn must stay connected and send no `Authorization` header. Tests in Tasks 2 and 3.
- **A person who already has their own `github` MCP entry** in Claude or Cursor: left untouched and reported. Test in Task 3.
- **Turn off Microsoft Learn while an agent session is using it:** the next relay call gets the not-connected sentence at once. Test in Task 3.
- **The GitHub token never reaches `view()`, a log line or an agent config.** Test in Task 3.

---

### Task 1: Worktree, catalogue and the fake

**Files:**
- Modify: `lib/connectors.js`, `scripts/fake-mcp-oauth.js`
- Test: `test/connectors.test.js`, `test/fake-mcp-oauth.test.js`

**Interfaces:**
- Produces: `CONNECTORS.github`, `CONNECTORS.mslearn` (values in Global Constraints, `kind: 'relayed'`); `PLANNED` (five entries, keep their existing labels/one-liners/monos); `baseFor(id, env)` reads `env['CONNECTOR_UPSTREAM_' + id.toUpperCase()]` for every relayed connector; `entryFor(id, ctx)` returns the loopback relay entry for every relayed connector (`/mcp/<id>`, `X-VaultOS-Key`), Azure unchanged.
- Produces (fake): `startFake({ ..., noAuth = false })` — when true, `/v1/mcp` and `/api/mcp` and `/mcp/` all answer without any `Authorization`; a `get_me` tool returning `{ login: 'alex-example' }`; the MCP endpoint is also served at `/mcp/` and `/api/mcp` so one fake can stand in for any relayed connector; CLI flag `--no-auth`.

- [ ] **Step 1:** `git -C /opt/vault/board worktree add /opt/vault/board-gh -b connectors-gh`, then `ln -s /opt/vault/board/node_modules /opt/vault/board-gh/node_modules` and add `/node_modules` to `/opt/vault/board/.git/info/exclude`.
- [ ] **Step 2: Failing tests:** `PLANNED has the five ids in order`; `github and mslearn are relayed with the exact catalogue values`; `baseFor reads CONNECTOR_UPSTREAM_<ID> for github and mslearn, not for azure`; `entryFor github and mslearn point at the loopback relay with the key`; fake: `noAuth answers tools/list with no Authorization`, `get_me returns alex-example`, `the MCP endpoint answers at /mcp/ and /api/mcp`. Update the old "eight ids" test.
- [ ] **Step 3: Run** `node --test test/connectors.test.js test/fake-mcp-oauth.test.js` — expect FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** — expect PASS. **Commit:** `Connectors: GitHub and Microsoft Learn in the catalogue; Gitea leaves Planned`.

### Task 2: The relay sends no credential for `''`

**Files:**
- Modify: `lib/connector-relay.js` (~135-136, ~183-184, the Target comment ~91-95)
- Test: `test/connector-relay.test.js`

**Interfaces:**
- Produces: Target contract — `authorization()` returns a string (`''` = connected, send no `Authorization` header) or `null` (not signed in). Only `null` triggers the not-signed-in answers. A `401` with `''` goes straight to the expired path (there is nothing to renew; `renew` is not called). `mcpProbe(url, authorization)` sends no header when authorization is `''`.

- [ ] **Step 1: Failing tests:** `'' sends no Authorization upstream and forwards normally` (assert the fake in `noAuth` mode saw no `authorization` header); `'' is never treated as not connected` (initialize goes upstream, not answered locally); `a 401 with '' answers the expired sentence without calling renew`; `mcpProbe with '' lists the tools of a noAuth fake`.
- [ ] **Step 2: Run** `node --test test/connector-relay.test.js` — expect FAIL.
- [ ] **Step 3: Implement** (`auth === null` instead of `!auth`; omit the header for `''`).
- [ ] **Step 4: Run** — expect PASS. **Commit:** `Connectors: the relay can forward without a credential`.

### Task 3: Generic relayed connectors in the service

**Files:**
- Create: `lib/connector-relayed.js`
- Modify: `lib/connector-service.js` (move the relayed credential code out; generalise `relayTarget`, `test`, `disconnect`, sync's wanted set, `view` rows)
- Test: `test/connector-service.test.js`, `test/connector-fixes.test.js` (keep green), new cases in `test/connector-service.test.js`

**Interfaces:**
- Consumes: Task 1 catalogue and fake; Task 2 contract.
- Produces (`lib/connector-relayed.js`): `createRelayed({ store, env, fetch, now, oauth })` → `{ authorization(id), renew(id, rejected), markNeedsSignIn(id), missing(id), connected(id), credentialFor(id) }`, holding the existing Atlassian OAuth refresh rules unchanged (R11, R16, the `same()` guard, 60 s early refresh) plus: method `token` with `key` → `Bearer <key>`, with `email`+`token` → Basic (Atlassian); method `none` → `''`.
- Produces (service): `saveToken(id, input)` — Atlassian `{ email, token }` | `{ key }`; GitHub `{ token }` stored as `{ method: 'token', key }`; trims input; probes first, keeps the previous method on failure (throws `ConnectorError` with the upstream's error text); `enable(id)` for `signIn: ['none']` → stores `{ method: 'none' }`, tests, syncs; `relayTarget(id)` for every relayed id; `test(id)` probes any relayed connector, identity best-effort per id (`atlassianUserInfo` / `getAccessibleAtlassianResources` for atlassian, `get_me` → `account = login` for github, none for mslearn); `disconnect(id)` for github/mslearn deletes the record and syncs (no revoke); `view()` rows for github and mslearn with `tokenHelp` (github) and `lastTest.tools`. `atlassianToken` remains as `(input) => saveToken('atlassian', input)` only if a route still needs it. `connector-service.js` and `connector-relayed.js` each stay under ~400 lines.

- [ ] **Step 1: Failing tests** (temp home, fake with `CONNECTOR_UPSTREAM_GITHUB` / `CONNECTOR_UPSTREAM_MSLEARN`; a second fake in `noAuth` mode for mslearn):
  - `github: a token with surrounding whitespace is trimmed, probed and saved; view says connected as alex-example`.
  - `github: a token that fails the probe keeps the previous token and throws the upstream error`.
  - `github: a 401 later shows needs-sign-in but keeps sending the token; a good Test clears it`.
  - `github: the token never appears in view(), and cursor's entry holds only the relay url and key`.
  - `github: an existing hand-written github entry in cursor is left alone and reported`.
  - `mslearn: enable → connected with 3 tools, cursor gets the entry, the relay sends no Authorization`.
  - `mslearn: disconnect → entry removed, the next relay call gets the not-connected sentence`.
  - `planned in view() has the five ids`.
  - Every existing service and fixes test still passes.
- [ ] **Step 2: Run** `node --test test/connector-service.test.js test/connector-fixes.test.js` — expect FAIL on the new cases.
- [ ] **Step 3: Implement** the split and the generic paths.
- [ ] **Step 4: Run** the whole connector set: `node --test test/connector*.test.js test/connectors*.test.js test/fake-mcp-oauth.test.js` — expect PASS. **Commit:** `Connectors: relayed connectors are generic; GitHub token and Microsoft Learn in the service`.

### Task 4: Routes

**Files:**
- Modify: `server.js` (connector routes near the existing `/api/connectors/atlassian/token`)
- Test: `test/server-connectors.test.js`

**Interfaces:**
- Produces: `POST /api/connectors/:id/token` (settingsGuard; replaces `/api/connectors/atlassian/token`; 400 `ConnectorError` for an id whose `signIn` lacks `token`); `POST /api/connectors/:id/enable` (settingsGuard; 400 for an id whose `signIn` isn't `['none']`). Unknown and prototype ids → 400, as today.

- [ ] **Step 1: Failing tests:** `token route saves a github token (200) and refuses mslearn and azure (400)`; `enable route turns on mslearn (200) and refuses github (400)`; `both routes need a session (401)`; `the atlassian token flow still works through /api/connectors/atlassian/token` (now served by the `:id` route).
- [ ] **Step 2: Run** `node --test test/server-connectors.test.js` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test test/server-connectors.test.js test/server-security.test.js` — expect PASS (ws-dependent server tests fail on the host before and after; they run in the image in Task 6). **Commit:** `Connectors: token and enable routes for any relayed connector`.

### Task 5: The pane and the marks

**Files:**
- Modify: `public/connectors.js`, `public/agent-marks.js`, `public/styles.css` (only if the 2×2 Ready grid needs it)
- Test: `test/connectors-ui.test.js`, `test/agent-marks.test.js`

**Interfaces:**
- Consumes: view rows for `github` and `mslearn` (Task 3), routes (Task 4).
- Produces: Ready shows four tiles (Atlassian, Azure, GitHub, Microsoft Learn) in two rows of two; `githubBody(c, st)` and `mslearnBody(c, st)` with the spec's exact copy; the Atlassian token save posts to `/api/connectors/atlassian/token` (unchanged URL, now the generic route); GitHub posts `{ token }` to `/api/connectors/github/token`; Microsoft Learn's Turn on posts to `/api/connectors/mslearn/enable`, Turn off to `/api/connectors/mslearn/disconnect`; GitHub's Sign out uses `disconnect` and shows the sign-out note. Marks: `AgentMarks.connector('github')` (Simple Icons GitHub path, CC0), `AgentMarks.connector('mslearn')` (a stroked book glyph); 24×24, `currentColor`, distinct from every other mark. Every server string escaped.

- [ ] **Step 1: Failing tests:** `paneHtml shows four Ready tiles and five Planned`; `github not connected shows the token card copy and a password input`; `github connected shows Signed in as, Replace token, Sign out and the sign-out note`; `mslearn not connected shows Turn on; connected shows Connected · 3 tools and Turn off`; `markup in a github login is escaped`; marks: `github and mslearn connector marks are single-colour 24px and distinct`.
- [ ] **Step 2: Run** `node --test test/connectors-ui.test.js test/agent-marks.test.js` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Look at it.** Write `/opt/vault/connectors-preview/compose.yml` (Global Constraints values; `user: "1000:1000"`, `init: true`, named home volume), `docker compose -f /opt/vault/connectors-preview/compose.yml up -d`, start two fakes inside it (`node /app/scripts/fake-mcp-oauth.js --port 5555` and `--port 5556 --no-auth`), finish setup through the API, and screenshot Settings → Connectors (dark and sepia, 1600 and 390 px) with GitHub not connected, GitHub connected via token `svc-key`, Microsoft Learn off and on. Check `df -h /` first; stop if under 3 GB.
- [ ] **Step 6: Commit:** `Connectors: GitHub and Microsoft Learn in the Settings pane`.

### Task 6: Real Microsoft Learn, e2e, docs

**Files:**
- Modify: `scripts/connectors-e2e.js` (add C7 GitHub and C8 Microsoft Learn), `CLAUDE.md` (Connectors section), `README.md` (Connectors paragraph), the spec's decisions (a "Built" note)

- [ ] **Step 1: Real Microsoft Learn check:** in the preview, unset `CONNECTOR_UPSTREAM_MSLEARN` (recreate the container without it), Turn on Microsoft Learn, and confirm `GET /api/connectors` shows it connected with 3 tools and that `microsoft_docs_search` with query `azure key vault rotation` through the relay returns results. Record the outcome in the spec.
- [ ] **Step 2: E2E:** C7 — save a GitHub token against the fake (`svc-key`), both agents get `github`, `claude mcp list` / `agent mcp list` show it from `/vault` and `/tmp`, `get_me` through the relay returns `alex-example`, sign out removes it. C8 — Microsoft Learn on/off with the same agent checks. Agents may need installing in the fresh preview (agent picker commands; check disk first). Run `node scripts/connectors-e2e.js C1 C2 C3 C4 C5 C6 C7 C8` — expect all pass.
- [ ] **Step 3: Full suite in the image** (Global Constraints command) — expect all pass; report counts.
- [ ] **Step 4: Docs:** CLAUDE.md Connectors section (GitHub token method, `''` = no credential, `connector-relayed.js`, the generic routes, the second fake); README paragraph names GitHub and Microsoft Learn.
- [ ] **Step 5: Private words:** `git -C /opt/vault/board-gh diff main..HEAD | grep '^+' | grep -E -f <(grep -v '^#' /opt/vault/board-gh/scripts/private-words.txt)` prints nothing except `Ben` in `docs/`.
- [ ] **Step 6: Commit:** `Connectors: GitHub and Microsoft Learn end to end, and docs`.
