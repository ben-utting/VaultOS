# Connectors: GitHub and Microsoft Learn — design

2026-10-29. Approved in conversation. Builds on `2026-10-29-connectors-design.md` (read it first; this
file only says what changes). Atlassian and Azure shipped and passed Ben's work-laptop test the
same day.

## What Ben asked for

- Take Gitea off the Planned list.
- A GitHub connector. Sign-in: a pasted personal access token (Ben's choice over a registered
  GitHub app with device sign-in).
- A Microsoft Learn connector for documentation search.

## Facts (checked 2026-10-29)

- **Microsoft Learn MCP:** `https://learn.microsoft.com/api/mcp`, streamable HTTP, no
  authentication. `initialize` answers as `text/event-stream` with an `Mcp-Session-Id`. Tools:
  `microsoft_docs_search`, `microsoft_code_sample_search`, `microsoft_docs_fetch`.
- **GitHub MCP:** `https://api.githubcopilot.com/mcp/` answers an unauthenticated POST with `401`
  and `resource_metadata` pointing at its protected-resource document; the authorization server is
  `https://github.com/login/oauth`, which offers no registration endpoint (so VaultOS can't register
  itself as it does with Atlassian). A personal access token is accepted as
  `Authorization: Bearer <token>`.

## Design

Both are **relayed** connectors, exactly like Atlassian: agents call
`http://127.0.0.1:<PORT>/mcp/<id>` with the key, VaultOS adds the credential (or none) and streams
to the upstream. One path for every hosted connector, Test works the same way, and Turn off / Sign
out removes them from agents at once.

### Catalogue (`lib/connectors.js`)

| id | label | by | signIn | base | mcpPath |
|---|---|---|---|---|---|
| `github` | GitHub | Repos · issues · pull requests | `['token']` | `https://api.githubcopilot.com` | `/mcp/` |
| `mslearn` | Microsoft Learn | Microsoft docs and code samples | `['none']` | `https://learn.microsoft.com` | `/api/mcp` |

GitHub also carries `tokenHelp: 'https://github.com/settings/personal-access-tokens/new'`.

`PLANNED` becomes: Notion, Home Assistant, n8n, Linear, Sentry (Gitea removed; GitHub and
Microsoft Learn are now real).

`baseFor(id, env)` reads the test-only override `CONNECTOR_UPSTREAM_<ID>` for every relayed
connector (`CONNECTOR_UPSTREAM_ATLASSIAN` keeps working).

Agent entry names: `github`, `mslearn`. A same-named entry the person wrote themselves is left
alone and reported, as today.

### Sign-in and state

- **GitHub:** the token is stored as `{ method: 'token', key: <token> }` and sent as Bearer. Saving
  probes upstream first (`initialize` + `tools/list`); a failing probe keeps the previous token and
  shows GitHub's error. The account is read best-effort from the `get_me` tool (`login`). A later
  `401` marks the row "Sign in again" while still sending the token (the token-method rule from
  R16), and a successful Test clears it. Sign out deletes the token (GitHub has no API to revoke a
  personal access token; the panel says to delete it on GitHub too).
- **Microsoft Learn:** **Turn on** stores `{ method: 'none' }`; the relay sends no `Authorization`
  header. Connected once Test lists its tools. **Turn off** deletes the record and syncs.
- No read-only switch for GitHub: the token's own permissions are the limit, and the panel says so.

### Relay and service changes

- A relay `Target`'s `authorization()` may return `''` meaning "connected, send no credential";
  only `null` means not signed in. The relay sends no `Authorization` header for `''`.
- `relayTarget(id)` works for every relayed connector, not only Atlassian.
- The token method is generic: `saveToken(id, input)` (Atlassian: `{ email, token }` or `{ key }`;
  GitHub: `{ token }`, stored as `key`), and `enable(id)` for `none` connectors. The
  Atlassian-specific function names stay as thin aliases only if the routes still need them.
- `lib/connector-service.js` is ~455 lines; this change splits the relayed-connector credential code
  (OAuth refresh, token method, `none`) into `lib/connector-relayed.js` so neither file passes ~400.

### Routes

- `POST /api/connectors/:id/token` replaces the Atlassian-only route (same body shapes; `id` must be a
  relayed connector whose `signIn` includes `token`).
- `POST /api/connectors/:id/enable` for connectors whose `signIn` is `['none']`.
- Everything else unchanged.

### The screen

- **Ready** shows four tiles: Atlassian, Azure, GitHub, Microsoft Learn (two rows of two).
- **GitHub, not connected:** one card. Heading "Paste a GitHub token". Body: "Create a token on
  GitHub and paste it here. VaultOS checks it with GitHub before saving it. Agents can do what the
  token allows, so a fine-grained token limited to the repos you choose keeps it tight." Field
  "Personal access token" (password input), button "Save token", link "Create a token".
- **GitHub, connected:** "Signed in as `<login>`", the last test with its tool count, the agent rows,
  buttons "Test again", "Replace token", "Sign out", and the note "Signing out here doesn't delete the
  token on GitHub."
- **Microsoft Learn, not connected:** "Microsoft's documentation and code samples. No sign-in." and a
  **Turn on** button. **Connected:** "Connected · `<n>` tools", the agent rows, "Test again",
  "Turn off".
- Marks: GitHub's mark from Simple Icons (CC0); Microsoft Learn a single-colour book glyph (Microsoft
  logos aren't in Simple Icons). Both 24×24, `currentColor`, distinct from the others.

## Testing

- Unit and server tests extend the existing ones. The fake server (`scripts/fake-mcp-oauth.js`)
  already accepts `Bearer svc-key`; it gains a `get_me` tool and a no-auth mode (or a second
  instance) so `mslearn` can be tested with `CONNECTOR_UPSTREAM_MSLEARN` pointed at it.
- Must-have cases: a GitHub token that fails the probe keeps the old one; `''` authorization sends
  no header and never reads as "not connected"; Turn on / Turn off add and remove `mslearn` in both
  agents; the planned list has five entries; the tokens never reach `view()`.
- Real-world check: Microsoft Learn can be tested from the homelab for real (no account needed).
  GitHub is checked by Ben with his own token.

## Out of scope

GitHub device sign-in with a registered app; GitHub Enterprise Server; GitHub read-only mode or
toolset selection; the other planned connectors.
