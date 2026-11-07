# Running VaultOS on your own machine

VaultOS runs as one Docker container. You point it at a folder, open a page in your browser, and a short setup walks you through the rest. Your notes live in that folder. Nothing leaves your machine except what the coding agent you pick sends to its own service.

## What you need

- Docker Desktop (or another Docker-compatible tool, see "Licence note" below).
- A folder for your notes. It can be empty, a new folder, or a folder you already use (a OneDrive or Google Drive folder works).
- The VaultOS image. Until it is published to a registry, you build it yourself (next section).

## Get the image

Until the image is published, build it from the source.

**Option 1: build on the machine that will run it.**

```
git clone https://github.com/ben-utting/VaultOS.git vaultos
cd vaultos
docker build -t vaultos .
```

**Option 2: build on one machine, copy to another.** On the machine that has the source:

```
docker build -t vaultos .
docker save vaultos:latest | gzip > vaultos.tar.gz
```

Copy `vaultos.tar.gz` to the other machine. There, load it:

```
docker load -i vaultos.tar.gz
```

(`docker load` reads gzip files directly.)

## Start it

Pick one of the three ways below. Ways 2 and 3 bind VaultOS to your own machine only (`127.0.0.1`), so nobody else on your network can reach it.

### 1. Docker Desktop, Run dialog

1. Open Docker Desktop, go to Images, and press Run on `vaultos`.
2. Open "Optional settings".
3. Container name: `vaultos`.
4. Ports: set the host port to `7684`. The container port is `8080`.
5. Volumes, first row: host path is your notes folder, container path is `/vault`.
6. Volumes, second row: a named volume `vaultos-home`, container path `/home/vaultos`. This keeps your password, your agent and its sign-in. It is not in your notes folder.
7. Press Run, then open http://127.0.0.1:7684.

The Run dialog only takes a port number, so it may publish the port on all your network interfaces. VaultOS still asks for a password and refuses unknown host names, but if you want it limited to your own machine, use way 2 or 3.

### 2. `docker run`

On Windows (PowerShell), with your own folder:

```
docker run -d --name vaultos --restart unless-stopped -p 127.0.0.1:7684:8080 -v "C:\Users\you\OneDrive\VaultOS:/vault" -v vaultos-home:/home/vaultos vaultos:latest
```

On macOS or Linux:

```
docker run -d --name vaultos --restart unless-stopped -p 127.0.0.1:7684:8080 -v "$HOME/VaultOS:/vault" -v vaultos-home:/home/vaultos vaultos:latest
```

If a container called `vaultos` already exists, remove it first with `docker rm -f vaultos`. Your notes and the `vaultos-home` volume are kept.

On a Linux host where your user id is not 1000, add `--user $(id -u):$(id -g)` so VaultOS can write to your folder. Setup tells you if it cannot.

### 3. `compose.yaml` and `.env`

The repository has a `compose.yaml` for this.

1. Copy `.env.example` to `.env`.
2. In `.env`, set `VAULT_PATH` to your notes folder. It must be set; without it Compose stops with an error.
3. Optional: set `VAULTOS_PORT` (default `7684`).
4. Start it:

```
docker compose up -d
```

Inside the repository folder, `docker compose` reads `compose.yaml`. Stop it with `docker compose down`. Your notes and the home volume stay.

## First launch

Open http://127.0.0.1:7684 (or the port you chose). `localhost` works too, but on Windows it can pause two seconds trying IPv6 first. Setup has five steps.

1. **Folder.** VaultOS checks that your folder is mounted and writable. If it is not mounted, anything you add lives only inside the container and is lost if you remove it. Setup shows the exact `docker run` line to fix that, and a "Continue anyway" button if you only want to try it out.
2. **Password.** At least 8 characters. This signs you in.
3. **Boards.** One or more names, for example "Work". Each board is a folder of task cards.
4. **Coding agents.** Eight agents as tiles (Claude Code, Cursor CLI and Pi tested; Codex CLI, Antigravity CLI, Copilot CLI, OpenCode, Kilo CLI), plus Other and None. Install any of them and pick one as the default; Start agent opens the default. Install and Sign in open a terminal inside VaultOS. You can skip this and do it later in Settings.
5. **Extras.** Today mode (off by default), its time zone, theme and reading font. Press Finish.

Setup's first two steps only work for the first 15 minutes after the container starts. If you run out of time, restart the container (`docker restart vaultos`) and begin again. Boards, agent and the rest need no time limit once you are signed in.

If your folder already has a VaultOS setup in it (from another machine), setup finds it and only asks for the folder check, a password, and the agent.

After setup, Settings has sections for Boards (add, rename, reorder, hide), Features (Today, terminal), Agent, and Password.

Setup also puts a few files at the top of your folder so any coding agent knows how the boards work: `AGENTS.md` (the rules), `/new-task`, `/new-subtask` and `/done` for Claude Code and the Cursor CLI, and two Claude Code hooks in `.claude/`. The hooks only act when Claude is working inside a task's folder: they load that `task.md` into every prompt, and hold Claude back once from stopping while an in-progress task still shows an old `updated:` date. Other agents get the same two rules written in `AGENTS.md`. Setup never overwrites a file that is already there, so if your folder already has a `.claude/settings.json`, add the hooks to it yourself (copy the `hooks` block from a fresh install).

VaultOS terminals use the time zone from Settings → Features, unless you give the container `-e TZ=…` yourself.

## Keep the folder on this device (OneDrive)

If your notes folder is in OneDrive, right-click it in File Explorer and choose "Always keep on this device". Without it, files that are only in the cloud are slow the first time VaultOS reads them, and the board will feel slow.

Google Drive and other sync tools: keep the folder fully downloaded on this machine, for the same reason.

## Signing in to your coding agent

In setup step 4 (or Settings, then Agent), press Install, wait for it to finish, then press Sign in. Both open a terminal inside VaultOS and show what they do.

**Claude Code:** Sign in starts `claude`. Follow its prompts.

**Cursor CLI:** Sign in runs `NO_OPEN_BROWSER=1 agent login`. It prints a link. Open that link in your normal browser and sign in to Cursor there.

**Pi:** Sign in starts `pi`. Type `/login` and pick your provider, or set a provider's API key in the container's environment.

**The others:** Codex CLI runs `codex login --device-auth` (a code to enter at a link); Copilot CLI starts `copilot`, then type `/login`; OpenCode and Kilo CLI run `opencode auth login` and `kilo auth login`; Antigravity CLI starts `agy` and asks you to sign in.

One honest caveat: the Cursor sign-in inside a container has been tested only as far as printing the link. Finishing the sign-in, and having it still be there after a container restart, has not been verified yet. If it does not work for you, use an API key instead. Create a key in your Cursor account, then add it to the container's environment:

```
docker rm -f vaultos
docker run -d --name vaultos --restart unless-stopped -p 127.0.0.1:7684:8080 -v "$HOME/VaultOS:/vault" -v vaultos-home:/home/vaultos -e CURSOR_API_KEY=your-key vaultos:latest
```

(With `compose.yaml`, add `CURSOR_API_KEY` under `environment:` for the service.)

Your agent and its sign-in are in the `vaultos-home` volume. Removing that volume signs you out.

## Behind a company proxy

If your network uses a proxy, the agent installers and the agent itself may fail to connect. VaultOS terminals pass the container's environment on, so set the standard variables when you start the container:

```
-e HTTPS_PROXY=http://proxy.example:8080 -e HTTP_PROXY=http://proxy.example:8080 -e NO_PROXY=localhost,127.0.0.1
```

If the proxy inspects TLS traffic, installing an agent fails with `self-signed certificate in certificate chain` until the container trusts your company's root certificate. Put the certificate (`.crt`, `.cer` or `.pem`) in a folder and mount that folder at `/certs`. On every start VaultOS adds what it finds there to the roots curl, git, npm, pip, Node and the agents trust:

```
-v "C:\certs:/certs:ro"
```

With `compose.yaml`, the repo's own `certs` folder is already mounted. `certs/README.md` has a PowerShell snippet that saves your network's root certificate there.

Restart the container (`docker rm -f vaultos`, then run it again with the extra flags) after changing these.

## Forgot your password

Your notes are not touched. Set a new password from inside the container:

```
docker exec -it vaultos node set-password.js "your new password"
```

It must be at least 8 characters. This also clears any sign-in lockout.

## Moving to a new laptop

Your notes are in the folder, so they move with the folder (or with OneDrive). The password and the agent sign-in are in the `vaultos-home` volume and do not.

1. Install Docker Desktop on the new laptop and get the image (see "Get the image").
2. Make sure your notes folder is on the new laptop.
3. Start VaultOS pointing at it (any of the three ways).
4. Setup finds your existing boards. It asks for the folder check, a new password, and your agent. Install and sign in to the agent again.

## Environment variables

You can set these with `-e NAME=value` (or under `environment:` in Compose). The defaults suit a single machine.

| Variable | Default | What it does |
|---|---|---|
| `VAULT_DIR` | `/vault` | Where the container looks for your notes. Leave it, and mount your folder at `/vault`. |
| `DATA_DIR` | `~/.vaultos` (inside the home volume) | Holds the password config, the lockout file and spreadsheet backups. |
| `PORT` | `8080` | The port inside the container. Change the host side of `-p` instead. |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | The names you may use in the address bar. Anything else is refused. Add a name here only if you reach VaultOS under it (through a reverse proxy, for example). |
| `LOCAL_READ` | off (`1` turns it on) | Lets programs on the same machine read the board without signing in. Leave it off. |
| `SECURE_COOKIE` | off (`1` turns it on) | Only send the sign-in cookie over HTTPS. Turn on if you serve VaultOS over HTTPS. |
| `TRUST_PROXY` | off (`1` turns it on) | Trust the proxy in front of VaultOS. Turn on only behind a reverse proxy. |
| `TERMINAL` | on (`0` turns it off) | `0` removes the terminal, Start agent and the agent setup step completely. For machines where IT wants no shell. |
| `SETUP_WINDOW_MIN` | `15` | How many minutes after start the first two setup steps work. `0` closes them at once. |
| `SHEET_BACKUP_DIR` | `$DATA_DIR/sheet-backups` | Where the one previous version of an edited spreadsheet is kept. |

## Licence note

Docker Desktop is free for personal use and small companies. Larger companies (250 or more staff, or over $10M revenue) need a paid licence. The VaultOS image is a normal Docker image, so Rancher Desktop or Podman Desktop run it too. Check which your employer allows.
