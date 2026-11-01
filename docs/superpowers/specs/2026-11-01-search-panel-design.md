# VaultOS: the search panel (and the one-workspace chip)

Date: 2026-11-01. The owner asked for the header's always-on "Search tasks…" box to become a button, with Ctrl+F opening a fuller search. They also asked for the workspace chip to go when there is only one workspace. Both change the header, and the theme redesign that follows will style the result, so they ship together, before it.

## Intent

The owner isn't always searching, so a permanent search box is wasted header space. When they do search, they want to reach anything in the vault: a task in another workspace, an article, a note, a PDF. The header gets quieter, and search gets stronger.

Success means:
- The header shows a Search button, not a text box, in every mode.
- Ctrl+F (⌘F on a Mac) or Ctrl+K opens the panel from anywhere except a terminal or a file editor. A second Ctrl+F while it is open hands over to the browser's own find.
- One panel finds tasks, articles, notes and files across every visible workspace. A pick opens each in its proper place.
- Filtering the Board, KB or Files tree still works, from the panel, and shows as a removable chip.
- With one visible workspace, the header has no workspace chip.

## Part 0: the one-workspace chip

- Today, with one visible workspace, `#ws-chip` gets `ws-chip-single`: it names the workspace, has no chevron and opens nothing.
- After: with one visible workspace the chip is hidden (`hidden`), the same as before `/api/workspaces` answers. With two or more it is the existing dropdown, unchanged.
- Settings → Workspaces is unchanged, so a workspace can still be added, shown or renamed there.
- `ws-chip-single` and its CSS are removed.

## Part 1: the Search button

- `#search` (the input) is removed from the header. In its place is `#search-btn`, an ordinary header button with the search icon, the label "Search" and a key hint: `Ctrl F`, or `⌘F` on a Mac (`navigator.platform` / `userAgentData`). The hint uses `--muted` and the `--t-xs` size.
- At ≤700px the button is the icon only, with `aria-label="Search"`. It sits where the box was.
- It shows in every mode, Today included (the panel searches everything, so Today has something to search).
- **The filter chip:** when the current mode has a filter applied (the Board's `STATE.query`, the KB's `STATE.kb.query`, the Files tree's `FX.query`), a chip `#search-chip` sits right after the button: `"dentist" ×`. Clicking the text reopens the panel with that query. Clicking × clears that mode's filter. The chip follows the mode: switching from a filtered Board to the KB shows the KB's filter, or nothing.
- The KB dashboard's own search box (`#kb-dash-search`) stays. It is part of that page, not the header.
- Every place that wrote to `$('search').value` writes to the chip instead (`setMode`, `clearAllFilters`, `kb-dash-search`, the workspace switch, workbench.js).

## Part 2: the panel

### Opening and closing
- **Opens:** the button; Ctrl+F / ⌘F; Ctrl+K / ⌘K. One capture-phase `keydown` listener on `document` does it.
- **Doesn't open** when the key comes from inside a terminal (`.xterm`), a text editor (`text-edit.js`'s textarea), a sheet cell editor, or any `input`, `textarea` or `[contenteditable]` other than the panel's own. Those keep the key.
- **A second Ctrl+F / ⌘F** while the panel is open closes it and doesn't `preventDefault`, so the browser's find opens. Ctrl+K while open does nothing.
- **Closes:** Escape, a click on the backdrop, the × in its header, or a pick. Focus goes back to what had it before.
- The overlay follows the doc viewer's Escape rules (see "capture listeners" in the KB notes): the panel bails if another overlay above it owns the key.

### Layout
- **Desktop:** a centred panel 640px wide, at most 70vh tall, 12vh from the top, on a dimmed backdrop. **≤700px:** a full-screen sheet, with the input at the top and the results scrolling under it.
- **Header row:** the search icon, the input (`placeholder="Search tasks, articles, notes and files"`) and a close ×.
- **Filter row,** as segmented controls in the shared selected style:
  - **Type:** All · Tasks · Articles · Notes · Files
  - **Workspace:** All, then each visible workspace, in a compact menu (the `MoreMenu` pattern)
  - **Status:** shown only when Type is Tasks. Any, then the seven statuses, each with its dot.
  - The filters persist for the session (in memory), not across reloads.
- **Results:** grouped under small headings, in this order: Tasks, Articles, Notes, Files. Each group shows at most 5, with a "Show all N" row that switches Type to that group. Each row has:
  - The title, with matched words in `<mark>`.
  - A meta line: the workspace label, then the folder path from the workspace root (`2. Admin / 01-long-title`). A task also gets its status dot and label.
  - A one-line snippet (from the index), with matches marked. Files have no snippet. They show their type and size instead.
- **The Filter row** is always first while there is a query and the current mode can filter: "Filter Board to 'dentist'" (or "Filter Knowledge Base…" or "Filter the Files tree…"). Today has no Filter row.
- **Empty query:** a "Recent" group with the 8 most recently changed tasks and files (`/api/fs/recent` plus the board tasks by `mtime`), so the panel is useful before typing.
- **No hits:** "Nothing matches 'xyz'", plus a "Clear filters" link when Type, Workspace or Status is narrowing.
- **Keys:** ↑/↓ move through the rows (Filter row included) and wrap. Enter picks. Tab moves between the input and the filter controls. The selected row uses the shared selected tint and scrolls into view.

### What a pick does
- **Task:** switches the header workspace to the task's own workspace if it differs, goes to Board mode and opens the drawer (`openTask(path)`).
- **Article:** goes to KB mode in the article's workspace and opens it (`openArticle`).
- **Note** (any other `.md`) and **file:** goes to Files mode and opens it in a tab (the existing Files open path).
- **Filter row:** sets the current mode's filter to the query, closes the panel and shows the chip.

### Search as you type
- Debounced by 150ms. Each keystroke aborts the previous request (`AbortController`). The index's `prefix` option covers the last word.
- Markdown results come from `GET /api/search`. Non-markdown file names come from the existing `GET /api/fs/find`, called in parallel, only when Type is All or Files. Results from both are shown together.
- A failed request shows "Search is unavailable" in the results area, not a toast.

## Part 3: the server

### `GET /api/search`
- Session-authed like every other `/api/*` route.
- **Params:**
  - `q` (required, trimmed, ≤ 200 chars)
  - `kind`: `task` | `article` | `note`, optional
  - `ws`: a workspace key, optional
  - `status`: one of `STATUSES`, optional, only applied when `kind=task`
  - `limit`: 1–50, default 30
- **What it does:**
  - Runs `searchIndex.search(q, { prefix: true, kind, under, limit: limit * 3 })`, where `under` is the workspace's dir when `ws` is given.
  - Then drops hits outside the visible workspaces. **Hidden workspaces and folders that aren't a workspace are left out** (the owner's call).
  - Then drops the status mismatches, and caps at `limit`.
- **Each result:** the index fields (`path`, `kind`, `title`, `date`, `snippet`), plus:
  - `ws` (key) and `wsLabel`
  - `folder`: the path between the workspace root and the file, `/`-joined, with the trailing `task.md`/`article.md` dropped
  - `status`, for tasks only
- **Status comes from the index:** `parseDoc` in `lib/search.js` keeps `meta.status` on the doc, and `search()` returns it for tasks. This is a small, additive change, so the CLI and the recall hook ignore the new field.
- **Paths it never returns:** `Personal/Today/` (the Board and KB scans skip it too), `_tasks/`, and anything `SKIP_DIRS` already skips.

### `GET /api/fs/find`
- Unchanged. The panel uses it for non-markdown files and drops `.md` hits (the index covers those).
- Results outside the visible workspaces are dropped in the client, by matching the path prefix against the workspace list.

## Testing

- **`test/search-route.test.js`** (node:test, on the server with a fixture vault). It covers:
  - `q` required
  - `kind`, `ws` and `status` filtering
  - hidden workspaces excluded
  - non-workspace folders excluded
  - `Personal/Today` excluded
  - the `folder` and `wsLabel` fields
  - `limit` clamped
  - unauthenticated requests getting 401
- **`test/search.test.js`** gains: a task doc's `status` comes back, and a note's doesn't.
- **A puppeteer check** on a throwaway preview with `TERMINAL=1`, at 1600×1000 and 390×844. It checks:
  - the button is in the header and no text box is
  - Ctrl+F, ⌘F and Ctrl+K open the panel
  - a second Ctrl+F closes it without `preventDefault`
  - Ctrl+F inside a terminal and inside the text editor doesn't open it
  - typing finds a task in another workspace, and Enter opens its drawer in that workspace
  - an article opens in the KB, a note in Files and a PDF in Files
  - the Filter row filters the Board and shows the chip, and × clears it
  - a hidden workspace's task never appears
  - Escape restores focus
  - the phone layout is a full sheet with the input visible above the keyboard area
  - with one visible workspace the chip is gone, and with two it opens its menu
- The look-tokens test stays green: type sizes come only from `--t-*`, and there are no new gold fills.
- The full suite runs in the image, as before.

## Release

- `server.js` and `lib/search.js` change, so the release is a merge plus `docker restart vault-board` (open terminals end). The owner runs it.
- Work happens in the worktree `/opt/vault/board-search` (branch `search-panel`), and the preview is a throwaway container.
- Before the push, run the private-words check on the added lines. Fixtures use neutral workspace names.

## Out of scope

- The theme redesign (next, through `impeccable`, styling this header as built).
- Searching inside PDFs or spreadsheets.
- Saved searches and search history.
- Other global shortcuts.
