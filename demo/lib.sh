#!/usr/bin/env bash

BASE="${BASE:-http://localhost:8080}"

req() {
  local method="$1" path="$2" data=""
  shift 2
  if [ $# -ge 1 ] && [[ "$1" == \{* ]]; then
    data="$1"
    shift
  fi
  if [ -n "$data" ]; then
    curl -fsS -X "$method" "$BASE$path" -H 'content-type: application/json' -d "$data" "$@"
  else
    curl -fsS -X "$method" "$BASE$path" "$@"
  fi
}

json() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const k=process.argv[1].split(".");let x=v;for(const p of k)x=x?.[p];console.log(x===undefined?"":String(x))})' "$1"
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $desc (expected '$expected', got '$actual')" >&2
    exit 1
  fi
  echo "ok: $desc"
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $desc (missing '$needle' in '$haystack')" >&2
    exit 1
  fi
  echo "ok: $desc"
}

expect_409() {
  local desc="$1"
  shift
  local out
  out=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  assert_eq "$desc" "409" "$out"
}
