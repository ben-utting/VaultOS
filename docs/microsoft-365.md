# Teams and Outlook connectors

VaultOS has three read-only Microsoft 365 connectors. Each lets your coding agents read something of yours, and none of them can change anything.

| Connector | Agents can | Permission |
| --- | --- | --- |
| **Teams chats** | list your recent chats and read one chat's messages | `Chat.Read` |
| **Outlook mail** | list a folder, search your mailbox and read one message | `Mail.Read` |
| **Outlook calendar** | list your events for some days and read one event | `Calendars.Read` |

They work with any Microsoft 365 work or school account. You register a small app in your own tenant, sign in as yourself, and VaultOS keeps the sign-in. VaultOS ships no app of its own and never creates one for you.

Every agent installed in VaultOS gets them: Claude Code, the Cursor CLI, Codex CLI, Copilot CLI, OpenCode, Kilo CLI and Antigravity CLI (Pi has no MCP support). So do VaultOS's other connectors. For the Cursor CLI you can use Cursor's own Teams and Outlook connectors instead; see [Cursor's own connectors](#cursors-own-connectors).

## What agents can and cannot see

- **Teams chats:** one-to-one, group and meeting chats you are a member of, as plain text, newest first. Not channel posts, not chats you aren't in. Images, files and other attachments are skipped, and the message says how many were left out.
- **Outlook mail:** your own mailbox: inbox, sent items, drafts, archive, deleted items and junk, and search across all of them. Bodies come as plain text. Attachments are never opened; a message only says it has some. Not shared or other people's mailboxes.
- **Outlook calendar:** your own calendar, recurring events as their single occurrences, times in UTC, with attendees, their responses and the meeting link. Not shared or other people's calendars.
- **Nothing changes anything.** No tool sends, replies, moves, deletes, accepts or declines. Every request to Microsoft Graph is a read.

## 1. Register an app in your tenant

One app registration can serve all three connectors. Add the permissions for the ones you want. You need to be allowed to register apps; if you aren't, ask an admin to register it with the settings below and send you its two IDs.

1. Open the Microsoft Entra admin center and go to **App registrations → New registration**.
2. **Name:** anything you'll recognise, for example "VaultOS".
3. **Supported account types:** your choice. "Accounts in this organizational directory only" (single tenant) is the simplest.
4. **Redirect URI:** pick **Public client/native (mobile & desktop)** and enter `http://localhost`. Select **Register**.
5. Open **Authentication**:
   - Under **Mobile and desktop applications**, add a second redirect URI: `https://login.microsoftonline.com/common/oauth2/nativeclient`.
   - Under **Advanced settings**, set **Allow public client flows** to **Yes**, then **Save**. VaultOS signs in with a device code, which needs this.
6. Open **API permissions → Add a permission → Microsoft Graph → Delegated permissions** and add `User.Read` and `offline_access`, plus one for each connector you want:
   - Teams chats: `Chat.Read`
   - Outlook mail: `Mail.Read`
   - Outlook calendar: `Calendars.Read`

Don't add a client secret or a certificate: VaultOS is a public client and has nowhere to keep one. Don't add `ReadWrite`, `Send`, `.All` or application permissions either. VaultOS never asks for them, so they would only widen what the app is trusted with.

From the app's **Overview** page, copy the **Directory (tenant) ID** and the **Application (client) ID**.

### Consent

`Chat.Read`, `Mail.Read` and `Calendars.Read` are delegated permissions that don't need an admin in Microsoft Graph, so normally you approve them yourself the first time you sign in. Some organisations block user consent. If Microsoft's sign-in page says the app needs admin approval, ask an admin to grant consent for that permission on your app registration (**API permissions → Grant admin consent**), then sign in again. VaultOS won't ask for more permissions to get round it.

## 2. Sign in from VaultOS

1. Open **Settings → Connectors** and pick **Teams chats**, **Outlook mail** or **Outlook calendar**.
2. Paste the Directory (tenant) ID and the Application (client) ID (after the first connector, the others offer the same two), then select **Sign in**.
3. VaultOS shows a code. Open Microsoft's device page, enter the code and sign in as yourself.
4. When the card says **Connected**, VaultOS adds an entry to each agent: `teamschats`, `outlookmail` or `outlookcalendar`. It points at VaultOS on this machine (`http://127.0.0.1:<port>/mcp/<name>`, where `<port>` is the port VaultOS listens on inside its container, 8080 unless you set `PORT`) and works in every folder.

Each connector signs in on its own, even on the same app registration, so signing one out leaves the others alone. **Test** on a card reads your account and one item, so a lost sign-in or missing consent shows up there.

Ask your agent something like "list my recent Teams chats", "what's unread in my inbox?" or "what's on my calendar tomorrow?".

## Where the sign-in is kept

VaultOS keeps each refresh token in `~/.vaultos/connectors.json` in its own home folder (file mode `0600`). It never goes into your notes folder, the logs, an API answer or an agent's config. Microsoft replaces refresh tokens from time to time and VaultOS saves the new one. Access tokens are kept in memory only.

Agents reach Microsoft through VaultOS on this machine and never see a token. An agent that can run shell commands runs as the same user, though, so it could read that file. Keeping tokens out of the agent's config is the extent of the protection.

**Sign out** on a card deletes that connector's refresh token and removes its agent entries. It keeps the two IDs so you can sign in again in one step. To cut access completely, delete the app registration in Entra.

## Cursor's own connectors

Cursor runs its own Teams, Outlook and Outlook calendar servers on `api.cursor.com`. VaultOS can add them to the Cursor CLI only, as **Teams (Cursor)**, **Outlook (Cursor)** and **Outlook calendar (Cursor)**. While one is on, the Cursor CLI gets it instead of VaultOS's read-only connector; every other agent keeps VaultOS's. Turn it off and Cursor goes back to VaultOS's.

They differ from VaultOS's in three ways:

- **No app registration.** Cursor signs you in with its own Microsoft app, and every request also carries your Cursor login. Your organisation has to allow Cursor's app.
- **Not read-only.** Cursor asks Microsoft for permission to send chat and channel messages, send, move and delete mail, and change calendar events. Agents in Cursor can do those things as you. Each card lists exactly what Cursor asks for.
- **Your data goes through Cursor.** Cursor's servers call Microsoft for you.

To sign in, pick the card and select **Turn on and sign in**. The Cursor CLI's sign-in waits for Microsoft on `localhost` inside VaultOS's container, which your browser can't reach, so:

1. Select **Open Microsoft sign-in** and sign in.
2. Your browser lands on a page that doesn't load, at `localhost:8787`. That's expected.
3. Copy that page's whole address, paste it into the card and select **Finish sign-in**.

VaultOS checks that the address belongs to the sign-in it started, hands it to the waiting Cursor CLI, and doesn't keep it. Cursor holds that sign-in, not VaultOS: **Turn off** takes the entry out of Cursor's config, and Cursor keeps its sign-in. The Cursor CLI asks you once to approve each server it hasn't used in a folder before.

## When it doesn't work

- **"Public client flows are not allowed on this app registration"**: set **Allow public client flows** to **Yes** (step 5).
- **"That app was not found in this directory"**: check both IDs. The tenant ID must be the tenant the app was registered in.
- **"Ask an admin to grant consent for …"**, or Microsoft's page asks for admin approval: see [Consent](#consent).
- **"The … sign-in has run out"**: your organisation ended the sign-in (a password change, an inactive token or a policy). Select **Sign in again**.
- **"… wasn't found, or you aren't in it"**: the agent asked for a chat, message or event that isn't yours, or an id that didn't come from the list tools.
- **An agent doesn't show the connector**: VaultOS never overwrites an entry an agent already has under the same name, and leaves a config file alone if it can't read it (for example a `.jsonc` file with comments). The connector's card says which agent and why.

Teams transcripts is a separate connector with its own sign-in and permissions. It can use the same app registration too.
