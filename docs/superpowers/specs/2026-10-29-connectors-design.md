# Connectors: Atlassian and Azure for every agent — design

2026-10-29. Approved in conversation. Mockup: https://claude.ai/artifact/H1k2P2ngwaauBR75Wzz6F6
(board 1, Settings → Connectors, approved as drawn; board 2, the two ways to connect Atlassian).

## Why

Ben wants his agents, above all the Cursor CLI and Claude Code, to reach work services: first
Atlassian (Jira, Confluence) and Azure (subscriptions, resources, Key Vault). Doing it by hand
inside VaultOS fails in three ways:

- **The sign-in can't get back.** An agent signing in to an MCP server opens a listener on a
  random port inside the container and asks the service to send the browser back to
  `localhost:<port>`. The browser runs on the host, and Docker only forwards VaultOS's own port,
  so the redirect fails unless that exact port happens to be published. Claude Code can pin the
  port (`--callback-port`); the Cursor CLI can't, and its CLI has open reports of OAuth sign-ins
  failing that work in the desktop app.
- **It only works in one folder.** `claude mcp add` saves to the "local" scope by default, which
  is tied to the folder it ran in; a project's `.cursor/mcp.json` is the same.
- **Every agent signs in on its own.** Each keeps its own config and tokens, so adding Cursor
  after Claude means doing it all again.

## Goals

1. Settings → Connectors: click Connect, approve once in your own browser, done. No extra ports.
2. A connected service works for every installed agent VaultOS can set up, in every folder.
3. Agents never hold the service's password, token or refresh token.
4. VaultOS can tell you whether a connector works, and tells you plainly when a sign-in runs out,
   in the Settings screen and in the agent's own reply.
5. Azure starts read-only.

## Non-goals

- Outlook, Teams and the rest of Microsoft 365. Microsoft's own servers need a Microsoft 365
  Copilot licence and an admin-registered Entra app; the community one needs user consent most
  work tenants block. Ben dropped them.
- Azure DevOps. Its hosted server signs in through Entra in a way Claude Code and Cursor can't
  use yet (Microsoft's own GA post says so); its route would be a PAT. Not asked for.
- A browser inside VaultOS. Work sign-ins trust the real browser on the managed laptop (MFA,
  device rules); a browser in the container is an unknown device and would likely be blocked.
- A general "paste the failed address" relay for any tool's own sign-in. Kept as an idea for
  future connectors; nothing in this release needs it.
- The planned connectors drawn on board 1 (GitHub, Notion, Gitea, Home Assistant, n8n, Linear,
  Sentry, Microsoft Learn). The screen shows them as "Planned · not built yet" so the shape is
  visible; each is its own later change.
- Agents other than Claude Code and the Cursor CLI. Codex, Copilot, OpenCode and Kilo all speak
  MCP and get writers later. Pi has no MCP support by design, so it's never on the list.
- Reading or changing anything in an agent's *project* or per-folder config.

## How it fits together

```
 host browser                          container
 ────────────                          ──────────────────────────────────────────────
 Settings → Connectors ─ Connect ───▶  VaultOS (PORT, published as 7684)
 Atlassian approve page ◀─ redirect ─  │  keeps sign-ins in ~/.vaultos/connectors.json
   └ back to <VaultOS origin>/api/connectors/atlassian/callback
                                       │
 microsoft.com/devicelogin ◀─ code ──  │  az login --use-device-code (one shared login)
                                       │
                                       │  /mcp/atlassian ◀── Claude Code, Cursor CLI
                                       │     checks the key, adds the sign-in,
                                       │     forwards to https://mcp.atlassian.com/v1/mcp
                                       │
                                       └ writes one user-wide entry per connector into
                                         each agent's config; for Azure the entry runs
                                         `azmcp server start --read-only`, which uses the
                                         shared az login
```

Two kinds of connector:

- **Relayed** (Atlassian): a hosted MCP server. VaultOS holds the sign-in and passes each agent
  request through, adding the credential. Agents point at VaultOS.
- **Local** (Azure): a program each agent runs itself. VaultOS installs it, runs the sign-in, and
  writes the entry. The credential is the tool's own login in the home folder, shared by all.

## Facts this design rests on (checked 2026-10-29)

- `https://mcp.atlassian.com/.well-known/oauth-authorization-server` offers a
  `registration_endpoint` (open client registration), `code_challenge_methods_supported`
  `S256`, `grant_types_supported` `authorization_code` and `refresh_token`,
  `token_endpoint_auth_methods_supported` including `none`, and a `revocation_endpoint`. An
  unauthenticated POST to `/v1/mcp` gets `401` with `WWW-Authenticate: Bearer`.
- Atlassian retired the `/v1/sse` endpoint on 2026-06-30; `/v1/mcp` (streamable HTTP) is the one.
- Atlassian also takes an API token, **if the organisation's admin has enabled it**: a personal
  token as Basic (`email:token`) or a service-account key as Bearer. Some tools are unavailable
  with tokens.
- Azure MCP Server `@azure/mcp` 4.0.0-beta.3, `azmcp server start`: `--transport` (default
  stdio), `--namespace`, `--mode`, `--tool`, `--read-only`. It is a .NET program: in
  `node:22-bookworm-slim` it aborts without `libicu` and needs `libssl3`. It authenticates
  through the Azure Identity chain; the Azure CLI login is the documented path.

## Components

### `lib/connectors.js` — the catalogue

Shaped like `PROFILES` in `lib/agents.js`. Each entry:

| field | Atlassian | Azure |
|---|---|---|
| `id` | `atlassian` | `azure` |
| `label`, `by` | Atlassian, Jira · Confluence | Azure, Subscriptions · resources · Key Vault |
| `kind` | `relayed` | `local` |
| `signIn` | `['oauth', 'token']` | `['device-code']` |
| `upstream` | `https://mcp.atlassian.com/v1/mcp` | — |
| `install` | — | the Azure CLI and `@azure/mcp` (see Azure) |
| `detect` | — | `az` and `azmcp` on PATH |
| `entry(ctx)` | `{ url, headers }` pointing at the relay | `{ command, args }` for `azmcp` |

Plus `planned`: the eight names, labels and one-liners shown greyed on the screen. Planned
entries have no behaviour.

### `lib/connector-store.js` — sign-ins and state

One file, `~/.vaultos/connectors.json` (the home folder, so it is in the home volume on both the
portable install and the homelab, never in the vault, so nothing reaches OneDrive or Syncthing).
Written with `lib/atomic-write.js`, mode `0600`, the folder `0700`. A damaged file is kept aside
as `connectors.json.bad-<time>`, never overwritten silently, and the screen says sign-ins were
reset.

```json
{
  "version": 1,
  "relayKey": "<32 random bytes, base64url>",
  "connectors": {
    "atlassian": {
      "method": "oauth",
      "client": { "client_id": "…", "redirect_uri": "http://localhost:7684/api/connectors/atlassian/callback" },
      "tokens": { "access_token": "…", "refresh_token": "…", "expires_at": 0 },
      "account": "[email or name from Atlassian]",
      "lastTest": { "at": "…", "ok": true, "tools": 0, "error": null }
    },
    "azure": {
      "method": "device-code",
      "allowChanges": false,
      "account": "…",
      "subscription": "<id>",
      "lastTest": { "…": "…" }
    }
  },
  "written": {
    "claude": { "atlassian": "<sha256 of the entry>", "azure": "<sha256>" },
    "cursor": { "atlassian": "<sha256>" }
  }
}
```

Token method stores `{ "method": "token", "email": "…", "token": "…" }` (Basic) or
`{ "method": "token", "key": "…" }` (Bearer, service account) in place of `client`/`tokens`.

`written` records exactly what VaultOS put in each agent's config, so it only ever changes or
removes its own entries.

### The relay — `/mcp/:id` in `server.js` (logic in `lib/connector-relay.js`)

- **Who may call it.** The socket peer must be `127.0.0.1` or `::1` (agents run in the same
  container). Not `isLocalPeer`: that one also trusts the Docker gateway when `LOCAL_READ` is on.
  Requests arriving through Docker's port forward or a proxy come from another address and get
  `403`. The request must also carry `X-VaultOS-Key: <relayKey>` (compared in constant time).
  The key header is never forwarded upstream. The Host allowlist applies as everywhere else; the
  entries use `127.0.0.1`, which the default `ALLOWED_HOSTS` already includes.
- **Pass-through.** `POST`, `GET` and `DELETE` are forwarded to the connector's `upstream` with
  `Authorization` set from the store. Request and response bodies are streamed, so both JSON
  and `text/event-stream` answers work. `Mcp-Session-Id`, `MCP-Protocol-Version`, `Accept`,
  `Content-Type` and `Last-Event-ID` pass both ways; nothing else from the agent goes upstream.
- **Renewal.** Before forwarding, an OAuth access token within 60 s of `expires_at` is refreshed.
  If upstream still answers `401`, VaultOS refreshes once and retries once. Refreshes are
  serialised per connector so two agents don't both spend the refresh token.
- **Never a 401 to the agent.** A `401` makes Claude Code and the Cursor CLI start their own OAuth
  flow, the broken path this feature exists to avoid. When VaultOS has no usable sign-in (never
  connected, refresh refused, token removed), it answers a JSON-RPC request with `200` and a
  JSON-RPC error, code `-32001`, message:
  `Atlassian sign-in has run out. Open Settings → Connectors in VaultOS to sign in again.`
  (or `…isn't connected yet…`). The connector is marked `needsSignIn` for the screen.
- **Off means off.** A disconnected connector answers the same way at once, even for agent
  sessions already running.
- Outbound requests use Node's `fetch`, which honours `NODE_EXTRA_CA_CERTS`, so a company proxy's
  root from `/certs` (see `docker-entrypoint.sh`) works with no extra step.

### Atlassian sign-in — `lib/connector-oauth.js`

Routes under `/api/connectors/atlassian/*`, all behind `settingsGuard` (a signed-in session),
the callback included: it is a browser navigation from Atlassian, and the session cookie comes
with it because the redirect URI uses the same origin the person signed in on.

1. `POST /api/connectors/atlassian/start` → registers a client the first time (or when the
   redirect URI changed) at the `registration_endpoint` with `token_endpoint_auth_method: none`,
   `grant_types: [authorization_code, refresh_token]`, `redirect_uris: [<origin>/api/connectors/atlassian/callback]`.
   `<origin>` is the origin the browser is using, from the request's Host (already checked
   against `ALLOWED_HOSTS`) and protocol (`TRUST_PROXY` rules as today). It makes a PKCE
   verifier (S256) and a random `state`, keeps both in memory for 10 minutes, and returns the
   authorize URL. The page opens it in a new tab and shows "Waiting for you to approve…".
2. `GET /api/connectors/atlassian/callback?code&state` → `state` must match a pending sign-in
   from this session, once. It exchanges the code, stores the tokens, runs a test (below), and
   returns a small page that says "Atlassian is connected, you can close this tab" and tells the
   opener to refresh.
3. The Settings panel polls `GET /api/connectors` every 2 s while waiting, and stops after 10
   minutes or on Cancel.
4. `POST /api/connectors/atlassian/token` `{ email, token }` or `{ key }` → stores the token
   method and runs a test; a failing test leaves the old method in place and shows the error.
5. `POST /api/connectors/atlassian/disconnect` → for OAuth, revokes the refresh token at the
   `revocation_endpoint` (a failed revoke is reported, not fatal), then deletes the sign-in and
   removes the agent entries.

**The homelab caveat.** The homelab is reached through a public hostname over HTTPS, not
`localhost`. If Atlassian refuses that redirect URI at registration, the screen says so and
offers the token method. The work laptop uses `localhost`, which Atlassian accepts (it is what
Claude Code registers).

### Azure — install, sign-in, entry

- **Image.** The Dockerfile adds `libicu72` to the runtime `apt-get install` line (`libssl3`
  is already there through `curl`). This is the one image rebuild the feature needs.
- **Install** opens a terminal and runs the install command, as agent installs do today.
  Both pieces land in the home volume, no sudo: `@azure/mcp` via
  `npm install -g --prefix ~/.local @azure/mcp`, and the Azure CLI in a virtualenv
  (`python3 -m venv ~/.local/share/azure-cli`, `pip install azure-cli`, `az` linked into
  `~/.local/bin`). Spike 1 confirms this, its size and time, before anything else is built.
- **Sign in.** `POST /api/connectors/azure/start` spawns `az login --use-device-code` (with
  `--tenant` if one is saved), reads the code and URL from its output, and returns them. The
  panel shows the code large with Copy, an "Open microsoft.com/devicelogin" button, and a
  waiting line with the code's remaining time. When the process exits 0, VaultOS runs
  `az account show` and `az account list`, stores the account and default subscription, and
  tests. A non-zero exit shows az's own error text (this is where a company that blocks code
  sign-in shows up). Cancel kills the process. One sign-in at a time.
- **Subscription.** A picker from `az account list`; choosing one runs `az account set`.
- **Allow changes.** Off by default: the entry runs `azmcp server start --read-only`. Turning it
  on rewrites the entries without `--read-only`. The switch says it applies to agents started
  after the change.
- **Entry.** `{ command: "<home>/.local/bin/azmcp", args: ["server", "start", "--read-only"] }`,
  absolute path because an agent may spawn it without the terminal's PATH.
- **Disconnect** runs `az logout` and removes the entries.
- **Test** runs `az account get-access-token --query expiresOn` (proves the login is usable)
  and reports the account and subscription. A failed test with az's "AADSTS" or "login"
  wording marks it `needsSignIn`.

Spike 2 confirms `azmcp` picks up the `az` login in this container (tools/list then one read
call). If it doesn't, the fallback is the Azure Developer CLI (`azd auth login
--use-device-code`), and the spec's decisions section records which.

### Agent setup — `lib/connector-agents.js`

One writer per agent, each with `read()`, `put(name, entry)`, `remove(name)`:

- **Claude Code.** `claude mcp add-json --scope user <name> '<json>'` and
  `claude mcp remove --scope user <name>`, run as the VaultOS user. The CLI, not a direct edit of
  `~/.claude.json`, because Claude rewrites that file constantly. Relayed entry:
  `{ "type": "http", "url": "http://127.0.0.1:<PORT>/mcp/atlassian", "headers": { "X-VaultOS-Key": "<key>" } }`.
  Local entry: `{ "type": "stdio", "command": "…", "args": [ … ] }`.
- **Cursor CLI.** `~/.cursor/mcp.json`, `mcpServers.<name>`, read-modify-write with
  `atomic-write`, keeping every other key and entry as it was. Relayed: `{ "url", "headers" }`;
  local: `{ "command", "args" }`. Spike 3 confirms the Cursor CLI uses user-wide servers from any
  folder with no per-folder approval prompt, or what VaultOS must add (for example a start flag)
  so it doesn't ask.
- **Names.** `atlassian` and `azure`. If the agent already has a user-wide entry of that name
  that VaultOS didn't write (no match in `written`), VaultOS leaves it alone and the screen
  says: "Cursor CLI already has its own `atlassian` entry. Remove it to let VaultOS manage it."
  For Claude Code it also reads `~/.claude.json` for per-folder `atlassian`/`azure` entries,
  which win over user-wide ones in that folder, and lists those folders in the same note.
- **Sync** (`syncAgents()`): for every installed agent with a writer, the set of entries it
  should have is the connected connectors; add the missing, rewrite the changed, remove the
  ones VaultOS wrote that should no longer exist. Runs on connect, disconnect, Allow changes,
  after `GET /api/agents` sees a newly installed agent, and once at server start. Each writer's
  failure is reported per agent and never stops the others.

### API

All behind `settingsGuard`, JSON:

- `GET /api/connectors` → `{ connectors: [{ id, label, by, kind, state, account, detail,
  lastTest, agents: [{ id, label, state, note }] }], planned: [...] }`. `state` is one of
  `not-installed`, `not-connected`, `connecting`, `connected`, `needs-sign-in`, `error`.
  Never includes a token, key or client secret.
- `POST /api/connectors/:id/test` → runs the test now.
- The sign-in routes above, and `POST /api/connectors/azure/settings`
  `{ allowChanges?, subscription? }`.

**Test (relayed):** an MCP `initialize`, then `tools/list`, through the same code path the relay
uses, so "Connected" means an agent would work. Stores the tool count and time.

### The screen

As board 1 and 2 of the mockup.

- Settings gains **Connectors** between Agent and Skills (`data-sec="connectors"`), rendered by a
  new `public/connectors.js` in the style of `agent-form.js`.
- Heading and one line, then **Ready** (two tiles: logo mark, name, one-liner, state chip) and
  **Planned · not built yet** (eight dashed tiles, not buttons).
- The picked tile opens a detail panel: large mark, name, chip; facts (site or account, how it's
  signed in, last test); **Added to your agents**: one row per agent with a chip (`Added`,
  `Not installed`, `Has its own entry`, or for Pi `No connectors in Pi`); buttons for the state.
- Atlassian not connected: two option cards, **Sign in with Atlassian** (recommended, primary)
  and **Use an API token** (email + token, link to create one). Waiting state with **Open the
  tab again** and **Cancel**.
- Azure: **Install** → **Sign in** (code panel) → connected panel with subscription picker and
  the **Allow changes** switch.
- **Needs sign-in:** the tile chip turns red, "Sign in again"; the Settings button shows the
  existing `set-dot`. `GET /api/connectors` is checked when the page loads, when Settings
  opens, and when the window regains focus (next to the board's existing focus poll), not on
  a timer. The relay marking a connector `needsSignIn` is what that check reads.
- Logo marks are single-colour glyphs on the agent-tile gradient, in `public/agent-marks.js`
  next to the agent marks. Planned tiles use monograms.
- Keyboard: tiles are a roving-tabindex group, as in the agent picker.

## Error cases

| Case | What happens |
|---|---|
| Atlassian refuses the redirect URI | Panel: "Atlassian didn't accept this address for sign-in. Use an API token, or open VaultOS on localhost." |
| Approve tab closed, never comes back | Waiting ends after 10 minutes; Cancel ends it sooner. |
| Callback with an unknown or reused `state` | Small page: "This sign-in link has expired. Start again from VaultOS." Nothing stored. |
| Refresh refused (revoked, expired) | `needs-sign-in`; agents get the plain message; tokens kept until a new sign-in replaces them. |
| Token method test fails | Error from Atlassian shown; previous method kept. |
| Azure code sign-in blocked by the company | az's error text in the panel. |
| `connectors.json` damaged | Moved aside, sign-ins reset, screen says so. |
| An agent's config file is damaged JSON | That agent's row: "Couldn't read `~/.cursor/mcp.json`"; the file is not touched. |
| Relay called from outside the container | `403`, logged once per minute per address. |

## Spikes (first, in the `vaultos:portable` image as the `vaultos` user)

1. **Azure CLI install.** venv install works with no sudo, `az --version` runs; record size and
   time. `libicu72` added, `azmcp server start --help` runs.
2. **azmcp uses the az login.** After `az login --use-device-code` (Ben enters the code once,
   with a personal account), `azmcp` answers `tools/list` and one read call, from inside an
   agent. Else try azd and record it.
3. **Cursor CLI user-wide servers.** An entry in `~/.cursor/mcp.json` is listed by
   `agent mcp list` from two different folders, used without an approval prompt (or note the
   flag needed), with an HTTP entry carrying a custom header.
4. **Claude Code user-wide HTTP entry with a custom header** reaches the relay from two folders
   and doesn't start its own OAuth when the relay returns a JSON-RPC error.

Results go in "Decisions made during implementation" below.

## Testing

- **Unit:**
  - The catalogue has the required fields.
  - The store round-trips, sets file modes and keeps a damaged file aside.
  - The relay: loopback-only, key check, header allowlist both ways, the refresh-then-retry-once
    rule, refreshes serialised, never 401 to the agent, the plain message for not connected
    and for expired.
  - OAuth: registration body, PKCE S256, `state` single-use and session-bound, 10-minute expiry.
  - Agent writers: the Cursor writer keeps unrelated keys and entries byte-for-byte, refuses to
    touch a same-named entry it didn't write, and removes only its own; the Claude writer builds
    the right `claude mcp` commands (fake `run`).
  - `syncAgents` add/rewrite/remove sets.
- **Fake Atlassian** (`scripts/fake-mcp-oauth.js`): a local server with
  `/.well-known/oauth-authorization-server`, register, authorize (auto-approves), token,
  refresh, revoke, and a streamable-HTTP `/v1/mcp` with two tools, one answering as an SSE
  stream. It can be told to expire tokens and refuse refreshes. The upstream URL comes from
  `CONNECTOR_UPSTREAM_ATLASSIAN` in tests only.
- **E2E** (`scripts/connectors-e2e.js`, preview container, never :7684): connect Atlassian
  against the fake, check `GET /api/connectors`, then real Claude Code and the Cursor CLI each
  list and call a tool through the relay from two different folders; expire the token and see
  the call still work (refresh); refuse refresh and see the plain message; disconnect and see
  the entries gone from both configs.
- **Manual, with Ben:**
  1. Optional, early: a free Atlassian Cloud site and a personal Azure login against the
     preview. Also answers the homelab redirect-URI question.
  2. The real test: the work laptop, its Atlassian and Azure, Cursor CLI as the default agent.
     The only place code sign-in for Azure can be proven.

## Building and release

- Order: spikes 1–4; store; catalogue; relay with the fake; Atlassian OAuth and token; agent
  writers and sync; Azure install, sign-in and entry; the screen; e2e.
- The Dockerfile change (`libicu72`) means one `docker compose up -d --build` on the homelab and
  a rebuild on the work laptop; everything else is `server.js`, `lib/` and `public/`.
- The repo is public: before each push, grep the added lines for `scripts/private-words.txt`.
  Tests and fixtures use made-up sites and accounts.
- Release to the homelab is Ben's command to run, as usual. Rollback: the previous image tag and
  the previous `main` commit; `~/.vaultos/connectors.json` and the agent entries are left behind
  harmlessly by a rollback (the entries point at a relay that no longer answers, so remove them
  with `claude mcp remove --scope user` and by deleting the two `mcpServers` keys, listed in the
  release note).

## Decisions made during implementation

Spikes run 2026-10-29 in `vaultos:connectors` (the `vaultos:portable` image plus `libicu72`) as
the `vaultos` user, with `scripts/connector-probe.sh`. Home is `/home/vaultos`.

1. **Azure CLI install (spike 1): works, no sudo.** Command, as in the Azure section:
   `npm install -g --prefix ~/.local @azure/mcp`, then
   `python3 -m venv ~/.local/share/azure-cli && ~/.local/share/azure-cli/bin/pip install azure-cli`
   and `ln -sf ~/.local/share/azure-cli/bin/az ~/.local/bin/az`. Result: `azure-cli 2.91.0`,
   `Azure.Mcp.Server 4.0.0-beta.3` (`azmcp server start --help` runs with `libicu72`). Size:
   `~/.local/share/azure-cli` 643M on a fresh run (732M after `az` had run once), `@azure`
   node modules 152M, so about 800-900M in the home volume. Time: 44-45 s on this box (both
   pieces together). The Azure panel should mention the disk use.
2. **azmcp uses the az login (spike 2): pending: needs a device-code sign-in (controller Ruling
   R1).** Checked so far, with no login: `azmcp server start --read-only` over stdio answers
   `initialize` (protocol 2025-06-18) and `tools/list` (68 tools, including `subscription_list`,
   `group_list`, `group_resource_list`), and a read call (`subscription_list`) returns a clean
   `{"status":401,"message":"Azure credentials not found or unavailable. Please run 'az login'
   ..."}` as an `isError` tool result, not a crash. That call took about 90 s (it walks the
   whole credential chain), so the connector Test must allow a long timeout. `group_list` needs
   `subscription`; whether the CLI default is used was not tested. Still to run after the
   sign-in: `subscription_list` and `group_list` with the login, then with
   `AZURE_TOKEN_CREDENTIALS=AzureCliCredential`, then azd if both fail. The `azure-mcp` probe
   mode takes the env pass-through.
3. **Cursor CLI user-wide servers (spike 3): listed from any folder; interactive approval not
   proved.** `scripts/connector-probe.sh cursor` writes `~/.cursor/mcp.json` with one
   `{ "url", "headers": { "X-VaultOS-Key": "k" } }` entry (a fake HTTP MCP server on :9999 that
   logs the header) and one `{ "command": "node", "args": ["/tmp/stdio.js"] }` entry (a fake
   stdio MCP server). `agent mcp list` from `/tmp/a` and from `/tmp/b` printed the same:
   `probe-http: ready`, `probe-cmd: ready`. `agent mcp list-tools` listed `ping` and `hping`.
   The fake HTTP server logged `HTTP POST x-vaultos-key="k"` (11 POSTs), so the custom header
   is sent. With the HTTP server stopped: `probe-http: Error: Connection failed`,
   `probe-cmd: ready`. No approval file appeared under `~/.cursor` (only `mcp.json` and
   `cli-config.json`). `agent mcp enable|disable <identifier>` manages a "local approved list",
   and `agent` has `--approve-mcps` ("Automatically approve all MCP servers"). Not proved:
   whether an interactive `agent` session (needs a Cursor login, not available in the spike)
   prompts for a user-wide server on first use. Carry: Task 10 notes in the panel that if
   Cursor asks to approve a server, answering once should be enough and `agent --approve-mcps`
   skips it; Task 6 writes no extra file.
4. **Claude Code user-wide HTTP entry (spike 4): confirmed.** After
   `claude mcp add-json --scope user probe '{"type":"http","url":"http://127.0.0.1:9999/mcp/x","headers":{"X-VaultOS-Key":"k"}}'`
   (port 9999: an unprivileged user can't bind :9), `~/.claude.json` has, exactly:
   `"mcpServers": { "probe": { "type": "http", "url": "http://127.0.0.1:9999/mcp/x", "headers": { "X-VaultOS-Key": "k" } } }`
   (keys in that order, top level of the file, no extra fields). `claude mcp list` from `/tmp/a`
   and `/tmp/b` shows the same entry. With nothing listening: `✘ Failed to connect —
   ECONNREFUSED`. With a server answering every POST `200
   {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"x"}}`: `✘ Failed to connect —
   Request timed out` from both folders, with no authorize URL and no "needs authentication"
   status. A JSON-RPC error does not start OAuth. Install time of the Claude CLI 49-50 s, Cursor CLI 21 s.
5. **Disk.** The host hit 100% during the spikes (builds plus three agent/Azure installs);
   `docker builder prune` freed 3.9 GB. Check free space before building the image or running
   the install probes.
