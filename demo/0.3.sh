#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

echo "— templates: built-in list + /new?template= redirect"
TEMPLATES=$(req GET /api/templates)
assert_contains "agent-team-hq template listed" "agent-team-hq" "$TEMPLATES"
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/new?template=agent-team-hq")
assert_contains "template redirects to live doc" "/d/" "$LOC"

echo "— widgets: submit, review, seed via /new?widget="
WID=$(req POST /api/widgets '{"title":"Vote","category":"tool","html":"<button onclick=\"margin.setState({n:(margin.state.n||0)+1})\">Vote</button>"}')
assert_contains "widget pending" "pending" "$WID"
req POST /api/widgets/vote/review '{"status":"approved"}' >/dev/null
WLOC=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/new?widget=vote")
assert_contains "widget seeds a live doc" "/d/" "$WLOC"

echo "— skills: folder + SKILL.md, release, submit, review, manifest"
JAR=/tmp/wb-owner-cookies.txt
TOKEN=$(req POST /api/tokens '{}' -b "$JAR" 2>/dev/null | json token || true)
if [ -z "$TOKEN" ] || [ "$TOKEN" = "" ]; then
  req POST /api/auth/signup '{"username":"alice","password":"hunter2-secure"}' -c "$JAR" >/dev/null 2>&1 || true
  TOKEN=$(req POST /api/tokens '{}' -b "$JAR" | json token)
fi
SKILL_FOLDER=$(curl -fsS -X POST "$BASE/api/folders" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"name":"Import Auditor"}' | json folder.id)
SKILLDOC=$(curl -fsS -X POST "$BASE/api/docs" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"title":"SKILL.md","content":"# SKILL\n\nAudits imports for unsafe modules.\n"}' | json doc.id)
curl -fsS -X POST "$BASE/api/docs/$SKILLDOC/move" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d "{\"folderId\":\"$SKILL_FOLDER\"}" >/dev/null
printf '#!/usr/bin/env node\nconsole.log("audit ok")\n' >/tmp/audit.js
curl -fsS -X POST "$BASE/api/docs/$SKILLDOC/assets" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/javascript' -H 'X-Asset-Name: scripts/audit.js' --data-binary @/tmp/audit.js >/dev/null
curl -fsS -X POST "$BASE/api/folders/$SKILL_FOLDER/releases" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"notes":"first reviewed release"}' >/dev/null
SHARE_URL=$(curl -fsS -X POST "$BASE/api/folders/$SKILL_FOLDER/shares" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"role":"view"}' | json share.url)
SUBMIT=$(curl -fsS -X POST "$BASE/api/skills" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d "$(node -e 'process.stdout.write(JSON.stringify({shareUrl:process.argv[1],category:"developer"}))' "$SHARE_URL")")
SLUG=$(echo "$SUBMIT" | json slug)
assert_contains "skill submission pending" "pending" "$SUBMIT"
curl -fsS -X POST "$BASE/api/skills/$SLUG/review" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"status":"approved"}' >/dev/null
MANIFEST=$(curl -fsS "$BASE/skills/$SLUG/manifest?v=1")
assert_contains "manifest has SKILL.md" "SKILL.md" "$MANIFEST"
assert_contains "manifest has sha256" "sha256" "$MANIFEST"
assert_contains "manifest has script asset" "scripts/audit.js" "$MANIFEST"
RELEASES=$(curl -fsS "$BASE/api/folders/$SKILL_FOLDER/releases")
assert_contains "release recorded" "first reviewed release" "$RELEASES"

echo "— mde CLI end-to-end"
ROOT="$(cd .. && pwd)"
MDE="pnpm exec tsx $ROOT/cli/src/index.ts"
CLI_DOC=$(MDE_URL="$BASE" MDE_TOKEN="$TOKEN" $MDE new "CLI Demo")
CLI_ID=$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(u.pathname.split("/")[2])' "$CLI_DOC")
curl -fsS -X PUT "$BASE/api/docs/$CLI_ID/content" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"content":"# CLI Demo\n\n```chat #general\n```\n"}' >/dev/null
MDE_URL="$BASE" MDE_TOKEN="$TOKEN" $MDE chat "$CLI_ID" "hello from mde" >/dev/null
EVENTS=$(MDE_URL="$BASE" MDE_TOKEN="$TOKEN" $MDE events "$CLI_ID")
assert_contains "cli chat event visible" "chat.message" "$EVENTS"
ASK_ID=$(MDE_URL="$BASE" MDE_TOKEN="$TOKEN" $MDE ask "$CLI_ID" "please verify")
MDE_URL="$BASE" MDE_TOKEN="$TOKEN" $MDE claim "$CLI_ID" "$ASK_ID" --as cli-bot >/dev/null
MDE_URL="$BASE" MDE_TOKEN="$TOKEN" $MDE resolve "$CLI_ID" "$ASK_ID" -m "verified" >/dev/null
ASKS=$(curl -fsS "$BASE/api/docs/$CLI_ID/asks?state=resolved" -H "Authorization: Bearer $TOKEN")
assert_contains "cli ask resolved" "verified" "$ASKS"
REG=$(MDE_URL="$BASE" MDE_TOKEN="$TOKEN" $MDE register cli-bot --harness cli)
assert_contains "cli register" "registered" "$REG"

echo
echo "0.3 demo passed."
