#!/usr/bin/env bash
# Probes for the connectors feature, in throwaway vaultos:connectors containers (default user).
# Usage: scripts/connector-probe.sh <azure-install|cursor|claude|claude-rpc-error|azure-mcp>
#   azure-install    installs azmcp + the Azure CLI, prints versions, sizes, seconds
#   cursor           installs the Cursor CLI, writes ~/.cursor/mcp.json, lists from two folders
#   claude           installs Claude Code, adds a user-wide http entry with a header, lists it
#   claude-rpc-error as claude, against a local server that answers a JSON-RPC error
#   azure-spike-up   starts the long-running container connectors-spike-azure with the Azure install
#   azure-mcp        runs initialize, tools/list and one read call against azmcp over stdio,
#                    inside the running container $AZ_CONTAINER (default connectors-spike-azure);
#                    set AZURE_TOKEN_CREDENTIALS=AzureCliCredential to pass it through
set -u
mode="${1:?usage: connector-probe.sh <azure-install|azure-spike-up|cursor|claude|claude-rpc-error|azure-mcp>}"
IMG=vaultos:connectors
AZ_INSTALL='npm install -g --prefix ~/.local @azure/mcp >/tmp/npm.log 2>&1 && tail -2 /tmp/npm.log
python3 -m venv ~/.local/share/azure-cli && ~/.local/share/azure-cli/bin/pip install azure-cli >/tmp/pip.log 2>&1 && tail -1 /tmp/pip.log | cut -c1-60
mkdir -p ~/.local/bin && ln -sf ~/.local/share/azure-cli/bin/az ~/.local/bin/az
echo "== az"; az --version | head -1
echo "== azmcp"; azmcp server start --help 2>&1 | head -3
echo "== sizes"; du -sh ~/.local/share/azure-cli ~/.local/lib/node_modules/@azure'

case "$mode" in
  azure-install)
    docker run --rm -e "AZ_INSTALL=$AZ_INSTALL" --entrypoint bash $IMG -lc '
      s=$(date +%s); eval "$AZ_INSTALL"; echo "== elapsed: $(( $(date +%s) - s ))s"' ;;
  azure-spike-up)
    # long-running container with a persistent home volume, the Azure install inside it
    c="${AZ_CONTAINER:-connectors-spike-azure}"
    docker rm -f "$c" >/dev/null 2>&1; docker volume rm connectors-spike-home >/dev/null 2>&1
    docker run -d --name "$c" -v connectors-spike-home:/home/vaultos --entrypoint sleep $IMG infinity
    docker exec -e "AZ_INSTALL=$AZ_INSTALL" "$c" bash -lc 's=$(date +%s); eval "$AZ_INSTALL"; echo "== elapsed: $(( $(date +%s) - s ))s"' ;;
  cursor)
    docker run --rm --entrypoint bash $IMG -lc '
      s=$(date +%s); curl https://cursor.com/install -fsS | bash >/tmp/install.log 2>&1; echo "install: $(( $(date +%s) - s ))s"
      command -v agent || { tail -5 /tmp/install.log; exit 0; }
      mkdir -p ~/.cursor /tmp/a /tmp/b
      # fake stdio MCP server: initialize and tools/list
      cat > /tmp/stdio.js <<JS
let b="";process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);
const out=r=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:r})+"\\n");
if(m.method==="initialize")out({protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"fake",version:"1"}});
else if(m.method==="tools/list")out({tools:[{name:"ping",description:"p",inputSchema:{type:"object",properties:{}}}]});}});
JS
      # fake HTTP MCP server on :9999: logs the X-VaultOS-Key header of every POST
      cat > /tmp/http.js <<JS
require("http").createServer((q,r)=>{let b="";q.on("data",d=>b+=d);q.on("end",()=>{console.error("HTTP",q.method,"x-vaultos-key="+JSON.stringify(q.headers["x-vaultos-key"]));let m={};try{m=JSON.parse(b)}catch{}
r.writeHead(200,{"content-type":"application/json"});
if(m.method==="initialize")r.end(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"fakehttp",version:"1"}}}));
else if(m.method==="tools/list")r.end(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"hping",description:"p",inputSchema:{type:"object",properties:{}}}]}}));
else r.end("{}")})}).listen(9999,"127.0.0.1");
JS
      node /tmp/http.js 2>/tmp/http.log & sleep 1
      cat > ~/.cursor/mcp.json <<JSON
{ "mcpServers": {
  "probe-http": { "url": "http://127.0.0.1:9999/mcp/x", "headers": { "X-VaultOS-Key": "k" } },
  "probe-cmd": { "command": "node", "args": ["/tmp/stdio.js"] } } }
JSON
      echo "== agent mcp --help"; agent mcp --help 2>&1
      echo "== agent --help (approval flags)"; agent --help 2>&1 | grep -iE "approve|trust|force"
      for d in /tmp/a /tmp/b; do echo "== agent mcp list ($d)"; ( cd $d && timeout 60 agent mcp list 2>&1 </dev/null ); echo "exit=$?"; done
      echo "== list-tools"; ( cd /tmp/a && timeout 60 agent mcp list-tools probe-cmd 2>&1 </dev/null; timeout 60 agent mcp list-tools probe-http 2>&1 </dev/null )
      echo "== header seen by the fake HTTP server"; sort /tmp/http.log | uniq -c
      echo "== files under ~/.cursor"; find ~/.cursor -type f | grep -v statsig
      echo "== with nothing listening on :9999"; kill %1; sleep 1; ( cd /tmp/a && timeout 60 agent mcp list 2>&1 </dev/null )' ;;
  claude|claude-rpc-error)
    docker run --rm -e "MODE=$mode" --entrypoint bash $IMG -lc '
      s=$(date +%s); curl -fsSL https://claude.ai/install.sh | bash >/tmp/install.log 2>&1; echo "install: $(( $(date +%s) - s ))s"
      command -v claude || { tail -5 /tmp/install.log; exit 0; }
      mkdir -p /tmp/a /tmp/b
      if [ "$MODE" = claude-rpc-error ]; then
        cat > /tmp/fake.js <<JS
require("http").createServer((q, r) => { q.resume(); q.on("end", () => { r.writeHead(200, {"content-type":"application/json"});
  r.end(JSON.stringify({jsonrpc:"2.0",id:1,error:{code:-32001,message:"x"}})); }); }).listen(9999, "127.0.0.1");
JS
        node /tmp/fake.js & sleep 1
      fi
      claude mcp add-json --scope user probe "{\"type\":\"http\",\"url\":\"http://127.0.0.1:9999/mcp/x\",\"headers\":{\"X-VaultOS-Key\":\"k\"}}" 2>&1
      echo "== mcpServers in ~/.claude.json"; node -e "console.log(JSON.stringify(require(process.env.HOME+\"/.claude.json\").mcpServers,null,1))"
      for d in /tmp/a /tmp/b; do echo "== claude mcp list ($d)"; ( cd $d && timeout 90 claude mcp list 2>&1 </dev/null ); echo "exit=$?"; done' ;;
  azure-mcp)
    c="${AZ_CONTAINER:-connectors-spike-azure}"
    docker exec -i "$c" bash -lc 'cat > /tmp/azmcp-probe.js' <<'JS'
const { spawn } = require("child_process");
const p = spawn(process.env.HOME + "/.local/bin/azmcp", ["server", "start", "--read-only"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let buf = "", err = ""; const waiting = new Map(); let nextId = 1;
p.stderr.on("data", d => { err += d; });
p.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
  if (!l) continue; let m; try { m = JSON.parse(l); } catch { continue; } if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } });
const send = o => p.stdin.write(JSON.stringify(o) + "\n");
const call = (method, params, ms = 90000) => new Promise((res, rej) => { const id = nextId++; waiting.set(id, res);
  setTimeout(() => rej(new Error(method + " timed out\nstderr: " + err.slice(-800))), ms); send({ jsonrpc: "2.0", id, method, params }); });
p.on("exit", c => { if (waiting.size) { console.log("azmcp exited", c, "\nstderr:", err.slice(-800)); process.exit(1); } });
(async () => {
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
  console.log("initialize:", JSON.stringify(init.result ? { server: init.result.serverInfo, protocol: init.result.protocolVersion } : init.error));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tl = await call("tools/list", {});
  const tools = (tl.result && tl.result.tools) || []; console.log("tools (" + tools.length + "):", tools.map(t => t.name).join(", ") || JSON.stringify(tl.error));
  const run = async (name, args) => { const r = await call("tools/call", { name, arguments: args });
    const txt = JSON.stringify(r.result || r.error); console.log(name + ":", txt.slice(0, 1200)); return txt; };
  if (!tools.some(x => x.name === "subscription_list")) { console.log("no subscription_list tool"); p.kill(); return; }
  const subs = await run("subscription_list", {});
  const m = /subscriptionId[^0-9a-f]*([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(subs);
  if (m) await run("group_list", { subscription: m[1] }); else console.log("no subscription id in the answer; group_list skipped");
  p.kill();
})().catch(e => { console.log("error:", e.message); p.kill(); process.exit(1); });
JS
    docker exec -e AZURE_TOKEN_CREDENTIALS="${AZURE_TOKEN_CREDENTIALS:-}" "$c" bash -lc '
      [ -z "$AZURE_TOKEN_CREDENTIALS" ] && unset AZURE_TOKEN_CREDENTIALS; node /tmp/azmcp-probe.js' ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
