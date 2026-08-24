#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! curl -fsS http://localhost:8080/health >/dev/null 2>&1; then
  echo "Starting can-bang on :8080…"
  DATA_DIR="${DATA_DIR:-./data-demo}" pnpm --filter @can-bang/server dev >/tmp/workbench-demo.log 2>&1 &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
  for i in $(seq 1 60); do
    if curl -fsS http://localhost:8080/health >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
fi

echo "== MVP demo =="
bash demo/mvp.sh
echo "== 0.2 demo =="
bash demo/0.2.sh
echo "== 0.3 demo =="
bash demo/0.3.sh
echo
echo "All demos passed."
