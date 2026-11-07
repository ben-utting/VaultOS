#!/usr/bin/env bash
# Probes one coding agent in a throwaway vaultos:portable container, as the vaultos user:
# installs it, checks it's on a login shell's PATH, prints its --help, and records the
# foreground process name while it runs. Usage: scripts/agent-probe.sh <id>
set -u
id="${1:?usage: agent-probe.sh <id>}"
case "$id" in
  claude)      install='curl -fsSL https://claude.ai/install.sh | bash'; bin=claude ;;
  cursor)      install='curl https://cursor.com/install -fsS | bash'; bin=agent ;;
  pi)          install='npm install -g --prefix ~/.local @mariozechner/pi-coding-agent'; bin=pi ;;
  codex)       install='npm install -g --prefix ~/.local @openai/codex'; bin=codex ;;
  antigravity) install='curl -fsSL https://antigravity.google/cli/install.sh | bash'; bin=agy ;;
  copilot)     install='npm install -g --prefix ~/.local @github/copilot'; bin=copilot ;;
  opencode)    install='npm install -g --prefix ~/.local opencode-ai'; bin=opencode ;;
  kilo)        install='npm install -g --prefix ~/.local @kilocode/cli'; bin=kilo ;;
  *) echo "unknown agent $id" >&2; exit 2 ;;
esac
docker run --rm -e "INSTALL=$install" -e "BIN=$bin" --entrypoint bash vaultos:portable -lc '
  echo "== install: $INSTALL"
  bash -lc "$INSTALL" >/tmp/install.log 2>&1 || { echo "installed: no"; tail -5 /tmp/install.log; exit 0; }
  p=$(bash -lc "command -v $BIN") && echo "installed: yes ($p)" || { echo "installed: no (not on PATH)"; tail -5 /tmp/install.log; exit 0; }
  echo "== help (prompt-related lines)"
  timeout 20 bash -lc "$BIN --help" 2>&1 | grep -iE "prompt|message|query|-i\b|interactive|\[.*(prompt|message).*\]|usage" | head -15
  echo "== process while running"
  ( cd /tmp && timeout 8 script -qfc "bash -lc $BIN" /dev/null >/dev/null 2>&1 & )
  sleep 6
  ps -eo comm=,args= | grep -v -E "^(bash|script|timeout|ps|grep|sleep|tini|sh) " | grep -iE "$BIN|node" | head -3
'
