#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

echo "— creating anonymous doc"
CREATED=$(req POST /new '{"title":"MVP HQ","content":"# MVP HQ\n"}')
ID=$(echo "$CREATED" | json id)
KEY=$(echo "$CREATED" | json key)
assert_contains "created doc has id" "$ID" "$CREATED"

echo "— seeding board + status + chat"
CONTENT='# MVP HQ

## Board

```board #tickets
## Todo
- [ ] Ship the API @builder-1 #p1
  done-means: a first-time user can do the thing on the live app
## Doing
## Done
```

## Status

```status
state: building
```

## Chat

```chat #general
```
'
VERSION=$(curl -fsS -X PUT "$BASE/api/docs/$ID/content" -H 'content-type: application/json' -H "x-share-key: $KEY" -d "$(node -e 'const c=process.argv[1];process.stdout.write(JSON.stringify({content:c}))' "$CONTENT")" | json version)
assert_contains "version returned" "$VERSION" "$VERSION"

echo "— minting suggest link and verifying role enforcement"
SUGGEST_KEY=$(req POST "/api/docs/$ID/shares" '{"role":"suggest"}' -H "x-share-key: $KEY" | json share.secret)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/docs/$ID/content" -H 'content-type: application/json' -H "x-share-key: $SUGGEST_KEY" -d '{"content":"hijack"}')
assert_eq "suggest key cannot replace content" "403" "$CODE"

echo "— optimistic concurrency: stale write gets 409, retry succeeds"
V1=$(curl -fsS "$BASE/api/docs/$ID/content" -H "x-share-key: $KEY" -D - -o /dev/null | tr -d '\r' | awk -F': ' '/^x-doc-version/{print $2}')
expect_409 "stale If-Match write refused" -X PUT "$BASE/api/docs/$ID/content" -H 'content-type: application/json' -H "x-share-key: $KEY" -H "if-match: stale-version" -d '{"content":"# nope"}'
NEWV=$(curl -fsS -X PUT "$BASE/api/docs/$ID/content" -H 'content-type: application/json' -H "x-share-key: $KEY" -H "if-match: $V1" -d "$(node -e 'process.stdout.write(JSON.stringify({content:process.argv[1]}))' "$CONTENT")" | json version)
assert_contains "version bumped after retry" "$NEWV" "$NEWV"

echo "— blind-wipe guard"
LONG=$(printf '# Big doc\n\n%.0s' {1..200})
LONGDOC=$(req POST /new "$(node -e 'process.stdout.write(JSON.stringify({content:process.argv[1]}))' "$LONG")")
LONGID=$(echo "$LONGDOC" | json id)
LONGKEY=$(echo "$LONGDOC" | json key)
WIPE_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/docs/$LONGID/content" -H 'content-type: application/json' -H "x-share-key: $LONGKEY" -d '{"content":""}')
assert_eq "empty overwrite without proof is refused" "409" "$WIPE_CODE"

echo "— chat + status + events"
req POST "/api/docs/$ID/chat/message" "{\"text\":\"preview is live, sanity-check it\",\"author\":\"builder-1\"}" -H "x-share-key: $KEY" >/dev/null
req POST "/api/docs/$ID/status" '{"state":"awaiting-human","note":"Need a decision on pricing copy: option A or B","headline":"Pricing copy decision needed"}' -H "x-share-key: $KEY" >/dev/null
EVENTS=$(req GET "/api/docs/$ID/events?since=0" -H "x-share-key: $KEY")
assert_contains "chat.message event" "chat.message" "$EVENTS"
assert_contains "status.changed event" "status.changed" "$EVENTS"

echo
echo "MVP demo passed. Agent prompts:"
echo
cat <<EOF
Codex / Claude / Cursor prompt:
  Read http://localhost:8080/agents.md,
  then work the doc at http://localhost:8080/d/$ID?key=$KEY
  (board + status + chat) — claim a card, post progress, and flag me when you need a human.
EOF
