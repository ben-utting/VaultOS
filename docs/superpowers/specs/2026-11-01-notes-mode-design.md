# VaultOS: Notes mode (capture, Inbox, writing room)

Date: 2026-11-01. The owner thinks a lot during the day but writes little. They want VaultOS to be the place where a passing thought gets written down in seconds, and where the best of those thoughts later grow into proper notes in their linked-notes system (one idea per note, in their own words). The Board is not the place for this.

## Intent

Two different moments, connected:

- **Capture.** A thought arrives mid-day. It must be on disk in a few seconds, from any mode, on desktop or phone (dictation included), without choosing a title, tag or folder.
- **Develop.** Later, with time to sit down, a rough thought becomes a Main Note: one idea, in the owner's own words, tagged and linked. Claude can help by asking questions, the way `/book` does for reading, but never writes the idea itself.

The owner's note folder already defines the note types: rough notes (fleeting, "reviewed within a day and deleted"), main notes (standalone ideas, from a template with a timestamp, `Status #baby/#child/#adult`, a `Tags [[…]]` line and `## References`), and tag notes (near-empty link targets). Notes mode works on those files as they are, with no import, no frontmatter and no new note format, so Obsidian keeps working on the same files.

Success means:
- From any mode, a thought is saved as its own file in the inbox folder in under five seconds, and the owner is back where they were.
- On the phone, a home-screen long-press opens straight into the capture box.
- The Inbox shows every rough note, newest first, and old ones stand out.
- A rough note can be developed into a Main Note from the template, written in a calm editor, with tags, status and `[[links]]` handled for the owner.
- "Ask me questions" starts the agent on the note; its edits appear in the open editor.

It ships in two releases. **Release 1:** settings, capture, Notes mode with Inbox and Main Notes lists, a plain editor, Done. **Release 2:** the writing room, Develop, Ask me questions.

## Part 1: settings and storage (Release 1)

### Settings
`lib/settings.js` gains a `notes` section and a `features.notes` flag:

```json
"features": { "notes": true },
"notes": {
  "dir": "Notes",
  "inbox": "Inbox",
  "main": "Main",
  "tags": "Tags",
  "template": "Templates/Note.md"
}
```

- `features.notes` defaults to `false`. With it off, nothing in this spec shows: no mode button, no capture button, no shortcut, and the routes answer 404.
- Defaults for the `notes` section are the values above. The owner's own `settings.json` points them at their existing folders; no folder name of theirs is in the code. `dir` is relative to the vault root. `inbox`, `main`, `tags` and `template` are relative to `dir`.
- Validation: each value is a non-empty string, has no `..` segment, is not absolute, and contains no NUL. `inbox`, `main` and `tags` must be different folders.
- `GET /api/me` gains `notes: { enabled, dir, inbox, main, tags }` so the client knows what to show.

### A capture is one file
- **Folder:** `<dir>/<inbox>/`.
- **Name:** `YYYY-MM-DD HHMM <first words>.md`, using London time from the configured `today.timezone` (the same `Intl` path Today uses; no bare `toISOString()`).
  - First words: the first line of the text, with the characters `/ \ : * ? " < > | # ^ [ ]` and control characters removed, whitespace collapsed, then cut at a word boundary so the whole name, without `.md`, is at most 60 characters. If nothing is left, the name is just the timestamp.
  - A name that exists gets ` 2`, ` 3`… before `.md`.
- **Content:** the timestamp `YYYY-MM-DD HH:MM`, a blank line, then the text exactly as typed, ending with one newline. No frontmatter.
- **Refused:** empty or whitespace-only text, NUL bytes, more than 1 MB (`FS_TEXT_MAX`).

### Listing
- **Inbox:** every `.md` directly in `<inbox>/` (not subfolders), newest `mtime` first. Each item: path, name, first non-blank line that isn't the timestamp (up to 120 chars), `mtime`, and `old: true` when `mtime` is more than 7 days ago. Files that were not made by capture (any name) are listed the same way.
- **Main Notes:** every `.md` directly in `<main>/`. Each item: path, title (file name without `.md`), status (from the first line matching `^Status\b`: the first of `#baby`, `#child`, `#adult` on it, else none), tags (the `[[…]]` targets on the first line matching `^Tags\b`), `mtime`. Sorted by `mtime`, newest first.
- Both lists read their folder directly, not through the listings cache (`lib/walk-cache.js`): the folders are small. Each list call reads the folder once and the first 4 KB of each file.

### Writes and safety
- All writes use `lib/atomic-write.js` (temp file then rename) and the sheet store's per-file lock and `mtime` check, as `POST /api/fs/text/save` does. A changed file answers 409 with the current text and `mtime`.
- The container already runs as `1000:1000`, so new files are owned by the same user as Obsidian, Syncthing and the agents.
- Every path a route takes is resolved with the realpath check Files uses since the 2026-10-28 audit and must stay inside `<vault>/<dir>/`. Inbox, Main and Tags operations further check the parent folder.
- If `features.notes` is on but `<dir>` or a configured folder does not exist, the list routes answer 200 with `missing: ["inbox", …]` and Notes mode shows which setting points where. Capture into a missing inbox folder creates it (one level only); other folders are never created by the app.

### Routes (Release 1)
| Route | Does |
|---|---|
| `GET /api/notes` | `{inbox, main, tags, names, missing}`: both lists, the tag names in `<tags>/`, every note name under `<dir>` (for `[[links]]`), and missing folders |
| `POST /api/notes/capture` `{text}` | Creates the rough note; answers `{path, name}` |
| `POST /api/notes/delete` `{path}` | Inbox only. Moves the file to a held copy and answers an undo token |
| `POST /api/notes/undo` `{token}` | Puts a deleted rough note back (within 30 s) |

Opening and saving a note reuse the existing `GET /api/fs/file` (raw text, `mtime`, HTML through `renderBody`) and `POST /api/fs/text/save` (lock, 409, previous version). Writes sit behind the session gate like every other write. The loopback read path may list and read but never writes.

**Delete and undo:** delete renames the file into `<vault>/.vaultos/notes-trash/` with a random name, records the original path in memory against a token, and removes it for good after 30 seconds. Undo renames it back, refusing if a file now exists at the original path. A restart within the 30 seconds leaves the file in `notes-trash/`. On start-up, the server deletes anything in that folder older than a day.

## Part 2: capture (Release 1)

### Opening the box
- **Header pen button** `#capture-btn`, shown at every width and in every mode while `features.notes` is on. Label "New thought", icon only. It sits just before the search button.
- **Ctrl+J / ⌘J** on desktop opens it, from a capture-phase `keydown` listener with the same guards as the search panel's shortcut: not inside `.xterm`, `#fx-edit-box`, a sheet cell editor or any other input, textarea or contenteditable; not while Settings, the document viewers, the Morning read card or the search panel is open; key repeats ignored. If the browser turns out not to let the page take Ctrl+J, pick another unclaimed combination during the build and record it here and in Settings → Appearance's key list.
- **Phone home-screen shortcut:** `manifest.json` gains `"shortcuts": [{ "name": "New thought", "url": "/?capture=1" }]`. On load, `?capture=1` opens the box once the app has signed in, then removes the parameter from the URL with `history.replaceState`.

### The box
- `public/capture.js` (`Capture.open/close/isOpen`). Desktop: a centred panel about 560px wide. ≤700px: a sheet from the bottom, above the keyboard.
- A single `<textarea>`, focused on open, placeholder "What's on your mind?". A real textarea so phone dictation types into it.
- **Save** button and Ctrl+Enter / ⌘Enter. On success: the box closes, the draft is cleared, and a toast says "Saved to <inbox folder name>" with an **Open** action that switches to Notes mode with that note selected.
- **Esc, a backdrop click or ×** closes the box and keeps the draft. The draft lives in `localStorage` (`vaultboard.captureDraft`), read and written in try/catch; without storage the box still works, the draft just doesn't survive a reload.
- **On failure** the box stays open with the text and shows the server's message, or "Couldn't save. Check the connection and try again." Nothing is cleared until the server answers 200.
- While a save is in flight the Save button is disabled, so a double press writes once.
- Nothing else in the box: no title, tags or folder.

## Part 3: Notes mode (Release 1)

- Header modes become `Today · Board · Notes · Files · Knowledge Base`. `#mode-notes` shows only with `features.notes` on. `setMode('notes')` follows the existing pattern, including Refresh keeping your place.
- The workspace chip is dimmed in Notes, as in Files, because Notes reads `notes.dir`, not a workspace.
- **Layout:** list pane and note pane, like the Knowledge Base. ≤700px: one at a time, with a back button, as the KB does.
- **List pane:** two sections, **Inbox (n)** and **Main Notes (n)**.
  - Inbox rows: first line, relative age (`2h`, `3d`), and a muted "old" tag past 7 days.
  - Main Notes rows: title, status as a small `baby`/`child`/`adult` label, and tag names. A filter row above them: status (All, baby, child, adult) and tag (from the notes' tags).
  - The list re-fetches on entering the mode, on Refresh, after any write made in Notes, and every 15 seconds while the mode is visible.
- **Note pane:** the rendered note. `[[Target]]` and `[[Target#anchor]]` become links when a `.md` named `Target` exists anywhere under `<dir>` (Main Notes open in Notes; other files open in Files); otherwise they render muted, not as links.
  - **Edit** swaps in a plain textarea with Save (Ctrl+S) and Cancel, reusing `text-edit.js`'s pattern and the 409 handling (show the change, Load theirs / Keep mine).
  - Inbox notes also show **Done**: delete, then a toast "Removed. Undo" for 30 seconds.
- Empty Inbox: "Nothing waiting. Ctrl+J catches the next thought." (phone: "Tap the pen to catch the next thought.").
- Search: the search panel already returns `.md` notes. A Notes-folder hit opens in Notes mode when `features.notes` is on.

## Part 4: the writing room and Develop (Release 2)

### The writing room
Release 2 replaces the note pane's plain editor (Main Notes and Inbox alike) with `public/note-edit.js`:
- A single centred column, about 70 characters wide, using the `--t-*` type tokens. No line numbers.
- **Autosave** 2 seconds after typing stops, and on leaving the note or the mode. A quiet "Saved" / "Saving…" / "Not saved" marker. The previous-version backup is taken at the first save of an editing session only, so Restore returns to the note as it was before the session.
- **Word count** of the body (everything after the `## <Title>` heading and before `## References`), shown as `412 / 500 words`, amber above 500. Advisory only.
- **`[[` autocomplete:** typing `[[` lists note names under `<dir>` (Main Notes first, then Source Material, then Tags), filtered as you type; Enter inserts `[[Name]]`.
- **Status picker** (`baby · child · adult`) above the text rewrites the `Status` line to `Status #<level>`, keeping a `#quote` tag if present. If there is no `Status` line, it is added after the timestamp line.
- **Tag chips** above the text, from `<tags>/`, at most 4. Adding one rewrites the `Tags` line as `Tags [[a]] [[b]]`. A new tag name creates `<tags>/<name>.md` (empty file) first. Removing a chip only edits the line; the tag file stays.
- **Changed elsewhere:** while a note is open the client checks its `mtime` every 3 seconds (every 1 second while an agent terminal is linked to it). Changed on disk and nothing unsaved: reload in place, keep the cursor near where it was, toast "Updated by Claude" (or "Updated elsewhere" with no agent). Changed with unsaved text: a bar "Changed elsewhere: Load theirs / Keep mine", and autosave pauses until one is chosen.

### Develop
On an Inbox note, **Develop**:
1. Asks for a title in a small prompt, prefilled from the note's first words.
2. `POST /api/notes/develop` `{from, title}` creates `<main>/<title>.md` from `<template>`: `{{date}}` becomes `YYYY-MM-DD` and `{{time}}` `HH:MM` (London time), a bare `Status` line becomes `Status #baby`, and `{{Title}}` becomes the title. The title is cleaned with the same character rules as capture names. If the file exists the route answers 409 with its path, and the client offers "Open the existing note". If the template is missing, a built-in copy of the same layout is used.
3. Opens the new note in the writing room with the rough note beside it, read-only, as raw material (desktop: a side panel; ≤700px: a collapsible panel above). The rough text is not copied into the Main Note.
4. Leaves the rough note alone. The side panel has **Done with rough note**, which is Done from Part 3.

## Part 5: Ask me questions (Release 2)

- A toolbar button in the writing room. It calls `termOpen({cwd: <vault>/<dir>, note: <path>, run: <develop kickoff>})`. The server validates `note` as an existing `.md` inside `<dir>/<main>/` and stores it on the session as `t.note`, alongside `t.task`.
- If a terminal already has that note, the button reads **Go to agent** and calls `goToAgent(id)`. Never two agents on one note.
- The kickoff comes from `lib/agents.js` like Start agent's: for Claude, `/develop <relative path> [from <rough note path>]`; for other profiles, the same instructions as a plain prompt. It keeps the `/i-have-adhd` prefix behaviour Start agent has.
- **The `/develop` command** (`.claude/commands/develop.md` in the owner's vault; a generic copy in the starter kit, in both `.claude` and `.agents` skill locations):
  1. Read the Main Note, the rough note it came from (the kickoff names it when the writing room has one beside the note), and `<dir>/CLAUDE.md` if present. Say in one line where the note stands.
  2. Ask one question at a time, chosen to fit the note: the bigger takeaway with the original context stripped; why it matters to the owner and where they have seen it; whether they believe it and what would change their mind.
  3. Suggest connections from `vault-search` as questions ("close to *X*: same idea or a neighbour?"). Link only what the owner agrees to.
  4. Write the owner's answers into the note in their voice, typos fixed only. Fill Tags (1 to 4, creating missing tag files) and References. Keep the body under 500 words; if a second idea appears, offer a second note.
  5. Never write the idea for the owner. Never raise Status; suggest `#child` once the note links out.
  6. Prose rules as `/book`: no em dashes, one line per paragraph.
- The writing room's change watch (Part 4) shows the agent's edits as they land.

## Errors, at a glance
| Situation | What happens |
|---|---|
| Capture fails (offline, restart, 5xx) | Box stays open with the text and a message |
| Save conflict | 409, then Load theirs / Keep mine; autosave pauses |
| Bad characters or duplicate name | Cleaned; ` 2` appended |
| Path outside `<dir>` (incl. symlink) | 400, nothing written |
| Configured folder missing | Notes mode names the setting and the path |
| Develop title exists | 409, offer to open it |
| Template missing | Built-in layout used |
| Undo after 30 s | "Too late to undo" toast; the file is gone |

## Code layout
- `lib/notes-names.js`: capture file names, title cleaning, collision suffix.
- `lib/notes-parse.js`: first line, Status and Tags reading and rewriting, body word count, template filling.
- `lib/notes-service.js`: listing, capture, save, delete/undo, develop, path checks.
- `server.js`: the `/api/notes/*` routes and the `notes` field on `/api/me`.
- `public/capture.js`, `public/notes.js`, and in Release 2 `public/note-edit.js`.
- `lib/settings.js`: the `notes` section and flag. Settings → Workspaces gains no UI in Release 1; the section is edited in `settings.json`.

## Testing
- Unit tests (`node --test`, run inside the `vault-board` image): names (characters, length cut, empty, collisions, London time across the clock change), Status/Tags parsing and rewriting (missing lines, `#quote` kept, block and inline forms), template filling, path checks (`..`, absolute, symlink out), settings validation, delete/undo timing.
- A preview container on a spare port with a synthetic notes folder made by `scripts/notes-sandbox.js` (neutral note names only), reset per run. Never `:7684`.
- Puppeteer e2e, desktop and phone, Dark and Sepia:
  - R1: open capture by button, shortcut and `?capture=1`; save; draft kept on Esc; failed save keeps text; Inbox shows it; Edit and Save; 409 path; Done and Undo.
  - R2: Develop creates from template; title clash; autosave; status and tags edit the lines; `[[` autocomplete; an outside write reloads in place; unsaved text gets the conflict bar.
- A real look in Chrome before and after each release.

## Shipping
- Built in the worktree `/opt/vault/board-notes` (branch `notes`), never on a branch in `/opt/vault/board`, because `public/` there is served live.
- Each release ends with the owner running the merge and `docker restart vault-board` themselves. The restart ends open VaultOS terminals.
- Before pushing to the public repo: the private-words check on the added lines, and no real note names in fixtures.

## Not in scope
- A Today card for the Inbox count (add later if the Inbox's own count and "old" marks aren't enough).
- Graph view, backlinks pane, heading-anchor autocomplete, moving notes between folders, Source Material editing beyond the plain editor.
- A Settings UI for the `notes` section.
