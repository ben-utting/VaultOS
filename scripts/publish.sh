#!/usr/bin/env bash
# Publishes a clean copy of VaultOS: this repo's committed HEAD, minus everything homelab-only, into a
# separate git repo with its own history. That repo is the one that goes to GitHub; this one (with the
# design notes, homelab compose and full history) never does.
#
#   scripts/publish.sh                     -> /opt/vault/vaultos-public, message "Update YYYY-MM-DD"
#   scripts/publish.sh -m "Add X" [dest]
#
# Refuses to publish when the working tree is dirty, or when any file name or text in the copy matches
# scripts/private-words.txt. Commits locally only; pushing is a separate, deliberate `git push`.
set -euo pipefail

MSG="Update $(date +%F)"
if [ "${1:-}" = "-m" ]; then MSG="$2"; shift 2; fi
SRC="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
DEST="${1:-/opt/vault/vaultos-public}"
WORDS="$SRC/scripts/private-words.txt"
# Homelab-only: design history, agent notes for this box, the live stack's compose and proxy, and the
# dev scripts (they drive previews on this machine). Everything else is the product.
EXCLUDE=(docs/superpowers CLAUDE.md docker-compose.yml Caddyfile scripts)
# ...except what the tests need: invented spreadsheet data for the sheet tests.
KEEP=(scripts/sheet-sandbox.js)
# Commits in the public repo carry a neutral identity unless you say otherwise.
AUTHOR_NAME="${PUBLISH_NAME:-VaultOS}"
AUTHOR_EMAIL="${PUBLISH_EMAIL:-vaultos@users.noreply.github.com}"

fail() { echo "publish: $*" >&2; exit 1; }

[ -f "$WORDS" ] || fail "missing $WORDS"
[ -z "$(git -C "$SRC" status --porcelain)" ] || fail "commit or stash your changes first (only committed work is published)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git -C "$SRC" archive HEAD | tar -x -C "$tmp"
keep="$(mktemp -d)"
trap 'rm -rf "$tmp" "$keep"' EXIT
for p in "${KEEP[@]}"; do mkdir -p "$keep/$(dirname "$p")"; cp "$tmp/$p" "$keep/$p"; done
for p in "${EXCLUDE[@]}"; do rm -rf "${tmp:?}/$p"; done
cp -a "$keep/." "$tmp/"

pattern="$(grep -v '^#' "$WORDS" | grep -v '^[[:space:]]*$' | paste -sd'|')"
[ -n "$pattern" ] || fail "no words in $WORDS"
hits="$( { (cd "$tmp" && find . -mindepth 1 | grep -E "$pattern") || true; grep -rInE "$pattern" "$tmp" | sed "s|^$tmp/||" || true; } )"
if [ -n "$hits" ] || printf '%s' "$MSG" | grep -qE "$pattern"; then
  echo "$hits" | head -40 >&2
  fail "private words found (above); nothing was published"
fi

if [ ! -d "$DEST/.git" ]; then
  mkdir -p "$DEST"
  git -C "$DEST" init -q -b main
  echo "publish: created $DEST"
fi
rsync -a --delete --exclude .git "$tmp/" "$DEST/"
git -C "$DEST" add -A
if git -C "$DEST" diff --cached --quiet; then
  echo "publish: nothing changed since the last publish"
  exit 0
fi
git -C "$DEST" -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" commit -q -m "$MSG"
echo "publish: committed $(git -C "$DEST" rev-parse --short HEAD) in $DEST: $MSG"
git -C "$DEST" diff --stat HEAD~1 2>/dev/null | tail -1 || git -C "$DEST" show --stat --format= HEAD | tail -1
