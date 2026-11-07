#!/usr/bin/env bash
# HTTP smoke test for the spreadsheet routes (GET /api/fs/sheet, POST /api/fs/sheet/save and /restore, and the
# `sheet` kind on /api/fs/file) against the sheet preview container (vault-sheet-preview, 127.0.0.1:7690).
#
#   scripts/sheet-smoke.sh [base-url]        default http://127.0.0.1:7690
#
# Needs: bash, curl, jq, cmp, node (for the session cookie). It resets the preview vault to its synthetic pristine
# copy first, so it is safe to run repeatedly, and it only ever talks to the preview, which has its own vault copy
# under /opt/vault/sheet-preview: never the real vault. The session cookie comes from
# /opt/vault/sheet-preview/mint-cookie.js (or $SHEET_COOKIE). It is handed to curl through a 0600 temp file, so it
# is neither echoed nor visible on a command line.
set -euo pipefail

BASE="${1:-http://127.0.0.1:7690}"
PREVIEW=/opt/vault/sheet-preview
VAULT=$PREVIEW/vault
BACKUPS=$PREVIEW/backups
PRISTINE=$PREVIEW/pristine/Sandbox

XLSX='Sandbox/Environment Build Action List.xlsx'   # F4 = Open, list Open / In Progress / Closed, merged bands
UNREADABLE='Sandbox/RVTools_export_all.xlsx'        # ExcelJS cannot load it
CSV='Sandbox/servers.csv'
SEMI='Sandbox/semicolon.csv'
BOM='Sandbox/bom-crlf.csv'
name_of() { echo "${1#Sandbox/}"; }

for tool in curl jq cmp node; do
  command -v "$tool" >/dev/null || { echo "sheet-smoke: $tool is required" >&2; exit 2; }
done

HDR=$(mktemp)
BODY=$(mktemp)
BIG=$(mktemp)
trap 'rm -f "$HDR" "$BODY" "$BIG"' EXIT
chmod 600 "$HDR"
printf 'Cookie: %s\n' "${SHEET_COOKIE:-$(node "$PREVIEW/mint-cookie.js")}" > "$HDR"

"$PREVIEW/reset.sh"

# ---- helpers -------------------------------------------------------------------------------------------

PASSES=0
FAILS=0
STATUS=''
ok()  { echo "PASS  $1"; PASSES=$((PASSES + 1)); }
bad() { echo "FAIL  $1${2:+  ($2)}"; FAILS=$((FAILS + 1)); }

enc() { jq -rn --arg s "$1" '$s | @uri'; }

# call METHOD PATH-AND-QUERY [JSON-BODY] [auth|noauth]   ->  $STATUS, and the response body in $BODY
call() {
  local method=$1 url=$BASE$2 data=${3:-} auth=${4:-auth}
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$method")
  if [ "$auth" = auth ]; then args+=(-H "@$HDR"); fi
  if [ -n "$data" ]; then args+=(-H 'Content-Type: application/json' --data-binary "$data"); fi
  STATUS=$(curl "${args[@]}" "$url")
}
# call_file METHOD PATH FILE [auth|noauth]: the JSON body is read from FILE (for bodies too big for an argument)
call_file() {
  local method=$1 url=$BASE$2 file=$3 auth=${4:-auth}
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' --data-binary "@$file")
  if [ "$auth" = auth ]; then args+=(-H "@$HDR"); fi
  STATUS=$(curl "${args[@]}" "$url")
}
get()  { call GET "/api/fs/sheet?path=$(enc "$1")" '' "${2:-auth}"; }
post() { call POST "$1" "$2" "${3:-auth}"; }
save_body()    { jq -nc --arg p "$1" --argjson m "$2" --argjson ops "$3" '{path:$p, mtime:$m, ops:$ops}'; }
restore_body() { jq -nc --arg p "$1" --argjson m "$2" '{path:$p, mtime:$m}'; }
mtime() { jq -c '.mtime // 0' "$BODY" 2>/dev/null || echo 0; }  # 0 when the body is no payload, so a failing run keeps going

status() { # status NAME EXPECTED
  if [ "$STATUS" = "$2" ]; then ok "$1"; else bad "$1" "HTTP $STATUS, wanted $2: $(head -c 200 "$BODY")"; fi
}
jq_ok() { # jq_ok NAME FILTER   (the filter must be truthy on the last response body)
  if jq -e "$2" "$BODY" >/dev/null 2>&1; then ok "$1"; else bad "$1" "$2 -> $(jq -c "$2" "$BODY" 2>&1 | head -c 200)"; fi
}
same_file() { if cmp -s "$2" "$3"; then ok "$1"; else bad "$1" "$2 differs from $3"; fi; }
differs()   { if cmp -s "$2" "$3"; then bad "$1" "$2 is still identical to $3"; else ok "$1"; fi; }
no_abs_path() { # no container path may leak into an error body
  if grep -Eq '/vault|/app/|sheet-backups' "$BODY"; then bad "$1" "body leaks a path: $(head -c 200 "$BODY")"; else ok "$1"; fi
}
owner_is() { # owner_is NAME FILE UID
  local uid; uid=$(stat -c %u "$2" 2>/dev/null || echo missing)
  if [ "$uid" = "$3" ]; then ok "$1"; else bad "$1" "uid $uid"; fi
}

# ---- read: the action list -----------------------------------------------------------------------------------

get "$XLSX"
status 'GET action list: 200' 200
jq_ok  'action list: editable == true'                   '.editable == true'
jq_ok  'action list: kind == xlsx'                       '.kind == "xlsx"'
jq_ok  'action list: F4 list is Open/In Progress/Closed' '.sheets[0].lists[0].items == ["Open","In Progress","Closed"]'
jq_ok  'action list: F4 reads Open'                      '.sheets[0].cells["3,5"].t == "Open"'
jq_ok  'action list: backup == null'                     '.backup == null'
jq_ok  'action list: tooLarge == false, active == 0'     '.tooLarge == false and .active == 0'
M0=$(mtime)

get "$XLSX" noauth
status 'GET with no cookie from this box (localRead): 200' 200

# ---- read: an unreadable workbook is a 200 with an honest reason ---------------------------------------------

get "$UNREADABLE"
status 'GET unreadable workbook: 200' 200
jq_ok  'unreadable: editable == false'                   '.editable == false'
jq_ok  "unreadable: reason contains can't read"          '.reason | contains("can'"'"'t read")'
jq_ok  'unreadable: sheets == []'                        '.sheets == []'

# ---- the `sheet` kind on the other /api/fs routes ------------------------------------------------------------

call GET "/api/fs/file?path=$(enc "$CSV")"
status 'GET /api/fs/file csv: 200' 200
jq_ok  'fs/file csv: kind == "sheet"'                    '.kind == "sheet"'
jq_ok  'fs/file csv: has source'                         '(.source | type) == "string" and (.source | length) > 0'
if jq -j '.source' "$BODY" | cmp -s - "$PRISTINE/$(name_of "$CSV")"; then ok 'fs/file csv: source is the file, byte for byte'; else bad 'fs/file csv: source is the file, byte for byte'; fi
call GET "/api/fs/file?path=$(enc "$XLSX")"
status 'GET /api/fs/file xlsx: 200' 200
jq_ok  'fs/file xlsx: kind == "sheet", no source'        '.kind == "sheet" and (has("source") | not)'
call GET '/api/fs/tree?path=Sandbox'
jq_ok  'fs/tree: csv and xlsx list as sheet'             '[.items[] | select(.name == "servers.csv" or .name == "linux.xlsx") | .kind] == ["sheet","sheet"]'
call GET '/api/fs/recent?hours=720'
status 'fs/recent still works' 200
call GET '/api/fs/find?q=servers'
jq_ok  'fs/find: csv comes back as sheet'                '[.items[] | select(.name == "servers.csv") | .kind] == ["sheet"]'

# ---- write guards --------------------------------------------------------------------------------------------

OPS_F4='[{"op":"set","sheet":0,"r":3,"c":5,"v":"Closed"}]'
post /api/fs/sheet/save "$(save_body "$XLSX" "$M0" "$OPS_F4")" noauth
status 'save without a cookie: 401' 401
same_file 'save without a cookie leaves the file alone' "$VAULT/$XLSX" "$PRISTINE/$(name_of "$XLSX")"
post /api/fs/sheet/restore "$(restore_body "$XLSX" "$M0")" noauth
status 'restore without a cookie: 401' 401

STALE=$(jq -nc --argjson m "$M0" '$m - 5000')
post /api/fs/sheet/save "$(save_body "$XLSX" "$STALE" "$OPS_F4")"
status 'save with a stale mtime: 409' 409
no_abs_path 'stale-mtime error has no path'
same_file 'a 409 leaves the file alone' "$VAULT/$XLSX" "$PRISTINE/$(name_of "$XLSX")"

post /api/fs/sheet/save "$(jq -nc --arg p "$XLSX" --argjson ops "$OPS_F4" '{path:$p, ops:$ops}')"
status 'save without an mtime: 400' 400
post /api/fs/sheet/save "$(jq -nc --arg p "$XLSX" --arg m "$M0" --argjson ops "$OPS_F4" '{path:$p, mtime:$m, ops:$ops}')"
status 'save with a string mtime: 400' 400
post /api/fs/sheet/save "$(save_body "$XLSX" "$M0" '[]')"
status 'save with no ops: 400' 400
post /api/fs/sheet/save "$(save_body "$XLSX" "$M0" '[{"op":"explode","sheet":0}]')"
status 'save with a bad op: 400' 400
post /api/fs/sheet/save "$(save_body "$XLSX" "$M0" '[{"op":"set","sheet":0,"r":3,"c":5,"v":"x"},null]')"
status 'save with a null op: 400' 400
post /api/fs/sheet/save "$(save_body "$XLSX" "$M0" '[{"op":"set","sheet":9,"r":0,"c":0,"v":"x"}]')"
status 'save to a sheet that is not there: 400' 400
post /api/fs/sheet/restore "$(jq -nc --arg p "$XLSX" '{path:$p}')"
status 'restore without an mtime: 400' 400
same_file 'rejected saves leave the file alone' "$VAULT/$XLSX" "$PRISTINE/$(name_of "$XLSX")"
if [ -e "$BACKUPS/$XLSX" ]; then bad 'rejected saves make no backup'; else ok 'rejected saves make no backup'; fi

# ---- bad request bodies: JSON errors, never Express's HTML page with a stack trace ---------------------------
# (the body parser runs ahead of the login gate, so these need no cookie)

no_stack() { # no_stack NAME: the body is JSON and shows no stack or node_modules path
  if jq -e '.error | type == "string"' "$BODY" >/dev/null 2>&1 && ! grep -Eq 'node_modules|/app/|at .*\(|<pre>' "$BODY"; then ok "$1"; else bad "$1" "$(head -c 200 "$BODY")"; fi
}
post /api/fs/sheet/save '{"path":' noauth
status 'malformed JSON, no cookie: 400' 400
jq_ok  'malformed JSON: { error: "Bad request" }' '.error == "Bad request"'
no_stack 'malformed JSON: no stack trace, no node_modules path'
post /api/fs/sheet/restore '{not json' noauth
status 'malformed JSON to restore, no cookie: 400' 400
post /api/fs/sheet/save '{"path":' auth
status 'malformed JSON with a cookie: 400' 400
jq_ok  'malformed JSON with a cookie: { error: "Bad request" }' '.error == "Bad request"'

{ printf '{"path":"%s","mtime":1,"ops":[],"pad":"' "$XLSX"; head -c 2200000 /dev/zero | tr '\0' 'a'; printf '"}'; } > "$BIG"
call_file POST /api/fs/sheet/save "$BIG" noauth
status 'body over 2 MB, no cookie: 413' 413
jq_ok  'oversized body: JSON error says to save in smaller steps' '.error | contains("save in smaller steps")'
no_stack 'oversized body: no stack trace, no node_modules path'
call_file POST /api/fs/sheet/save "$BIG" auth
status 'body over 2 MB with a cookie: 413' 413
call_file POST /api/login "$BIG" noauth
status 'body over 2 MB to another route: 413' 413
jq_ok  'oversized body elsewhere: { error: "That request is too large" }' '.error == "That request is too large"'
no_stack 'oversized body elsewhere: no stack trace'
# every other body-parser error is JSON with its own status too
raw_post() { # raw_post PATH HEADER...: posts '{}' with exactly these headers, no cookie
  local url=$BASE$1; shift
  local args=(-sS -o "$BODY" -w '%{http_code}' -X POST --data-binary '{}')
  for h in "$@"; do args+=(-H "$h"); done
  STATUS=$(curl "${args[@]}" "$url")
}
raw_post /api/fs/sheet/save 'Content-Type: application/json; charset=latin1'
status 'unsupported charset: 415' 415
jq_ok  'unsupported charset: { error: "Bad request" }' '.error == "Bad request"'
no_stack 'unsupported charset: no stack trace, no node_modules path'
raw_post /api/fs/sheet/save 'Content-Type: application/json' 'Content-Encoding: bogus'
status 'unsupported Content-Encoding: 415' 415
jq_ok  'unsupported Content-Encoding: { error: "Bad request" }' '.error == "Bad request"'
no_stack 'unsupported Content-Encoding: no stack trace, no node_modules path'
same_file 'bad bodies leave the file alone' "$VAULT/$XLSX" "$PRISTINE/$(name_of "$XLSX")"

# ---- save, then restore, the action list ---------------------------------------------------------------------

post /api/fs/sheet/save "$(save_body "$XLSX" "$M0" "$OPS_F4")"
status 'save F4 = Closed: 200' 200
jq_ok  'save: F4 now reads Closed'                       '.sheets[0].cells["3,5"].t == "Closed"'
jq_ok  'save: still editable, list still there'          '.editable == true and .sheets[0].lists[0].items == ["Open","In Progress","Closed"]'
jq_ok  "save: backup.mtime is the original file's mtime" "(.backup.mtime != null) and ((.backup.mtime - $M0) | fabs) < 1"
jq_ok  'save: fresh mtime is newer than the original'    ".mtime > $M0"
M1=$(mtime)
differs   'save: the vault file changed'                 "$VAULT/$XLSX" "$PRISTINE/$(name_of "$XLSX")"
same_file 'save: the backup cmp-equals pristine'         "$BACKUPS/$XLSX" "$PRISTINE/$(name_of "$XLSX")"
owner_is  'save: vault file is owned by uid 1000'        "$VAULT/$XLSX" 1000
owner_is  'save: backup is owned by uid 1000'            "$BACKUPS/$XLSX" 1000
if find "$VAULT/Sandbox" "$BACKUPS" -name '*.tmp-*' | grep -q .; then bad 'save: no temp files left behind'; else ok 'save: no temp files left behind'; fi

get "$XLSX"
jq_ok  'GET after save: F4 reads Closed and a backup exists' '.sheets[0].cells["3,5"].t == "Closed" and .backup != null'

post /api/fs/sheet/save "$(save_body "$XLSX" "$M0" "$OPS_F4")"
status 'saving again from the old mtime: 409' 409

post /api/fs/sheet/restore "$(restore_body "$XLSX" "$M1")"
status 'restore: 200' 200
jq_ok  'restore: F4 reads Open again'                    '.sheets[0].cells["3,5"].t == "Open"'
jq_ok  'restore: the swapped-out version is now the backup' '.backup != null'
jq_ok  "restore: mtime is the restored file's"           "((.mtime - $M0) | fabs) < 1"
same_file 'restore: the vault file cmp-equals pristine'  "$VAULT/$XLSX" "$PRISTINE/$(name_of "$XLSX")"

post /api/fs/sheet/restore "$(restore_body "$XLSX" "$(mtime)")"
status 'restore again (swap forward): 200' 200
jq_ok  'swap forward: F4 reads Closed'                   '.sheets[0].cells["3,5"].t == "Closed"'
post /api/fs/sheet/restore "$(restore_body "$XLSX" "$(mtime)")"
status 'restore a third time (swap back): 200' 200
same_file 'third restore is the pristine file again'     "$VAULT/$XLSX" "$PRISTINE/$(name_of "$XLSX")"

# ---- xlsx row insert: merges follow, nothing is lost ---------------------------------------------------------

get "$XLSX"
MI=$(mtime)
MERGES0=$(jq -c '.sheets[0].merges' "$BODY" 2>/dev/null || echo '[]')
ROWS0=$(jq -c '.sheets[0].rowCount' "$BODY" 2>/dev/null || echo 0)
post /api/fs/sheet/save "$(save_body "$XLSX" "$MI" '[{"op":"insertRows","sheet":0,"at":4,"n":2,"like":3}]')"
status 'insertRows save: 200' 200
jq_ok  'insertRows: two more rows'                       ".sheets[0].rowCount == $ROWS0 + 2"
jq_ok  'insertRows: merges intact (shifted, none lost)'  \
  ".sheets[0].merges == ($MERGES0 | map(if .r1 >= 4 then .r1 += 2 | .r2 += 2 elif .r2 >= 4 then .r2 += 2 else . end))"
jq_ok  'insertRows: still editable, list still there'    '.editable == true and .sheets[0].lists[0].items == ["Open","In Progress","Closed"]'
post /api/fs/sheet/restore "$(restore_body "$XLSX" "$(mtime)")"
status 'insertRows then restore: 200' 200
same_file 'restore after insertRows: the pristine file'   "$VAULT/$XLSX" "$PRISTINE/$(name_of "$XLSX")"

# ---- an unreadable workbook cannot be saved ------------------------------------------------------------------

get "$UNREADABLE"
post /api/fs/sheet/save "$(save_body "$UNREADABLE" "$(mtime)" "$OPS_F4")"
status 'save to an unreadable workbook: 422' 422
no_abs_path 'unreadable-save error has no path'
same_file 'unreadable workbook untouched' "$VAULT/$UNREADABLE" "$PRISTINE/$(name_of "$UNREADABLE")"

# ---- csv: dialects, one-cell save, restore -------------------------------------------------------------------

get "$SEMI"
jq_ok  'semicolon csv: dialect'                          '.csv == {"delimiter":";","bom":false,"eol":"\n"}'
get "$BOM"
jq_ok  'bom + CRLF csv: dialect'                         '.csv.bom == true and .csv.eol == "\r\n"'

get "$CSV"
status 'GET csv: 200' 200
jq_ok  'csv: kind == csv, editable, no backup'           '.kind == "csv" and .editable == true and .backup == null'
jq_ok  'csv: dialect'                                    '.csv == {"delimiter":",","bom":false,"eol":"\n"}'
jq_ok  'csv: header row reads hostname, bold (style 0)'  '.sheets[0].cells["0,0"].t == "hostname" and .sheets[0].cells["0,0"].s == 0'
MC=$(mtime)

post /api/fs/sheet/restore "$(restore_body "$CSV" "$MC")"
status 'restore with no backup: 404' 404
no_abs_path 'no-backup error has no path'

post /api/fs/sheet/save "$(save_body "$CSV" "$MC" '[{"op":"set","sheet":0,"r":2,"c":6,"v":"99"}]')"
status 'csv save: 200' 200
jq_ok  'csv save: cell reads 99'                         '.sheets[0].cells["2,6"].t == "99"'
jq_ok  'csv save: dialect kept, backup present'          '.csv.delimiter == "," and .backup != null'
CHANGED=$(diff "$PRISTINE/$(name_of "$CSV")" "$VAULT/$CSV" | grep -c '^[<>]' || true)
if [ "$CHANGED" = 2 ]; then ok 'csv save: diff vs pristine is exactly one line'; else bad 'csv save: diff vs pristine is exactly one line' "$CHANGED changed lines"; fi
EDITED=$(diff "$PRISTINE/$(name_of "$CSV")" "$VAULT/$CSV" | grep -cx '> srv-002,10\.30\.0\.12,rhel,dev,team-c,cache,99,12,150,active' || true)
if [ "$EDITED" = 1 ]; then ok 'csv save: and it is the edited line'; else bad 'csv save: and it is the edited line'; fi
same_file 'csv save: the backup cmp-equals pristine'     "$BACKUPS/$CSV" "$PRISTINE/$(name_of "$CSV")"
owner_is  'csv save: vault file is owned by uid 1000'    "$VAULT/$CSV" 1000
post /api/fs/sheet/restore "$(restore_body "$CSV" "$(mtime)")"
status 'csv restore: 200' 200
same_file 'csv restore: the vault file cmp-equals pristine' "$VAULT/$CSV" "$PRISTINE/$(name_of "$CSV")"

# ---- save identity: the payload names the write VaultOS last made, while the file is still that write ----------

save_id_body() { jq -nc --arg p "$1" --argjson m "$2" --argjson ops "$3" --arg id "$4" '{path:$p, mtime:$m, ops:$ops, saveId:$id}'; }
get "$CSV"
MS=$(mtime)
jq_ok  'GET before any named write: no lastWrite'         'has("lastWrite") | not'
OPS_ID='[{"op":"set","sheet":0,"r":3,"c":6,"v":"7"}]'
post /api/fs/sheet/save "$(save_id_body "$CSV" "$MS" "$OPS_ID" 'XYZ')"
status 'saveId that is not lowercase hex: 400' 400
post /api/fs/sheet/save "$(save_id_body "$CSV" "$MS" "$OPS_ID" "$(printf 'a%.0s' $(seq 65))")"
status 'saveId over 64 characters: 400' 400
post /api/fs/sheet/save "$(jq -nc --arg p "$CSV" --argjson m "$MS" --argjson ops "$OPS_ID" '{path:$p, mtime:$m, ops:$ops, saveId:12}')"
status 'saveId that is a number: 400' 400
same_file 'bad saveIds leave the file alone' "$VAULT/$CSV" "$PRISTINE/$(name_of "$CSV")"
post /api/fs/sheet/save "$(save_id_body "$CSV" "$MS" "$OPS_ID" '0a1b2c3d')"
status 'save with saveId: 200' 200
jq_ok  'save answer carries lastWrite.id'                 '.lastWrite.id == "0a1b2c3d"'
MS2=$(mtime)
get "$CSV"
jq_ok  'GET after it: lastWrite.id is that saveId'        '.lastWrite.id == "0a1b2c3d"'
touch -d '+5 seconds' "$VAULT/$CSV"
get "$CSV"
jq_ok  'GET after an outside change (new mtime): no lastWrite' 'has("lastWrite") | not'
post /api/fs/sheet/restore "$(jq -nc --arg p "$CSV" --argjson m "$(mtime)" '{path:$p, mtime:$m, saveId:"beef"}')"
status 'restore with saveId: 200' 200
jq_ok  'restore answer carries lastWrite.id'              '.lastWrite.id == "beef"'
post /api/fs/sheet/save "$(save_body "$CSV" "$(mtime)" "$OPS_ID")"
status 'save without a saveId: 200' 200
jq_ok  'an unnamed save: no lastWrite'                    'has("lastWrite") | not'
get "$CSV"
jq_ok  'GET after the unnamed save: no lastWrite'         'has("lastWrite") | not'
cp -p "$PRISTINE/$(name_of "$CSV")" "$VAULT/$CSV" && chown 1000:1000 "$VAULT/$CSV" && rm -f "$BACKUPS/$CSV"

# ---- csv size cap: GET and save apply one rule at exactly 60,000 cells -----------------------------------------

csv_grid() { # csv_grid FILE ROWS COLS: ROWS rows of COLS cells
  node -e 'const [rows, cols] = process.argv.slice(1).map(Number); const o = [];
    for (let r = 0; r < rows; r++) o.push(Array.from({ length: cols }, (_, c) => r + "-" + c).join(","));
    process.stdout.write(o.join("\n") + "\n")' "$2" "$3" > "$1"
  chown 1000:1000 "$1"
}
csv_grid "$VAULT/Sandbox/cap-exact.csv" 600 100
csv_grid "$VAULT/Sandbox/cap-over.csv" 601 100
OPS_CSV0='[{"op":"set","sheet":0,"r":0,"c":0,"v":"q"}]'
get 'Sandbox/cap-exact.csv'
jq_ok  '600 x 100 csv (60,000 cells): editable, the grid draws it' '.editable == true and .sheets[0].tooBig == false and (.sheets[0].cells | length) == 60000'
post /api/fs/sheet/save "$(save_body 'Sandbox/cap-exact.csv' "$(mtime)" "$OPS_CSV0")"
status '600 x 100 csv: save 200' 200
get 'Sandbox/cap-over.csv'
jq_ok  '601 x 100 csv (60,100 cells): view-only, the grid does not draw it' '.editable == false and .sheets[0].tooBig == true and (.reason | contains("too big to edit"))'
post /api/fs/sheet/save "$(save_body 'Sandbox/cap-over.csv' "$(mtime)" "$OPS_CSV0")"
status '601 x 100 csv: save 422' 422
rm -f "$VAULT/Sandbox/cap-exact.csv" "$VAULT/Sandbox/cap-over.csv" "$BACKUPS/Sandbox/cap-exact.csv"

# ---- xlsx size cap (3 MB) and a workbook with no sheet the grid can draw --------------------------------------

head -c $((3 * 1024 * 1024 + 1)) /dev/urandom > "$VAULT/Sandbox/huge.xlsx"   # not a workbook: proves it isn't parsed
chown 1000:1000 "$VAULT/Sandbox/huge.xlsx"
get 'Sandbox/huge.xlsx'
status 'xlsx over 3 MB: GET 200' 200
jq_ok  'xlsx over 3 MB: tooLarge, view-only, not parsed (no "can'"'"'t read")' '.tooLarge == true and .editable == false and .sheets == [] and (.reason | contains("too big to open"))'
post /api/fs/sheet/save "$(save_body 'Sandbox/huge.xlsx' "$(mtime)" "$OPS_F4")"
status 'xlsx over 3 MB: save 413' 413
head -c $((3 * 1024 * 1024)) /dev/urandom > "$VAULT/Sandbox/huge.xlsx"
get 'Sandbox/huge.xlsx'
jq_ok  'xlsx of exactly 3 MB is parsed (random bytes: unreadable, not too large)' '.tooLarge == false and (.reason | contains("can'"'"'t read"))'
rm -f "$VAULT/Sandbox/huge.xlsx"

# one visible sheet of 601 x 100 (60,100 cells, two cells set), so nothing can be drawn: view-only without a dry run
EXCELJS="$(cd "$(dirname "$0")/.." && pwd)/node_modules/exceljs"
node -e 'const ExcelJS = require(process.argv[1]); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Big");
  ws.getCell("A1").value = "head"; ws.getCell("CV601").value = "tail"; wb.xlsx.writeFile(process.argv[2]);' "$EXCELJS" "$VAULT/Sandbox/all-big.xlsx"
chown 1000:1000 "$VAULT/Sandbox/all-big.xlsx"
get 'Sandbox/all-big.xlsx'
jq_ok  'xlsx whose only sheet is too big: view-only, too big to edit' '.editable == false and .sheets[0].tooBig == true and (.reason | contains("too big to edit"))'
post /api/fs/sheet/save "$(save_body 'Sandbox/all-big.xlsx' "$(mtime)" '[{"op":"set","sheet":0,"r":1,"c":1,"v":"x"}]')"
status 'xlsx whose only sheet is too big: save 422' 422
rm -f "$VAULT/Sandbox/all-big.xlsx"

# ---- path handling -------------------------------------------------------------------------------------------

get '../config.json'
status 'GET ../config.json: 400' 400
no_abs_path '../config.json error has no path'
get 'Sandbox'
status 'GET a folder: 400' 400
get 'Sandbox/definitely-missing.xlsx'
status 'GET a missing file: 404' 404
no_abs_path 'missing-file error has no /vault'
post /api/fs/sheet/save "$(save_body 'Sandbox/definitely-missing.xlsx' 1 "$OPS_F4")"
status 'save to a missing file: 404' 404
no_abs_path 'missing-file save error has no /vault'
post /api/fs/sheet/save "$(save_body '../config.json' 1 "$OPS_F4")"
status 'save to ../config.json: 400' 400

# ---- done ----------------------------------------------------------------------------------------------------

echo
echo "sheet-smoke: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
