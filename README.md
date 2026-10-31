<div align="center">

# VaultOS

**Your notes as a Kanban board, a knowledge base and an AI workbench.**<br>
Plain markdown files. One Docker container. Any coding agent.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/board-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/board-light.png">
  <img alt="The VaultOS board: five columns of task cards, from Backlog to Done" src="docs/images/board-dark.png">
</picture>

</div>

## What you get

### A board that is just files

Every card is a `task.md` in a folder. The `status:` line in it decides the column, so dragging a card edits the file and editing the file moves the card. Open a card to read and tick off its plan.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/card-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/card-light.png">
  <img alt="A card open as a floating panel over the board, showing its goal, plan checklist and progress log" src="docs/images/card-dark.png">
</picture>

### A knowledge base that writes itself

Finish a job and its write-up (`article.md`) lands in the Knowledge Base, with a table of contents, tags, links between articles and PDF export.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/kb-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/kb-light.png">
  <img alt="A Knowledge Base article with a TL;DR, stack tags and an on-this-page outline" src="docs/images/kb-dark.png">
</picture>

### Files and terminals in the browser

Browse and edit every file, and open a terminal in any folder. **Start agent** on a card opens your default coding agent in that task's folder, and the card shows when it is working.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/workbench-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/workbench-light.png">
  <img alt="Files mode with a task.md open and a terminal docked below it" src="docs/images/workbench-dark.png">
</picture>

### Today

Optional: the habits you choose to track, with streaks, a focus timer and a short list for the day. Turn it on in Settings, then add your habits from the Today page.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/today-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/today-light.png">
  <img alt="Today mode: habit tracker, focus timer and the day's tasks" src="docs/images/today-dark.png">
</picture>

## Install on Windows

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) and [Git for Windows](https://git-scm.com/download/win), both installed and Docker Desktop running. Then, in PowerShell:

1. Download VaultOS:
   ```powershell
   git clone https://github.com/ben-utting/VaultOS.git $HOME\vaultos
   cd $HOME\vaultos
   ```
2. Tell it which folder holds your notes (any folder, on any drive; it can be empty):
   ```powershell
   "VAULT_PATH=C:\Users\$env:USERNAME\OneDrive\VaultOS" | Out-File -Encoding ascii .env
   ```
3. Build and start it (about 5 minutes the first time):
   ```powershell
   docker compose up -d --build
   ```
4. Open **http://127.0.0.1:7684** and follow the setup: a password, your boards, your coding agents. (`localhost:7684` works too, but on Windows it can wait two seconds trying IPv6 first.)

**Update to the latest version:**
```powershell
cd $HOME\vaultos
git pull
docker compose up -d --build
```

Your notes and settings are kept. VaultOS starts again whenever Docker Desktop does, unless you stopped it yourself (then press ▶ Start on the `vaultos` container in Docker Desktop). For it to be there after a reboot, turn on **Start Docker Desktop when you sign in** in Docker Desktop's Settings → General.

**Port 7684 already in use?** Add `VAULTOS_PORT=7685` (or any free port) to `.env`, run `docker compose up -d`, and open that port instead.

**Behind a work proxy?** If installing an agent fails with `self-signed certificate in certificate chain`, your network inspects HTTPS. Save its root certificate into the `certs` folder ([certs/README.md](certs/README.md) shows how) and run `docker compose up -d`.

A work OneDrive folder is usually called `OneDrive - <Company>`; use the path File Explorer shows. In OneDrive, right-click the folder and pick **Always keep on this device**, or the container may see empty placeholder files.

**macOS or Linux:** the same steps, with `git clone https://github.com/ben-utting/VaultOS.git ~/vaultos` and `echo "VAULT_PATH=$HOME/VaultOS" > .env`.

## How it works

- **Your folder is the database.** Everything is markdown you can open in any editor, sync with OneDrive or put in git. Delete VaultOS and your notes stay.
- **Eight coding agents, one click each.** Claude Code, the Cursor CLI and Pi are tested with VaultOS; Codex CLI, Antigravity CLI, Copilot CLI, OpenCode and Kilo CLI install and start too, or add any agent by its command. Install as many as you like and pick a default.
- **Agents know the rules.** Setup writes an `AGENTS.md` and `/new-task`, `/done` commands into your folder, so any coding agent creates and closes cards the same way you do.
- **Skills included.** Every agent gets `diagram-design` (diagrams for your articles, by [Cathryn Lavery](https://github.com/cathrynlavery/diagram-design)) and `stop-slop` (plainer writing, by [Hardik Pandya](https://github.com/hardikpandya/stop-slop)). `i-have-adhd` (by [Ayoub Ghriss](https://github.com/ayghri/i-have-adhd)) ships switched off; `AGENTS.md` says how to turn it on. Each keeps its own MIT licence.
- **Private by default.** One password, bound to your own machine. Nothing leaves it except what your chosen agent sends to its own service.

## More

Windows paths, OneDrive, company proxies, environment variables and resetting a password: [docs/portable.md](docs/portable.md).

The screenshots use a made-up demo vault. Agent logos belong to their owners and appear only to name each agent.

## Licence

MIT. See [LICENSE](LICENSE).
