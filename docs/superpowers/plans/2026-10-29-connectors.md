# Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings → Connectors connects Atlassian and Azure once, and every installed Claude Code and Cursor CLI can use them from any folder, with no extra ports and no credentials in the agents' config.

**Architecture:** VaultOS keeps sign-ins in `~/.vaultos/connectors.json`. Atlassian is *relayed*: VaultOS does the OAuth itself (redirect back to its own origin) and agents call `http://127.0.0.1:<PORT>/mcp/atlassian`, which checks a loopback peer plus `X-VaultOS-Key`, adds the credential and streams to `https://mcp.atlassian.com/v1/mcp`. Azure is *local*: each agent runs `azmcp server start --read-only`, which uses one shared `az login --use-device-code` that VaultOS drives. `lib/connector-agents.js` writes one user-wide entry per connector into Claude Code (`claude mcp add-json --scope user`) and the Cursor CLI (`~/.cursor/mcp.json`), touching only entries it wrote.

**Tech Stack:** Node 22 (host has 24), Express 5, node:test, Node `fetch`/`crypto`/`stream` (no new npm dependencies), vanilla browser JS as UMD modules shared with tests, Docker image built from this repo's Dockerfile, puppeteer + host Chrome for screenshots.

**Spec:** `docs/superpowers/specs/2026-10-29-connectors-design.md`

## Global Constraints

- **Work in a worktree, never in `/opt/vault/board`'s working tree.** The live container bind-mounts that tree's `server.js`, `lib/` and `public/`; `public/` edits go live at once. Worktree `/opt/vault/board-connectors`, branch `connectors`. Nothing is pushed or merged until Task 11.
- Never e2e or test against :7684. The preview is `connectors-preview` on `127.0.0.1:7695`, files in `/opt/vault/connectors-preview/`, image `vaultos:connectors` built from the worktree.
- Tests never touch a real home: every writer, store and service test uses a temp `HOME`.
- Unit tests: `node --test test/<file>.test.js` on the host. Full suite (terminal tests need the image): `docker run --rm -v "$PWD":/src:ro --entrypoint bash vaultos:connectors -lc 'cp -a /src /tmp/w && cd /tmp/w && rm -rf node_modules && cp -a /app/node_modules . && npm test'`.
- No new npm dependencies.
- The repo is public: no employer, domain, LAN IP or real workspace names in code, tests, fixtures or commit messages. Fixtures use `example.atlassian.net`, `alex@example.com`, tenant `00000000-0000-0000-0000-000000000000`. Before Task 11, `git diff main..connectors | grep '^+' | grep -E -f <(grep -v '^#' scripts/private-words.txt)` prints nothing except `Ben` in `docs/`.
- Connector ids `atlassian`, `azure`. Agent ids with writers: `claude`, `cursor`. Entry names written into agents: `atlassian`, `azure`.
- Store path `~/.vaultos/connectors.json`, file mode `0600`, folder `0700`, `version: 1`.
- Relay: path `/mcp/:id`; header `X-VaultOS-Key`; JSON-RPC error code `-32001`; never answers an agent `401`.
- Relay messages, exactly: `${label} isn't connected yet. Open Settings → Connectors in VaultOS to connect it.` and `${label} sign-in has run out. Open Settings → Connectors in VaultOS to sign in again.`
- Atlassian: base `https://mcp.atlassian.com`, MCP path `/v1/mcp`, metadata `/.well-known/oauth-authorization-server`, redirect path `/api/connectors/atlassian/callback`, pending sign-ins live 10 minutes, refresh 60 s before `expires_at`. Test-only override: env `CONNECTOR_UPSTREAM_ATLASSIAN` replaces the base.
- Screen copy, exactly as the mockup (https://claude.ai/artifact/H1k2P2ngwaauBR75Wzz6F6): nav "Connectors"; heading "Connectors"; lead "Connect a service once. VaultOS adds it to every agent it can set up, so it works in every folder. Your agents never see your passwords or tokens."; tiers "Ready" and "Planned" + " · not built yet"; state chips "Not installed", "Not connected", "Connecting…", "Connected", "Sign in again", "Error"; agent chips "Added", "Not installed", "Has its own entry", "No connectors in Pi"; sub-heading "Added to your agents"; hint "Installing another agent later? VaultOS adds your connectors to it straight away."
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **The agent already has its own `atlassian` entry, or `~/.cursor/mcp.json` is hand-edited and invalid JSON.** VaultOS writes nothing to that agent, keeps the file byte-for-byte, and the row says why. Test in Task 6.
- **Two agents call the relay together while the Atlassian token is expiring.** One refresh request reaches Atlassian, both calls succeed. Test in Task 5.
- **The relay is reached from outside the container** (Docker port forward, a proxy) **or with a wrong or missing key.** `403`, nothing forwarded, and the key header is never sent upstream. Tests in Tasks 5 and 9.
- **Upstream answers as an SSE stream, and the agent hangs up mid-stream.** Events reach the agent as they arrive (not buffered to the end), and the upstream request is aborted. Test in Task 5.
- **Server text with markup** (an Atlassian account or site name, az's error output, a folder path in the per-folder note) shows as literal text in the Connectors pane. Test in Task 10.

---

### Task 1: Worktree, preview image and the four spikes

Facts first. Tasks 6, 7 and 10 copy values from this task's results.

**Files:**
- Create: `scripts/connector-probe.sh`
- Create: `/opt/vault/connectors-preview/compose.yml` (outside the repo)
- Modify: `Dockerfile` (runtime `apt-get install` line: add `libicu72`)
- Modify: `docs/superpowers/specs/2026-10-29-connectors-design.md` ("Decisions made during implementation")

**Interfaces:**
- Produces: in the spec's decisions section, (1) the Azure CLI install command and its size/time, (2) whether `azmcp` uses the `az` login or the azd fallback was needed, (3) the Cursor CLI's behaviour with a user-wide `url`+`headers` entry and a `command` entry from two folders, including any approval prompt and the flag or config that avoids it, (4) the exact JSON Claude Code stores in `~/.claude.json` `mcpServers` after `claude mcp add-json --scope user` with a custom header, and whether a JSON-RPC error makes it start OAuth.

- [ ] **Step 1: Create the worktree:** `git -C /opt/vault/board worktree add /opt/vault/board-connectors -b connectors`. All later paths are relative to it.
- [ ] **Step 2: Add `libicu72` to the Dockerfile's runtime install line**, build `docker build -t vaultos:connectors /opt/vault/board-connectors`. Expected: build succeeds.
- [ ] **Step 3: Write `scripts/connector-probe.sh <azure-install|cursor|claude>`**, shaped like `scripts/agent-probe.sh` (a throwaway `vaultos:connectors` container as its default user, `bash -lc`):
  - `azure-install`: `npm install -g --prefix ~/.local @azure/mcp`; then `python3 -m venv ~/.local/share/azure-cli && ~/.local/share/azure-cli/bin/pip install azure-cli && ln -sf ~/.local/share/azure-cli/bin/az ~/.local/bin/az`; prints `az --version | head -1`, `azmcp server start --help | head -3`, `du -sh ~/.local/share/azure-cli ~/.local/lib/node_modules/@azure`, and elapsed seconds.
  - `cursor`: installs the Cursor CLI, writes `~/.cursor/mcp.json` with one `{ "url": "http://127.0.0.1:9/mcp/x", "headers": { "X-VaultOS-Key": "k" } }` entry and one `{ "command": "true", "args": [] }` entry, runs `agent mcp --help`, then `agent mcp list` from `/tmp/a` and `/tmp/b`, printing everything.
  - `claude`: installs Claude Code, runs `claude mcp add-json --scope user probe '{"type":"http","url":"http://127.0.0.1:9/mcp/x","headers":{"X-VaultOS-Key":"k"}}'`, prints `mcpServers` from `~/.claude.json`, then `claude mcp list` from `/tmp/a` and `/tmp/b`.
- [ ] **Step 4: Run all three.** Run: `for p in azure-install cursor claude; do bash scripts/connector-probe.sh $p; done`. Expected: `azure-install` prints an `azure-cli` version and azmcp's usage line; `cursor` and `claude` list the entries from both folders (a failed connection is expected, nothing listens on :9).
- [ ] **Step 5: Spike 2 with Ben (pause here).** Start a container from `vaultos:connectors` with the Azure install from Step 3, run `az login --use-device-code` in it, and ask Ben to enter the code with a personal Azure login. Then run an MCP `initialize` + `tools/list` + one read call (`group_list` or the namespace tool `group`) against `azmcp server start --read-only` over stdio (a 20-line node script piped to it). Expected: a tool list and a read answer. If it fails with a credential error, retry with `AZURE_TOKEN_CREDENTIALS=AzureCliCredential`, then with azd (`azd auth login --use-device-code`); record which works.
- [ ] **Step 6: Spike 4's second half.** With the fake from Task 3 not built yet, use a 15-line node server on :9 inside the `claude` probe container that answers every POST with `200 {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"x"}}`; run `claude mcp list` and confirm it reports a failure without printing an OAuth/authorize URL.
- [ ] **Step 7: Write the results into the spec's decisions section** (the four items in Interfaces). If Cursor needs approval, record the exact flag or file, and say which task carries it (Task 6 writes a file, or Task 10 notes it in the panel).
- [ ] **Step 8: Write `/opt/vault/connectors-preview/compose.yml`**: project `connectors-preview`, image `vaultos:connectors`, container `connectors-preview`, `init: true`, ports `127.0.0.1:7695:8080`, env `VAULT_DIR=/vault DATA_DIR=/data PORT=8080 SECURE_COOKIE=0 TERMINAL=1 TODAY_QUOTES=0 CONNECTOR_UPSTREAM_ATLASSIAN=http://127.0.0.1:5555`, volumes `./vault:/vault`, `./data:/data`, named volume `connectors-preview-home` at the image's home, and read-only mounts of the worktree's `server.js`, `lib`, `public`, `scripts` over `/app/...`. Don't start it yet.
- [ ] **Step 9: Commit** `Dockerfile`, `scripts/connector-probe.sh` and the spec: `git commit -m "Connectors: spikes for Azure, Cursor and Claude; libicu72 for the Azure server"`.

### Task 2: Catalogue and store

**Files:**
- Create: `lib/connectors.js`, `lib/connector-store.js`
- Test: `test/connectors.test.js`, `test/connector-store.test.js`

**Interfaces:**
- Produces (`lib/connectors.js`):
  - `CONNECTORS`: `{ atlassian: { id, label: 'Atlassian', by: 'Jira · Confluence', kind: 'relayed', signIn: ['oauth', 'token'], base: 'https://mcp.atlassian.com', mcpPath: '/v1/mcp', metadataPath: '/.well-known/oauth-authorization-server', tokenHelp: 'https://id.atlassian.com/manage-profile/security/api-tokens' }, azure: { id, label: 'Azure', by: 'Subscriptions · resources · Key Vault', kind: 'local', signIn: ['device-code'], detect: ['az', 'azmcp'], install: <Task 1's command> } }`
  - `PLANNED`: eight `{ id, label, by, mono }` in this order: github GitHub "Repos · issues · PRs" GH; notion Notion "Pages · databases" N; gitea Gitea "Your own Git server" Gt; homeassistant "Home Assistant" "Devices · automations" HA; n8n n8n "Run your workflows" n8n; linear Linear "Issues · projects" L; sentry Sentry "Errors · releases" S; mslearn "Microsoft Learn" "Docs search · no sign-in" ML.
  - `baseFor(id, env = process.env) → string` (the env override for atlassian, else `CONNECTORS[id].base`).
  - `entryFor(id, { port, key, home, allowChanges }) → { kind: 'http', url, headers } | { kind: 'stdio', command, args }`: atlassian → `url: http://127.0.0.1:${port}/mcp/atlassian`, `headers: { 'X-VaultOS-Key': key }`; azure → `command: ${home}/.local/bin/azmcp`, `args: ['server', 'start', ...(allowChanges ? [] : ['--read-only'])]` (plus anything Task 1 recorded, such as an env).
- Produces (`lib/connector-store.js`):
  - `STORE_REL = '.vaultos/connectors.json'`
  - `createStore({ home, now = Date.now }) → { load(): Promise<State>, get(): State, update(fn: (draft: State) => void): Promise<State>, wasReset(): boolean }` where `State = { version: 1, relayKey: string, connectors: { [id]: object }, written: { [agentId]: { [name]: string } } }`. `update` runs writes one at a time in arrival order, on a deep copy, then `atomicWrite`s and `chmod 0600`.

- [ ] **Step 1: Write the failing tests.**
  - `connectors.test.js`: `every connector has id, label, by, kind and signIn`; `PLANNED has the eight ids in order` (`['github','notion','gitea','homeassistant','n8n','linear','sentry','mslearn']`); `baseFor uses CONNECTOR_UPSTREAM_ATLASSIAN only for atlassian`; `entryFor atlassian points at the loopback relay with the key` (`deepEqual` with port 8080, key `k`); `entryFor azure is read-only unless allowChanges` (args with and without `--read-only`, command `/h/.local/bin/azmcp`).
  - `connector-store.test.js`: `load on an empty home creates the file with a 43-character relayKey, mode 0600, folder 0700`; `the relayKey survives a second load`; `update writes are serialised` (two `update` calls started together both land: `connectors.a` and `connectors.b` present); `a damaged file is moved to connectors.json.bad-<now> and load starts empty with wasReset() true` (for `{` and for `{"version":2}`); `get() returns a copy` (mutating it doesn't change the next `get()`).
- [ ] **Step 2: Run them.** Run: `node --test test/connectors.test.js test/connector-store.test.js`. Expected: FAIL, cannot find module.
- [ ] **Step 3: Implement both modules.** `newKey` is `crypto.randomBytes(32).toString('base64url')`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "Connectors: the catalogue and the sign-in store"`.

### Task 3: A fake Atlassian for tests and the preview

**Files:**
- Create: `scripts/fake-mcp-oauth.js`
- Test: `test/fake-mcp-oauth.test.js`

**Interfaces:**
- Produces: `startFake({ port = 0, host = '127.0.0.1' } = {}) → Promise<{ base, stop(), state, setMode(mode) }>` (module export) and `node scripts/fake-mcp-oauth.js --port 5555` (CLI). Endpoints:
  - `GET /.well-known/oauth-authorization-server` → the same shape as Atlassian's (spec, "Facts").
  - `POST /v1/register` → `{ client_id: 'fake-<n>', redirect_uris }`; when `state.refuseRedirect` matches the URI, `400 { error: 'invalid_redirect_uri' }`.
  - `GET /v1/authorize` → `302` to `redirect_uri?code=<code>&state=<state>` (auto-approves; checks `code_challenge_method=S256`).
  - `POST /v1/token` (form body) → `authorization_code` (verifies PKCE S256) and `refresh_token` grants, `{ access_token, refresh_token, expires_in }`; counts refreshes in `state.refreshes`.
  - `POST /v1/token` with `token=` and `token_type_hint` → revoke, recorded in `state.revoked`.
  - `POST /v1/mcp` → needs `Authorization: Bearer <live access token>` or `Basic` of `alex@example.com:tok` or `Bearer svc-key`, else `401`. Answers `initialize`, `notifications/initialized` (`202`), `tools/list` (two tools: `atlassianUserInfo`, `getAccessibleAtlassianResources`), `tools/call` (`atlassianUserInfo` → `{ email: 'alex@example.com' }`; `getAccessibleAtlassianResources` → `[{ url: 'https://example.atlassian.net' }]`). `tools/list` answers as `text/event-stream` (one `data:` event), the rest as JSON. Echoes `Mcp-Session-Id`. Records every request's headers in `state.seen`.
  - `setMode('expire')` makes the current access token fail with `401`; `setMode('refuse-refresh')` makes refresh grants `400`; `setMode('slow-sse')` sends `tools/list` as two events 300 ms apart.

- [ ] **Step 1: Write the failing test** `test/fake-mcp-oauth.test.js`: `the full code flow yields a token that tools/list accepts` (register → authorize redirect → token with the verifier → POST `tools/list` with the token parses two tools from the SSE body); `a wrong verifier is refused`; `expire then refresh gives a working token and counts one refresh`.
- [ ] **Step 2: Run it.** Run: `node --test test/fake-mcp-oauth.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement it** with `node:http` only (no Express), so it runs inside the preview image as-is.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "Connectors: a fake Atlassian (OAuth and MCP) for tests"`.

### Task 4: The Atlassian OAuth client

**Files:**
- Create: `lib/connector-oauth.js`
- Test: `test/connector-oauth.test.js`

**Interfaces:**
- Consumes: `startFake` (Task 3) in tests.
- Produces, all taking `{ fetch = globalThis.fetch, now = Date.now }` as the last argument where they call out:
  - `class OAuthError extends Error { code }` with codes `'discovery'`, `'register'`, `'redirect-refused'`, `'exchange'`, `'refresh-refused'`.
  - `discover(base) → Promise<Metadata>`: GETs `base + metadataPath`; `OAuthError('discovery')` if `registration_endpoint` is missing or `S256` isn't offered.
  - `registerClient(meta, redirectUri) → Promise<{ client_id, redirect_uri }>`: POST JSON body exactly `{ client_name: 'VaultOS', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }`. A `400` whose body mentions `redirect` → `'redirect-refused'`.
  - `pkcePair() → { verifier, challenge }` (verifier: 32 random bytes base64url; challenge: base64url SHA-256 of the verifier).
  - `authorizeUrl(meta, { clientId, redirectUri, state, challenge }) → string` with `response_type=code`, `code_challenge_method=S256`.
  - `exchangeCode(meta, { clientId, redirectUri, code, verifier }) → Promise<Tokens>` where `Tokens = { access_token, refresh_token, expires_at }` (`expires_at = now() + expires_in * 1000`).
  - `refreshTokens(meta, { clientId, refreshToken }) → Promise<Tokens>` (keeps the old refresh token when none comes back; `400`/`401` → `'refresh-refused'`).
  - `revoke(meta, { clientId, token }) → Promise<boolean>`.
  - `createPending({ ttlMs = 600000, now }) → { add(nonce, data) → state, take(nonce, state) → data | null }`: `state` is 16 random bytes base64url; `take` is single-use, needs the same `nonce`, and returns null after `ttlMs`.

- [ ] **Step 1: Write the failing tests** against the fake: `discover reads the fake's metadata`; `registerClient sends the exact body` (assert from `fake.state.seen`); `a refused redirect is OAuthError redirect-refused`; `pkcePair challenge is the S256 of the verifier`; `authorizeUrl carries every parameter`; `exchangeCode then refreshTokens, expires_at from the injected now`; `refreshTokens refused is refresh-refused` (`setMode('refuse-refresh')`); `revoke reaches the fake`; `pending: single use, wrong nonce null, expired null` (inject `now`).
- [ ] **Step 2: Run them.** Run: `node --test test/connector-oauth.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Token requests are `application/x-www-form-urlencoded` with `client_id`; no client secret.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "Connectors: Atlassian sign-in (registration, PKCE, refresh, revoke)"`.

### Task 5: The relay and the MCP probe

**Files:**
- Create: `lib/connector-relay.js`
- Test: `test/connector-relay.test.js`

**Interfaces:**
- Consumes: `startFake` in tests; nothing from `lib/` beyond `node:` modules.
- Produces:
  - `REQ_HEADERS = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']`, `RES_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control']`.
  - `isLoopback(addr) → boolean` (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`).
  - `keyMatches(given, key) → boolean` (`crypto.timingSafeEqual` on equal-length buffers; false for missing).
  - `messages = { notConnected(label), expired(label) }` (Global Constraints wording).
  - `createRelay({ getKey: () => string, target: (id) => Target | null, fetch, log }) → (req, res) => Promise<void>` where `Target = { label, url, authorization(): Promise<string | null>, renew(): Promise<string | null>, markNeedsSignIn(): void }`. Flow: non-loopback peer → `403`; key mismatch → `403`; unknown id → `404`; read the body (POST, cap 4 MB → `413`); `authorization()` null → for POST, `200` JSON-RPC error `-32001` `notConnected` (or `202` empty for a notification), for GET `405`; forward with `Authorization` set and only `REQ_HEADERS` copied; upstream `401` → `renew()`, retry once; still `401` or `renew()` null → `markNeedsSignIn()` and the `expired` error; otherwise copy status, `RES_HEADERS` and stream the body (`Readable.fromWeb(r.body).pipe(res)`); `req` close aborts the upstream fetch (`AbortController`). A refused peer is logged with `log` at most once a minute per address.
  - `mcpProbe(url, authorization, { fetch }) → Promise<{ ok, tools: string[], call(name, args) → Promise<object>, error? }>`: `initialize` (protocolVersion `2025-06-18`, clientInfo `VaultOS`), `notifications/initialized`, `tools/list`, carrying `Mcp-Session-Id`; parses JSON or the first `data:` event of an SSE body.
  - `serialised(fn) → fn'`: concurrent calls share one in-flight promise (used by the service for `renew`).

- [ ] **Step 1: Write the failing tests.** Run the relay on a real `http.createServer` on `127.0.0.1:0` with a `target` backed by the fake and a fixed key.
  - `refuses a non-loopback peer`: call the handler with a fake `req.socket.remoteAddress = '172.17.0.1'` → `403`, `fake.state.seen` empty.
  - `refuses a missing or wrong key, and never sends the key upstream`: a good call's upstream headers have no `x-vaultos-key`, and none of `cookie`, `x-forwarded-for`, `authorization` from the agent.
  - `not connected answers 200 with the -32001 message and the request id`.
  - `GET without a sign-in is 405`.
  - `expired token: renew, retry once, success`.
  - `renew refused: markNeedsSignIn called once, the expired message, status 200, never 401`.
  - `two calls during expiry make one refresh` (relay `target.renew` wrapped in `serialised`; `fake.state.refreshes === 1`, both calls 200).
  - `SSE streams as it arrives` (`setMode('slow-sse')`: the first event is readable before the second is sent).
  - `an agent hang-up aborts upstream` (destroy the client socket mid-stream; the fake sees its response closed).
  - `mcpProbe lists the fake's two tools and calls one`.
- [ ] **Step 2: Run them.** Run: `node --test test/connector-relay.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "Connectors: the agent relay and the MCP probe"`.

### Task 6: Agent writers and sync

**Files:**
- Create: `lib/connector-agents.js`
- Test: `test/connector-agents.test.js`

**Interfaces:**
- Consumes: `entryFor` output shape (Task 2); Task 1's decisions for the Claude stored shape and any Cursor approval file.
- Produces:
  - `class AgentConfigError extends Error` (message for the person, such as ``Couldn't read `~/.cursor/mcp.json` ``).
  - `toClaude(entry)`, `toCursor(entry)`: `http` → Claude `{ type: 'http', url, headers }`, Cursor `{ url, headers }`; `stdio` → Claude `{ type: 'stdio', command, args }`, Cursor `{ command, args }`.
  - `entryHash(agentEntry) → string`: SHA-256 hex of the JSON of `{ type, url, headers, command, args }` with keys sorted and missing ones dropped.
  - `claudeWriter({ home, run }) → Writer`, `cursorWriter({ home }) → Writer`, where `Writer = { id, label, list(): Promise<{ user: { [name]: object }, perFolder: { [name]: string[] } }>, put(name, agentEntry): Promise<void>, remove(name): Promise<void>, translate(entry) }`. Claude: `list` reads `~/.claude.json` (`mcpServers` and `projects[*].mcpServers`, read-only); `put` runs `claude mcp remove --scope user <name>` (failure ignored) then `claude mcp add-json --scope user <name> <json>`; `remove` runs the first. `run(cmd) → Promise<{ code, stdout, stderr }>`, shell-quoting with `shellQuote` from `lib/agents.js`. Cursor: read-modify-write of `~/.cursor/mcp.json` keeping every other key, `JSON.stringify(x, null, 2) + '\n'`, `atomicWrite`; invalid JSON → `AgentConfigError` and no write.
  - `syncAgents({ wanted: { [name]: entry }, writers: Writer[], written }) → Promise<{ written, agents: { [agentId]: { ok, error?, foreign: string[], perFolder: { [name]: string[] } } } }>`. Per writer: an entry is *ours* when `written[agent][name] === entryHash(current)`. Wanted and absent → `put`, record the hash. Wanted and ours but changed → `put`. Wanted and present but not ours → leave it, add to `foreign`. In `written` but not wanted → `remove` if still ours, drop from `written` either way. A writer that throws → `{ ok: false, error }` for that agent, its `written` unchanged, the others carry on.

- [ ] **Step 1: Write the failing tests** (temp home, fake `run` recording commands):
  - `toClaude and toCursor shapes` for both kinds.
  - `entryHash ignores key order`.
  - `cursor put keeps other servers and keys byte-for-byte` (seed `{ "mcpServers": { "mine": { "command": "x" } }, "other": 1 }`).
  - `cursor invalid JSON: AgentConfigError, file untouched` (compare bytes before and after).
  - `claude put runs remove then add-json with --scope user and quoted JSON`.
  - `claude list reports per-folder entries of the same name` (seed `~/.claude.json` with `projects: { "/w/a": { mcpServers: { atlassian: {} } } }`).
  - `sync adds, rewrites when changed, removes when unwanted`.
  - `sync leaves a foreign same-named entry alone and reports it`.
  - `sync: one writer throwing doesn't stop the other`.
- [ ] **Step 2: Run them.** Run: `node --test test/connector-agents.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** If Task 1 recorded a Cursor approval file or flag, the Cursor writer writes it with the entry and the test covers it.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "Connectors: write user-wide entries into Claude Code and the Cursor CLI"`.

### Task 7: Azure helpers

**Files:**
- Create: `lib/connector-azure.js`
- Test: `test/connector-azure.test.js`

**Interfaces:**
- Consumes: Task 1's install command and credential decision.
- Produces:
  - `runCapture(cmd, { timeout = 30000 } = {}) → Promise<{ code, stdout, stderr }>` (`bash -lc`, like `defaultRun` in `lib/agents.js` but keeping the output).
  - `parseDeviceCode(text) → { url, code } | null`, matching az's line `To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.` (code `[A-Z0-9]{8,12}`; tolerate a different URL).
  - `createDeviceLogin({ spawn, now = Date.now, ttlMs = 900000 }) → { start({ tenant } = {}) → Promise<{ url, code, expiresAt }>, status() → { status: 'idle' | 'waiting' | 'done' | 'failed', error? }, cancel() }`. Spawns `bash -lc 'az login --use-device-code [--tenant <t>] -o none'`; resolves `start` on the first parsed code from stderr or stdout; `done` on exit 0, `failed` with the last 5 output lines on non-zero; a second `start` while waiting returns the same code; `cancel` kills it (status `idle`).
  - `account({ run }) → Promise<{ user, tenantId, subscriptionId, subscriptionName } | null>` (`az account show -o json`).
  - `subscriptions({ run }) → Promise<{ id, name, isDefault }[]>`, `setSubscription(id, { run })`, `logout({ run })`.
  - `testAzure({ run }) → Promise<{ ok, needsSignIn, error }>`: `az account get-access-token --query expiresOn -o tsv`; non-zero with `AADSTS` or `az login` in stderr → `needsSignIn: true`.

- [ ] **Step 1: Write the failing tests** with a fake `spawn` (an `EventEmitter` with `stdout`/`stderr` streams and `kill`) and fake `run`: `parseDeviceCode reads az's line`, `returns null for other text`; `start resolves with the code and expiresAt = now + ttl`; `exit 0 is done, exit 1 is failed with az's text`; `a second start while waiting reuses the process`; `cancel kills and returns to idle`; `account parses az account show`; `testAzure flags AADSTS as needsSignIn`.
- [ ] **Step 2: Run them.** Run: `node --test test/connector-azure.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Arguments that reach the shell (tenant, subscription id) go through `shellQuote`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "Connectors: Azure device-code sign-in and account helpers"`.

### Task 8: The connector service

The one place that knows the rules; `server.js` stays a thin layer of routes.

**Files:**
- Create: `lib/connector-service.js`
- Test: `test/connector-service.test.js`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6, 7; `isInstalled` and `PROFILES` from `lib/agents.js`.
- Produces: `createConnectorService({ home, port, env = process.env, fetch, run, spawn, now, installedAgents: () => Promise<string[]> }) → Service`:
  - `init() → Promise<void>`: loads the store, then `sync()`.
  - `view() → Promise<{ connectors: ConnectorView[], planned, reset: boolean }>` with `ConnectorView = { id, label, by, kind, state, method?, account?, site?, subscription?, subscriptions?, allowChanges?, install?, lastTest?, error?, agents: { id, label, chip, note? }[] }`. `state` is one of `not-installed`, `not-connected`, `connecting`, `connected`, `needs-sign-in`, `error`. Agent `chip` is `Added`, `Not installed`, `Has its own entry` or `No connectors in Pi`; `note` is the foreign or per-folder sentence (e.g. ``Cursor CLI already has its own `atlassian` entry. Remove it to let VaultOS manage it.``) or the writer's error. Pi appears only when installed. **Never contains a token, key, client id or refresh token** (a test walks the JSON).
  - `relayTarget(id) → Target | null` for `createRelay`; OAuth `authorization` calls `renew` first when `expires_at` is within 60 s; `renew` is `serialised`, uses `refreshTokens`, stores the new tokens; the token method's `authorization` is `Basic base64(email:token)` or `Bearer key`; a disconnected connector's `authorization` returns null at once.
  - `atlassianStart({ origin, nonce }) → Promise<{ url }>`: redirect URI `${origin}/api/connectors/atlassian/callback`; registers when there's no client or its `redirect_uri` differs; `redirect-refused` → throws with the Global Constraints sentence "Atlassian didn't accept this address for sign-in. Use an API token, or open VaultOS on localhost."
  - `atlassianCallback({ code, state, nonce }) → Promise<void>`: unknown/reused/expired state throws `'This sign-in link has expired. Start again from VaultOS.'`; stores tokens and method `oauth`, then `test('atlassian')` and `sync()`.
  - `atlassianToken({ email, token } | { key }) → Promise<void>`: probes with the new credential first; on failure throws the probe's error and keeps the previous method.
  - `test(id) → Promise<lastTest>`: atlassian = `mcpProbe` through the relay target (best-effort `atlassianUserInfo` → `account`, `getAccessibleAtlassianResources` → `site`); azure = `testAzure` + `account`. Stores `lastTest = { at, ok, tools, error }`; `needsSignIn` results set the state.
  - `disconnect(id) → Promise<void>`: atlassian OAuth → `revoke` (failure noted in `error`, not thrown), delete the sign-in, `sync()`; azure → `logout`, delete, `sync()`.
  - `azureStart()`, `azureStatus()` (folds a finished login into the store: account, default subscription, test, sync), `azureCancel()`, `azureSettings({ allowChanges, subscription })` (subscription → `setSubscription`; allowChanges → store + `sync()`).
  - `sync() → Promise<void>`: `wanted` = `entryFor` of each connected connector; writers for installed agents among `claude`, `cursor`; stores `written` and per-agent results for `view()`.
  - `needsAttention() → boolean` (any connector `needs-sign-in`).

- [ ] **Step 1: Write the failing tests** (temp home, `CONNECTOR_UPSTREAM_ATLASSIAN` = the fake's base, fake `run`/`spawn`, `installedAgents` returning `['cursor']`):
  - `full OAuth: start, follow the fake's redirect, callback; view says connected with account alex@example.com and site example.atlassian.net`.
  - `cursor gets the atlassian entry with the relay URL and key after connect`.
  - `state from another nonce is refused with the expired-link sentence`.
  - `a new origin re-registers the client`.
  - `a refused redirect gives the sentence`.
  - `token method: bad token keeps the previous method; good token connects`.
  - `refresh refused marks needs-sign-in and needsAttention() is true`.
  - `disconnect revokes, removes the cursor entry and the sign-in`.
  - `azure: start returns the code; status after exit 0 stores the account and writes the read-only entry; allowChanges rewrites it without --read-only`.
  - `view never contains a secret` (collect every string in the JSON; none equals the relay key, an access/refresh token, the client id or the API token).
  - `pi row only when pi is installed`.
- [ ] **Step 2: Run them.** Run: `node --test test/connector-service.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "Connectors: the service that ties sign-ins, relay and agents together"`.

### Task 9: Server routes

**Files:**
- Modify: `server.js` (host-check exemption near line 911; relay mount before `app.use(express.json(...))` near line 951; routes beside `/api/agents` near line 1466; `service.sync()` in `GET /api/agents`; `service.init()` after `app.listen`)
- Test: `test/server-connectors.test.js`

**Interfaces:**
- Consumes: `createConnectorService` (Task 8), `createRelay` (Task 5).
- Produces (all JSON, all behind `settingsGuard`):
  - `GET /api/connectors` → `service.view()` plus `attention: service.needsAttention()`.
  - `POST /api/connectors/:id/test`, `POST /api/connectors/:id/disconnect`.
  - `POST /api/connectors/atlassian/start` → `{ url }`; sets `req.session.cxNonce` (16 random bytes) if absent; origin is `${req.protocol}://${req.get('host')}`.
  - `GET /api/connectors/atlassian/callback?code&state` → a small HTML page: success "Atlassian is connected, you can close this tab." (and `window.opener && window.opener.postMessage('vaultos-connectors', location.origin)`), or the expired-link sentence. Status 200 either way; nothing about tokens in the page.
  - `POST /api/connectors/atlassian/token` `{ email, token } | { key }`.
  - `POST /api/connectors/azure/start` → `{ url, code, expiresAt }`; `GET /api/connectors/azure/status`; `POST /api/connectors/azure/cancel`; `POST /api/connectors/azure/settings` `{ allowChanges?, subscription? }`.
  - Errors: a service error meant for the person → `400 { error }`; anything else logged, `500 { error: 'Could not …' }` (same pattern as `settingsFail`).
  - `ALL /mcp/:id` → the relay handler. Exempt from the Host allowlist (it requires a loopback peer and the key instead); registered before `express.json` so the body arrives raw.

- [ ] **Step 1: Write the failing tests** with `startServer` (`test/helpers/server.js`) and a fake started in the test, env `CONNECTOR_UPSTREAM_ATLASSIAN`:
  - `connectors need a session` (`GET /api/connectors` without cookie → 401).
  - `GET /api/connectors lists atlassian and azure not connected, and eight planned`.
  - `the whole Atlassian sign-in over HTTP`: `start` → GET the authorize URL with `redirect: 'manual'` → GET the `Location` with the cookie → page says connected → `GET /api/connectors` shows `connected`.
  - `the relay answers tools/list with the key from the store` (read `<home>/.vaultos/connectors.json`).
  - `the relay refuses a non-loopback peer`: connect to the server through the machine's first non-internal IPv4 from `os.networkInterfaces()` (skip the test when there is none) → 403.
  - `the relay works with a Host the allowlist doesn't name` (`Host: 127.0.0.1:<port>` with `ALLOWED_HOSTS=example.test`).
  - `callback without a session is 401, and with another session's state shows the expired sentence`.
- [ ] **Step 2: Run them.** Run: `node --test test/server-connectors.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the routes and mounts.** The service gets `run: runCapture`, `spawn: child_process.spawn`, `installedAgents` from `isInstalled` over `claude`, `cursor`, `pi`.
- [ ] **Step 4: Run them, then the server suites that share the edges.** Run: `node --test test/server-connectors.test.js test/server-security.test.js test/server-agent.test.js test/host-check.test.js`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "Connectors: routes, the /mcp relay mount and sync on start"`.

### Task 10: The Connectors pane

**Files:**
- Create: `public/connectors.js` (UMD, `window.Connectors`, Node module for tests)
- Modify: `public/agent-marks.js` (`atlassian`, `azure` glyphs, exposed as `AgentMarks.connector(id)`), `public/index.html` (nav button `data-sec="connectors"` between Agent and Skills; `<section class="ss-pane ss-form" data-sec="connectors"><div id="cx-pane"></div></section>`; `<script src="connectors.js">` after `agent-form.js`), `public/app.js` (mount, Settings dot, focus refresh), `public/styles.css` (the pane, reusing the agent picker's tile and chip styles)
- Test: `test/connectors-ui.test.js`, `test/agent-marks.test.js`

**Interfaces:**
- Consumes: `GET /api/connectors` view (Task 8/9).
- Produces:
  - `stateChip(state) → { text, tone }` (`tone` `ok` | `warn` | `plain`): not-installed "Not installed", not-connected "Not connected", connecting "Connecting…", connected "Connected" ok, needs-sign-in "Sign in again" warn, error "Error" warn.
  - `agentChip(chip) → { text, tone }` (`Added` ok, `Has its own entry` warn, others plain).
  - `minutesLeft(expiresAt, now) → number` (ceil, never below 0).
  - `mountConnectors(el, ui) → { refresh(): Promise<void> }` with `ui = { api(method, url, body?) → Promise<object>, openTerm(cmd), openTab(url) → Window | null }`. Renders the mockup: the Ready tiles (buttons, roving tabindex), the Planned tiles (not buttons), the detail panel per state:
    - Atlassian not connected: the two option cards. Left "Sign in with Atlassian" + "Recommended" chip, body "Opens Atlassian's approve page in a new tab of this browser. When you approve, Atlassian sends you straight back here. No extra ports.", primary button "Sign in with Atlassian". Right "Use an API token", body "Only works if your Atlassian admin has turned tokens on for agents. A token lasts up to a year, and a few tools don't work with one.", fields "Atlassian email" and "API token", button "Save token", link "Create a token" (`tokenHelp`).
    - Waiting: "Waiting for you to approve in the Atlassian tab…", buttons "Open the tab again", "Cancel"; polls `GET /api/connectors` every 2 s for 10 minutes or until a `postMessage('vaultos-connectors')` arrives.
    - Connected: facts (site, "Signed in as …", last test with tool count), "Added to your agents" rows, buttons "Test again", "Use an API token instead" (OAuth) or "Sign in with Atlassian instead" (token), "Sign out".
    - Azure: "Install" (opens a terminal with `install`), then "Sign in" → the code panel: the code large, "Copy code", "Open microsoft.com/devicelogin", "Waiting for Microsoft… the code works for {n} more minutes", "Cancel"; polls `GET /api/connectors/azure/status` every 3 s. Connected: account, a subscription `<select>`, an "Allow changes" switch with "Applies to agents you start after changing it.", the agent rows, "Test again", "Sign out".
    - `reset: true` → a note above the tiles: "Your connector sign-ins couldn't be read, so they were reset. Connect again."
    - Errors from the API show under the button that caused them.
  - Every server string goes through the same `esc` the agent picker uses.
  - `app.js`: mounts it on first open of the section; `refresh()` when Settings opens, on window `focus`; the `set-dot` condition (line ~354) also shows when the last view had `attention`. Install uses the agent picker's terminal path (`termOpen({ cwd: '', run: cmd })`).

- [ ] **Step 1: Write the failing tests:** `test/connectors-ui.test.js`: `stateChip covers the six states with the exact copy`; `agentChip tones`; `minutesLeft rounds up and stops at 0`. `test/agent-marks.test.js`: add `connector marks for atlassian and azure are single-colour 24px and distinct`.
- [ ] **Step 2: Run them.** Run: `node --test test/connectors-ui.test.js test/agent-marks.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the module, the marks, and the wiring.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Look at it in the preview.** `docker compose -f /opt/vault/connectors-preview/compose.yml up -d`, run the fake inside it (`docker exec -d connectors-preview node /app/scripts/fake-mcp-oauth.js --port 5555`), finish setup on :7695, then screenshot Settings → Connectors with the host Chrome (`CLAUDE.md`, "Fastest path", pointed at `http://127.0.0.1:7695/` with a minted cookie) in dark and sepia, at 1600 px and at 390 px. Compare with mockup boards 1 and 2. Then the markup check from Review Focus: connect with the token method using email `<img src=x onerror=alert(1)>@example.com` against a fake that echoes it as the account, and confirm the screenshot shows the literal text.
- [ ] **Step 6: Commit:** `git commit -m "Connectors: the Settings pane"`.

### Task 11: End to end, docs, review

**Files:**
- Create: `scripts/connectors-e2e.js`
- Modify: `CLAUDE.md` (a "Connectors" section: where sign-ins live, the relay rules, the preview and e2e commands, "never a 401 to an agent"), `README.md` (one short "Connectors" paragraph: Settings → Connectors, Atlassian and Azure, read-only Azure by default), the spec's decisions section.

- [ ] **Step 1: Write `scripts/connectors-e2e.js`** against the preview (mints a cookie like `kb-preview/mint-cookie.js`), scenarios:
  - C1: install Claude Code and the Cursor CLI in the preview (the agent picker's install commands via `docker exec`), connect Atlassian through the fake (authorize URL fetched inside the container with `curl -s -o /dev/null -w '%{redirect_url}'`, callback from the host with the cookie).
  - C2: both agents' configs hold the `atlassian` entry. `claude mcp list` (and `agent mcp list`, or what Task 1 found works without a Cursor login), run from `/vault` and `/tmp`, report it connected.
  - C3: an MCP client inside the container calls `tools/list` and `atlassianUserInfo` through the relay with the key from the store.
  - C4: `setMode('expire')`, the call still works (one refresh).
  - C5: `setMode('refuse-refresh')`: the call returns the expired sentence; `GET /api/connectors` has `attention: true`.
  - C6: disconnect, and both agents' entries are gone, other entries untouched.
- [ ] **Step 2: Run it.** Run: `node scripts/connectors-e2e.js C1 C2 C3 C4 C5 C6`. Expected: 6 passed.
- [ ] **Step 3: Run the full suite in the image** (Global Constraints command). Expected: all pass.
- [ ] **Step 4: Write the docs** (`CLAUDE.md` section, `README.md` paragraph, spec decisions: anything that changed during the build).
- [ ] **Step 5: Private-words check** (Global Constraints command). Expected: no hits outside `Ben` in `docs/`.
- [ ] **Step 6: Whole-branch code review** (`superpowers:requesting-code-review`), fix what it finds, re-run Steps 2–3.
- [ ] **Step 7: Commit:** `git commit -m "Connectors: end-to-end scenarios and docs"`.

### Task 12: Hand over to Ben

- [ ] **Step 1: Ask Ben for the real-account checks on the preview** (optional, his call): a free Atlassian Cloud site and his personal Azure login. Point the preview at the real Atlassian (unset `CONNECTOR_UPSTREAM_ATLASSIAN`), open it at `http://localhost:7695` over an SSH tunnel, and have him click Sign in with Atlassian. Then try `http://127.0.0.1:7695` too, to learn whether Atlassian takes a `127.0.0.1` redirect. Record both results in the spec.
- [ ] **Step 2: Give Ben the release commands to run himself** (the auto-mode classifier blocks Claude from deploying): tag a rollback image (`docker tag vault-board:latest vault-board:pre-connectors`), merge `connectors` into `main` in `/opt/vault/board`, `docker compose up -d --build board` (the image changes for `libicu72`), then `git push`. The rollback note goes with them: re-tag `vault-board:pre-connectors`, reset `main` to the previous commit, restart, then `claude mcp remove --scope user atlassian` / `azure` and delete those two keys from `~/.cursor/mcp.json` (they point at a relay that no longer answers). Then verify `/health`, `GET /api/connectors` and the Settings pane, and remove the worktree and preview (`git worktree remove`, `docker compose -f /opt/vault/connectors-preview/compose.yml down -v`).
- [ ] **Step 3: The work-laptop test list for Ben:** pull, `docker compose up -d --build`, install Cursor CLI, Settings → Connectors → Atlassian → Sign in, then Azure → Install → Sign in with the code; in a Cursor session ask it to list Jira projects and Azure resource groups from two different folders. Report back anything that fails, word for word.
