# Teams chats connector

The Teams chats connector lets your coding agents read your own Microsoft Teams chats. Agents can list your recent chats and read the messages in one of them. They can't send, edit, react to or delete anything.

It works with any Microsoft 365 work or school account. You register a small app in your own tenant, sign in once as yourself, and VaultOS keeps that sign-in. VaultOS ships no app of its own and never creates one for you.

## What agents can and cannot see

- **Can see:** one-to-one, group and meeting chats you are a member of. Messages arrive as plain text, newest first.
- **Cannot see:** Teams channel posts, chats you aren't in, or other people's chats. Images, files and other attachments are skipped, and the message says how many were left out.
- **Cannot change anything.** There is no tool that sends or changes a message. Every request to Microsoft Graph is a read (`GET /me/chats` and `GET /me/chats/{id}/messages`).

The agent gets three tools: `chats_list` (recent chats with the id of each), `chat_get` (one chat's messages) and `chats_help` (this list, for the agent).

## 1. Register an app in your tenant

You need to be allowed to register apps. Most tenants allow this. If yours doesn't, ask an admin to register it with the settings below and send you its two IDs.

1. Open the Microsoft Entra admin center and go to **App registrations → New registration**.
2. **Name:** anything you'll recognise, for example "VaultOS chats".
3. **Supported account types:** your choice. "Accounts in this organizational directory only" (single tenant) is the simplest.
4. **Redirect URI:** pick **Public client/native (mobile & desktop)** and enter `http://localhost`. Select **Register**.
5. Open **Authentication**:
   - Under **Mobile and desktop applications**, add a second redirect URI: `https://login.microsoftonline.com/common/oauth2/nativeclient`.
   - Under **Advanced settings**, set **Allow public client flows** to **Yes**, then **Save**. VaultOS signs in with a device code, which needs this.
6. Open **API permissions → Add a permission → Microsoft Graph → Delegated permissions** and add exactly these three:
   - `User.Read`
   - `Chat.Read`
   - `offline_access`

   Don't add a client secret or a certificate. VaultOS is a public client and has nowhere to keep one.

Don't add `Chat.ReadWrite`, `Chat.Read.All`, `ChatMessage.Read.All`, `ChannelMessage.Read.All` or any application permission. VaultOS never asks for them, so they would only widen what the app is trusted with.

From the app's **Overview** page, copy the **Directory (tenant) ID** and the **Application (client) ID**.

### Consent

`Chat.Read` is a delegated permission that doesn't need an admin in Microsoft Graph, so normally you approve it yourself the first time you sign in. Some organisations block user consent. If Microsoft's sign-in page says the app needs admin approval, ask an admin to grant consent for `Chat.Read` on your app registration (**API permissions → Grant admin consent**), then sign in again. VaultOS won't ask for more permissions to get round it.

## 2. Sign in from VaultOS

1. Open **Settings → Connectors** and pick **Teams chats**.
2. Paste the Directory (tenant) ID and the Application (client) ID, then select **Sign in**.
3. VaultOS shows a code. Open Microsoft's device page, enter the code and sign in as yourself.
4. When the card says **Connected**, VaultOS adds an entry called `teamschats` to Claude Code and the Cursor CLI. It points at VaultOS on this machine (`http://127.0.0.1:<port>/mcp/teamschats`, where `<port>` is the port VaultOS listens on inside its container, 8080 unless you set `PORT`) and works in every folder.

Ask your agent something like "list my recent Teams chats", then "read the chat with Sam".

**Test** on the card reads your account and one chat, so a lost sign-in or missing consent shows up there.

## Where the sign-in is kept

VaultOS keeps the refresh token in `~/.vaultos/connectors.json` in its own home folder (file mode `0600`). It never goes into your notes folder, the logs, an API answer or an agent's config. Microsoft replaces the refresh token from time to time and VaultOS saves the new one. The short-lived access token is kept in memory only.

Agents reach Teams through VaultOS on this machine and never see a token. An agent that can run shell commands runs as the same user, though, so it could read that file. Keeping tokens out of the agent's config is the extent of the protection.

**Sign out** on the card deletes the refresh token and removes the agent entries. It keeps the two IDs so you can sign in again in one step. To cut access completely, delete the app registration in Entra.

## When it doesn't work

- **"Public client flows are not allowed on this app registration"**: set **Allow public client flows** to **Yes** (step 5).
- **"That app was not found in this directory"**: check both IDs. The tenant ID must be the tenant the app was registered in.
- **"Ask an admin to grant consent for Chat.Read"**, or Microsoft's page asks for admin approval: see [Consent](#consent).
- **"The Teams chats sign-in has run out"**: your organisation ended the sign-in (a password change, an inactive token or a policy). Select **Sign in again**.
- **"Couldn't open that chat: it wasn't found, or you aren't in it"**: the agent asked for a chat you aren't a member of, or an id that isn't from `chats_list`.

Teams transcripts is a separate connector with its own sign-in and permissions. You can use the same app registration for both by adding both sets of permissions, but each connector signs in on its own.
