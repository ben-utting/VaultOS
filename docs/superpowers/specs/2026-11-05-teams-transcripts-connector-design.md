# Teams transcripts connector — design

Date: 2026-11-05 · Status: approved in conversation, awaiting written review

## Why

The usual Teams, Outlook and OneDrive connectors can't read Teams meeting transcripts. Microsoft Graph can, but
only for a signed-in user, and only through an app registration that carries the transcript permissions.
Organisations that want this register their own public-client app. This connector lets VaultOS sign in through
**an app registration the user supplies**, so that Claude and Cursor can list and read that user's meeting
transcripts.

This build covers on-demand reading. A daily ingest that writes new transcripts to a folder is a later, separate
spec built on the same module (see "Later").

## What the user's app registration must have

Shown on the card as "What the app registration needs":

- Single-tenant (or multi-tenant) app, **public client flows allowed** (device code needs this).
- Delegated permissions, admin-consented: `OnlineMeetingTranscript.Read.All`, `OnlineMeetings.Read`,
  `Calendars.Read`, `User.Read`. `offline_access` is requested at sign-in so refresh tokens work.
- No client secret. No application (app-only) permissions are used.

## Hard rule: nothing organisation-specific

The VaultOS repo is public. No tenant ID, client ID, company name or domain appears in code, tests, fixtures,
docs or this spec. The user pastes the IDs into the card. Tests use made-up GUIDs and a neutral organisation name.
The private-words check runs on the diff before any push.

## Shape

A **built-in** connector, like Microsoft Entra: VaultOS answers MCP itself at `/mcp/transcripts` and holds the
sign-in. Agents never see a token.

- Catalog entry in `lib/connectors.js`: `id: 'transcripts'`, `label: 'Teams transcripts'`,
  `by: 'Meeting transcripts from an app you register'`, `kind: 'builtin'`, `signIn: ['msapp']`.
- `entryFor('transcripts')` gives the same http entry as other built-ins:
  `http://127.0.0.1:<port>/mcp/transcripts` with `X-VaultOS-Key`. Written user-wide into Claude Code and
  Cursor when the connector is on, removed when off (existing sync code).
- Independent of the Azure connector: signing out of Azure does not affect it.

### New units

**`lib/connector-msapp.js`** — sign-in for any public-client Microsoft app, by plain HTTPS (no MSAL dependency).

- `startDeviceCode({ tenantId, clientId, scopes })` → POST
  `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode`; returns `{ url, code, expiresAt }` and
  polls `/oauth2/v2.0/token` (grant `urn:ietf:params:oauth:grant-type:device_code`) at the given interval,
  honouring `authorization_pending` and `slow_down`. States: `idle | waiting | done | failed`, plus `cancel()`,
  matching `createDeviceLogin` in `connector-azure.js` so the card logic can be shared.
- `accessToken()` → returns the in-memory access token, refreshing (grant `refresh_token`) when within 5 minutes
  of expiry. Refreshes are **single-flight**: concurrent callers share one in-progress refresh, so a rotating
  refresh token is never spent twice. The new refresh token is handed to an `onRefreshToken` callback, which
  saves it before the call returns.
- `forget()` → drops the in-memory token (sign-out, Test).
- Errors are classified: `refused` (`invalid_grant`, `interaction_required`, `AADSTS50173`, etc.) → the connector
  needs sign-in; `transient` (network, 5xx, timeouts) → try again, still signed in; `config`
  (`AADSTS7000218` public client flows off, `AADSTS700016` app not found, `AADSTS90002` tenant not found,
  `invalid_scope`) → shown on the card in plain words.
- Tenant and client IDs are validated as GUIDs before any request. The authority host is fixed
  (`login.microsoftonline.com`).

**`lib/connector-transcripts.js`** — the MCP server and Graph calls. Same `handle(rpc)` / `probe()` interface as
`connector-entra.js`.

Tools:

- `transcripts_list({ days })` — `days` 1–30, default 7. Calls `/me` once (cached id) then
  `GET /v1.0/users/{id}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='{id}',startDateTime={iso},endDateTime={iso})`,
  following `@odata.nextLink` (Graph origin only). For each distinct meeting, one
  `GET /v1.0/me/onlineMeetings/{meetingId}?$select=subject,startDateTime,endDateTime` (failures leave the
  subject as "(no subject)"). Output: one line per transcript, newest first, capped at 100:
  `2026-11-04 14:00 · Weekly planning · meetingId=… transcriptId=…`. An empty result says why it might be empty
  (only meetings you organised; transcription must have been on; old meetings expire).
- `transcript_get({ meetingId, transcriptId, raw })` — fetches the meeting header as above and
  `GET /v1.0/me/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content?$format=text/vtt`. Default output:
  a header (subject, start, end) and the transcript as `[hh:mm] Speaker: text` lines, consecutive cues from the
  same speaker merged. `raw: true` returns the VTT unchanged. Capped at 400 KB with a "[cut at …]" note.
- `transcripts_help()` — the limits above and example calls.

IDs from the agent must match `^[A-Za-z0-9_=\-]+$` (meeting IDs are base64-ish; transcript IDs likewise) and are
URL-encoded; anything else is refused before a request is made. Every Graph call is GET with `redirect: 'manual'`
and a 30 s timeout. A 401 gets one retry after `forget()`.

VTT conversion (`vttToText`, exported for tests): parses cue timings and `<v Name>text</v>` voice tags; a cue
without a voice tag gets "Unknown"; multi-line cues are joined with spaces; timestamps shown as `hh:mm` from
the cue start (`mm:ss` style input handled).

Graph errors become tool errors in plain words:

- `GraphAccessToTranscriptsDisabled` → "Your organisation has turned off transcript access through Graph."
- 403 → "The app registration doesn't carry the permission for this (or admin consent is missing)."
- 404 on a meeting/transcript → "Not found. It may have expired, or you didn't organise that meeting."
- Refused refresh → "The Teams transcripts sign-in has run out. Open Settings → Connectors in VaultOS and sign in again."

### Storage

In `~/.vaultos/connectors.json` (0600, existing store), under `connectors.transcripts`:
`{ on, tenantId, clientId, refreshToken, user }`. The access token is memory only. Sign-out clears
`refreshToken` and `user` but keeps the IDs so signing in again is one click. Turning the connector off keeps
the record (like other connectors).

### Service changes (`lib/connector-service.js`)

Kept small: route `relayTarget('transcripts')` to `transcripts.handle`; `test('transcripts')` →
`transcripts.probe()` (calls `/me`, returns the user); `view()` reports `connected | connecting |
needs-sign-in | off` and the signed-in user; new actions `msappStart(id, { tenantId, clientId })`,
`msappStatus(id)`, `msappCancel(id)`, `msappSignOut(id)` behind the existing Settings API auth. If the file
grows past ~550 lines, the transcripts glue moves into `connector-transcripts.js`'s own `attach(service)`.

### Card (`public/connectors.js`)

A new `msapp` card type:

- Signed out: two inputs (Directory (tenant) ID, Application (client) ID), a "What the app registration needs"
  disclosure, and **Sign in**.
- Waiting: the code, a "Copy code" button and a link to `https://microsoft.com/devicelogin`, plus **Cancel**
  (same layout as Azure's).
- Signed in: "Signed in as {user}", the on/off switch, **Test**, **Sign out**, and the agent rows.
- Errors in plain words; `config` errors name what to ask the app's owner for.

## Testing

- Unit: `vttToText` (speakers, merged cues, multi-line, missing voice tag, empty file); ID validation; GUID
  validation; error classification.
- msapp flows against a fake token endpoint: success, `authorization_pending`, `slow_down`, expired code,
  `AADSTS7000218`, refresh rotation saved, `invalid_grant` → needs sign-in, two concurrent `accessToken()`
  calls → one refresh request.
- Tools against a fake Graph: list with nextLink paging and subject lookups, empty list, get (text and raw),
  size cap, transcripts-disabled 403, 404, 401-then-retry.
- Store: refresh token persisted 0600, sign-out clears it, IDs kept.
- e2e in a throwaway preview with real Claude Code and Cursor CLI against the fakes (`scripts/connectors-e2e.js`
  new case): agent lists transcripts and fetches one.
- Real-tenant test by the user at work: sign in, list, fetch one.

## Later (not in this build)

- Daily ingest: write each new transcript as a file to a chosen folder, on a schedule, using
  `connector-transcripts.js`'s list/get functions directly.
- Meetings organised by others (would need a different Graph route and likely more permissions).
