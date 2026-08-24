#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

JAR=/tmp/wb-owner-cookies.txt
rm -f "$JAR"

echo "— signing up owner + minting token"
req POST /api/auth/signup '{"username":"matt","password":"hunter2-secure"}' -c "$JAR" >/dev/null
TOKEN=$(req POST /api/tokens '{}' -b "$JAR" | json token)
assert_contains "mgn_ token minted" "mgn_" "$TOKEN"

echo "— owner creates doc; agent registers"
CREATED=$(curl -fsS -X POST "$BASE/api/docs" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"title":"Team HQ","content":"# Team HQ\n\n```board\n## Todo\n- [ ] Fix the import\n## Doing\n## Done\n```\n\n```status\nstate: building\n```\n\n```chat #general\n```\n"}')
ID=$(echo "$CREATED" | json doc.id)
curl -fsS -X POST "$BASE/api/agents/register" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"name":"scout","harness":"codex"}' >/dev/null
curl -fsS -X POST "$BASE/api/agents/heartbeat" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"name":"scout","currentTask":"auditing imports"}' >/dev/null
AGENTS=$(curl -fsS "$BASE/api/agents" -H "Authorization: Bearer $TOKEN")
assert_contains "agent registered" "scout" "$AGENTS"

echo "— ASK lifecycle: create, atomic claim (second claimer gets 409), resolve"
ASK=$(curl -fsS -X POST "$BASE/api/docs/$ID/asks" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"text":"Investigate the failing import"}' | json ask.id)
curl -fsS -X POST "$BASE/api/docs/$ID/asks/$ASK/claim" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"agent":"scout"}' >/dev/null
expect_409 "second claim refused (CAS)" -X POST "$BASE/api/docs/$ID/asks/$ASK/claim" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"agent":"builder-1"}'
curl -fsS -X POST "$BASE/api/docs/$ID/asks/$ASK/resolve" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"note":"fixed in the parser"}' >/dev/null
ASKS=$(curl -fsS "$BASE/api/docs/$ID/asks?state=resolved" -H "Authorization: Bearer $TOKEN")
assert_contains "ask resolved" "resolved" "$ASKS"

echo "— suggestion lifecycle: propose, accept"
curl -fsS -X POST "$BASE/api/docs/$ID/suggestions" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"type":"replace","find":"Fix the import","text":"Fix the import with retries"}' >/dev/null
SUGG=$(curl -fsS "$BASE/api/docs/$ID/suggestions" -H "Authorization: Bearer $TOKEN")
assert_contains "suggestion pending" "pending" "$SUGG"
SID=$(echo "$SUGG" | json suggestions.0.id)
curl -fsS -X POST "$BASE/api/docs/$ID/suggestions/$SID" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"action":"accept"}' >/dev/null
CONTENT=$(curl -fsS "$BASE/api/docs/$ID/content" -H "Authorization: Bearer $TOKEN")
assert_contains "accepted suggestion applied" "with retries" "$CONTENT"

echo "— folders + search scope"
FOLDER=$(curl -fsS -X POST "$BASE/api/folders" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"name":"Projects"}' | json folder.id)
curl -fsS -X POST "$BASE/api/docs/$ID/move" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d "{\"folderId\":\"$FOLDER\"}" >/dev/null
SEARCH=$(curl -fsS "$BASE/api/search?q=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("import folder:\"Projects\""))')" -H "Authorization: Bearer $TOKEN")
assert_contains "search finds doc in folder" "$ID" "$SEARCH"

echo "— webhook delivery with signature"
node -e '
const http=require("http");
const fs=require("fs");
const srv=http.createServer((req,res)=>{let b="";req.on("data",d=>b+=d).on("end",()=>{fs.writeFileSync("/tmp/wb-hook.json",JSON.stringify({headers:req.headers,body:b}));res.end("ok")})});
srv.listen(9898,()=>console.log("hook listener on 9898"));
setTimeout(()=>process.exit(0),30000).unref();
' >/tmp/wb-hook-listener.log 2>&1 &
HOOK_PID=$!
sleep 0.5
HKEY=$(curl -fsS -X POST "$BASE/api/docs/$ID/hooks" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"url":"http://localhost:9898/hook","events":["chat.message"],"excludeActor":"scout"}' | json hook.secret)
curl -fsS -X POST "$BASE/api/docs/$ID/chat/message" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"text":"deploying preview"}' >/dev/null
for i in $(seq 1 20); do
  [ -f /tmp/wb-hook.json ] && break
  sleep 0.5
done
kill "$HOOK_PID" 2>/dev/null || true
HOOK_BODY=$(cat /tmp/wb-hook.json 2>/dev/null || echo '{}')
assert_contains "webhook delivered" "chat.message" "$HOOK_BODY"
assert_contains "webhook signed" "x-margin-signature" "$HOOK_BODY"
assert_contains "hmac prefix" "sha256=" "$HOOK_BODY"

echo "— inbox surfaces awaiting-human"
curl -fsS -X POST "$BASE/api/docs/$ID/status" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"state":"awaiting-human","note":"Need the production URL to finish","headline":"Production URL needed"}' >/dev/null
INBOX=$(curl -fsS "$BASE/api/inbox" -H "Authorization: Bearer $TOKEN")
assert_contains "inbox shows awaiting-human" "awaiting" "$INBOX"

echo
echo "0.2 demo passed."
