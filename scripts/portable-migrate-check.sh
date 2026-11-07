#!/bin/bash
# Migration check for portable VaultOS: the homelab vault boots on vaultos:portable, and the only change on disk
# is a new .vaultos/settings.json. It works on a copy, never on the vault itself:
#   1. copy the vault, and the live board's password config, into /opt/vault/portable-preview/migrate/
#   2. run today's image (vault-board:latest) on the copy for 15 s, so Board.md catches up with the rules the
#      live board runs. The live service's mounts, pointed at the copy; its code (server.js, lib/, public/)
#      mounted read-only from /opt/vault/board as the live service mounts it, since the image's baked copy is older
#   3. snapshot the size and mtime of every path inside the vault folder
#   4. run vaultos:portable on the copy with the homelab env, with this worktree's code mounted read-only as the
#      portable preview mounts it (the image is older than the code)
#   5. once healthy, snapshot again and diff: only .vaultos and .vaultos/settings.json may appear
#   6. print settings.json and check what it says, then screenshot http://127.0.0.1:7693/ through the same-box
#      read path and check the board renders
#   7. stop, and delete the copy and the screenshots
# The copy holds real notes and the password config, and the screenshots show them. An EXIT trap stops both
# containers and deletes the copy and the screenshots, so neither outlives the run, even on a failure or Ctrl-C.
# --keep-shot keeps the screenshots (in a mode-700 folder; the run prints its path) for a person to look at. Both containers run with --rm, as 1000:1000 (nothing
# in the copy becomes root-owned), outside any compose project, on 127.0.0.1:7693 only. Nothing here touches the
# live board (vault-board, :7684), and the password config is copied, never printed.
#
#   bash scripts/portable-migrate-check.sh [--keep-shot]
#
# Prints a PASS/FAIL line per check; the exit code is 1 when any check failed, 2 on bad usage.
set -euo pipefail
export LC_ALL=C   # one sort order for both snapshots

PV=/opt/vault/portable-preview
MIG="$PV/migrate"
LIVE_VAULT=/opt/vault/vault
LIVE_BOARD=/opt/vault/board
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OLD=portable-migrate-old
NEW=portable-migrate-new
BASE=http://127.0.0.1:7693
KEEP_SHOT=0
case "${1:-}" in
  '') ;;
  --keep-shot) KEEP_SHOT=1 ;;
  *) echo "usage: bash scripts/portable-migrate-check.sh [--keep-shot]" >&2; exit 2 ;;
esac
[ $# -le 1 ] || { echo "usage: bash scripts/portable-migrate-check.sh [--keep-shot]" >&2; exit 2; }
SHOTS=''   # made in step 6

cleanup() {
  docker rm -f "$OLD" "$NEW" >/dev/null 2>&1 || true
  rm -rf "$MIG"
  if [ -n "$SHOTS" ] && [ "$KEEP_SHOT" != 1 ]; then rm -rf "$SHOTS"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fails=0
check() {   # check <name> <0|1>
  if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$BASE$1" || true; }
# -mindepth 1 leaves out the vault folder's own entry: creating .vaultos/ in it always moves its mtime, so it
# would differ on every run. Each entry inside it, new or changed, still shows as its own line.
snapshot() { (cd "$PV" && find migrate/vault -mindepth 1 -printf '%P %s %T@\n' | sort > "$MIG/$1"); }

echo "--- 1. copy the vault and the password config into $MIG"
cleanup   # what a run killed outright (no trap) left behind
install -d -m 700 "$MIG"   # root-only on the host; the containers reach the copy through their mounts
install -d -o 1000 -g 1000 "$MIG/data" "$MIG/data/sheet-backups"
rsync -a "$LIVE_VAULT/" "$MIG/vault/"
install -m 600 -o 1000 -g 1000 "$LIVE_BOARD/config.json" "$MIG/data/config.json"
# The live service mounts these too. Fresh ones: no lockout, and every board shown.
printf '%s\n' '{"attempts":0,"lockedUntil":0,"lockLevel":0}' > "$MIG/data/lockout.json"
printf '%s\n' '{}' > "$MIG/data/workspace-visibility.json"
chown 1000:1000 "$MIG/data/lockout.json" "$MIG/data/workspace-visibility.json"
echo "copied $(find "$MIG/vault" | wc -l) paths"

echo "--- 2. vault-board:latest on the copy for 15 s"
# The board service in /opt/vault/docker-compose.yml, pointed at the copy, with TERMINAL=0. Left out: the home
# volume and the claude binary, which only the terminal uses.
docker run -d --rm --name "$OLD" --init --user 1000:1000 -p 127.0.0.1:7693:8080 \
  -e VAULT_DIR=/vault -e PORT=8080 -e TRUST_PROXY=1 -e SECURE_COOKIE=1 -e TERMINAL=0 \
  -e HOME=/home/coder -e SHELL=/bin/bash -e SHEET_BACKUP_DIR=/app/sheet-backups \
  -v "$MIG/vault:/vault" \
  -v "$MIG/data/config.json:/app/config.json" \
  -v "$MIG/data/lockout.json:/app/lockout.json" \
  -v "$MIG/data/workspace-visibility.json:/app/workspace-visibility.json" \
  -v "$LIVE_BOARD/public:/app/public:ro" \
  -v "$LIVE_BOARD/server.js:/app/server.js:ro" \
  -v "$LIVE_BOARD/lib:/app/lib:ro" \
  -v "$MIG/data/sheet-backups:/app/sheet-backups" \
  vault-board:latest >/dev/null
up=0
for _ in $(seq 15); do
  sleep 1
  if [ "$(code /health)" = 200 ]; then up=1; fi
done
running=$(docker inspect -f '{{.State.Running}}' "$OLD" 2>/dev/null || echo false)
check "vault-board:latest served /health on the copy, and ran the full 15 s" "$([ "$up" = 1 ] && [ "$running" = true ] && echo 1 || echo 0)"
docker stop -t 10 "$OLD" >/dev/null 2>&1 || true
# --rm removes it once stopped; the port must be free before the next one starts.
for _ in $(seq 20); do docker inspect "$OLD" >/dev/null 2>&1 || break; sleep 0.5; done
if [ "$up" != 1 ]; then echo "the current image did not come up: nothing to compare against"; exit 1; fi

echo "--- 3. snapshot before"
snapshot before
echo "$(wc -l < "$MIG/before") paths"

echo "--- 4. vaultos:portable on the copy (DATA_DIR=/data, LOCAL_READ=1, TZ=Europe/London, TERMINAL=0)"
docker run -d --rm --name "$NEW" --user 1000:1000 -p 127.0.0.1:7693:8080 \
  -e DATA_DIR=/data -e LOCAL_READ=1 -e TZ=Europe/London -e TERMINAL=0 \
  -v "$MIG/vault:/vault" \
  -v "$MIG/data:/data" \
  -v "$ROOT/server.js:/app/server.js:ro" \
  -v "$ROOT/lib:/app/lib:ro" \
  -v "$ROOT/public:/app/public:ro" \
  -v "$ROOT/starter-kit:/app/starter-kit:ro" \
  -v "$ROOT/hooks:/app/hooks:ro" \
  vaultos:portable >/dev/null
# Healthy (a 2xx; -f leaves the body out otherwise) and past setup, which only a migrated vault is.
health=''
healthy=0
for _ in $(seq 60); do
  health=$(curl -sf "$BASE/health" || true)
  if printf '%s' "$health" | grep -q '"setup":false'; then healthy=1; break; fi
  sleep 1
done
check "vaultos:portable is healthy with setup done: ${health:-no 2xx answer}" "$healthy"
if [ "$healthy" != 1 ]; then
  echo "vaultos:portable never reported setup done within 60 s. Its log:"
  docker logs --tail 20 "$NEW" 2>&1 || true
  exit 1
fi
docker logs "$NEW" 2>&1 | grep -E '^migrated:|migration failed' || true

echo "--- 5. snapshot after, diff before after"
snapshot after
diff "$MIG/before" "$MIG/after" > "$MIG/diff" || true
cat "$MIG/diff"
# Each changed line's path: everything before its size and mtime.
changed=$(sed -nE 's/^[<>] (.*) [0-9]+ [0-9.]+$/\1/p' "$MIG/diff" | sort -u)
gone=$(grep -c '^<' "$MIG/diff" || true)
check "the diff is exactly the two new lines, .vaultos and .vaultos/settings.json" \
  "$([ "$changed" = $'.vaultos\n.vaultos/settings.json' ] && [ "$gone" = 0 ] && echo 1 || echo 0)"
if [ -n "$changed" ]; then
  while IFS= read -r p; do
    case "$p" in .vaultos|.vaultos/settings.json) ;; *) echo "  also changed: $p" ;; esac
  done <<< "$changed"
fi
check "everything in .vaultos/ belongs to 1000" "$([ -d "$MIG/vault/.vaultos" ] && [ -z "$(find "$MIG/vault/.vaultos" ! -uid 1000)" ] && echo 1 || echo 0)"

echo "--- 6. settings.json, and a screenshot of $BASE/"
cat "$MIG/vault/.vaultos/settings.json" || true
# What the migration should derive from this vault: its five boards (folder names, sorted), Today where its
# habits.md is, the zone from TZ, and no agent (the image has no claude on its PATH).
n=0
while IFS=$'\t' read -r ok name; do
  check "$name" "$ok"
  n=$((n + 1))
done < <(node -e '
  const fs = require("fs");
  let s = null;
  try { s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { /* every part fails below */ }
  const labels = s && Array.isArray(s.boards) ? s.boards.map((b) => b.label) : null;
  const sorted = labels && [...labels].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const parts = [
    ["settings.json: five boards, in alphabetical order by label", !!labels && labels.length === 5 && JSON.stringify(labels) === JSON.stringify(sorted)],
    ["settings.json: Today on, at Personal/Today", !!s && !!s.features && s.features.today === true && !!s.today && s.today.dir === "Personal/Today"],
    ["settings.json: timezone Europe/London", !!s && !!s.today && s.today.timezone === "Europe/London"],
    ["settings.json: agent profile none", !!s && !!s.agent && s.agent.profile === "none"],
  ];
  for (const [name, ok] of parts) console.log(`${ok ? 1 : 0}\t${name}`);
' "$MIG/vault/.vaultos/settings.json")
[ "$n" = 4 ] || check "settings.json could be checked" 0
SHOTS=$(mktemp -d /tmp/portable-migrate-shots.XXXXXX)   # mode 700
shot=0
node - "$BASE" "$SHOTS" <<'JS' && shot=1
'use strict';
// The same-box read path (LOCAL_READ=1): no session. VaultOS opens on its home mode; the Board is one click away.
const PUPPETEER = '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
const CHROME = '/root/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome';
const fs = require('fs');
const [base, shots] = process.argv.slice(2);
(async () => {
  const puppeteer = (await import(PUPPETEER)).default;
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const p = await browser.newPage();
    await p.setViewport({ width: 1600, height: 1000 });
    await p.goto(base + '/', { waitUntil: 'networkidle2' });
    const until = (fn) => p.waitForFunction(fn, { timeout: 15000, polling: 100 }).then(() => true, () => false);
    const opened = await until(() => !document.getElementById('app').classList.contains('hidden'));
    const save = async (name) => { const f = `${shots}/${name}.png`; await p.screenshot({ path: f }); fs.chmodSync(f, 0o600); console.log(`  shot: ${f}`); };
    await save('migrate-home');
    await p.click('#mode-board');
    const board = opened && await until(() => document.getElementById('board-view').getClientRects().length > 0
      && document.querySelectorAll('#board .card').length > 0);
    await save('migrate-board');
    console.log(`${board ? 'PASS' : 'FAIL'} the board renders over the same-box read path`);
    process.exitCode = board ? 0 : 1;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(String(e.message).split('\n')[0]); process.exitCode = 1; });
JS
[ "$shot" = 1 ] || fails=$((fails + 1))

echo "--- 7. stop, and delete the copy and the screenshots"
cleanup
check "the copy is gone" "$([ ! -e "$MIG" ] && echo 1 || echo 0)"
check "no portable-migrate container is left" "$([ -z "$(docker ps -aq --filter name=portable-migrate-)" ] && echo 1 || echo 0)"
if [ "$KEEP_SHOT" = 1 ]; then echo "screenshots kept (--keep-shot): $SHOTS"
else check "the screenshots are gone" "$([ ! -e "$SHOTS" ] && echo 1 || echo 0)"; fi

if [ "$fails" = 0 ]; then echo "all checks passed"; else echo "$fails check(s) failed"; fi
[ "$fails" = 0 ]
