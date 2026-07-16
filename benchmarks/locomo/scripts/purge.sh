#!/bin/bash
# Purge one or more LoCoMo conversations' memories and wait for completion.
# Usage: API_URL=... API_KEY=... ./purge.sh conv-26 [conv-30 ...]
# bash 3.2 compatible (macOS system bash).
set -u
: "${API_URL:?set API_URL}" "${API_KEY:?set API_KEY}"
[ $# -ge 1 ] || { echo "usage: purge.sh <sample_id...>"; exit 1; }

purge_one() {
  local uid="locomo-$1"
  local job s st
  job=$(curl -s -X POST "$API_URL/v1/memories/purge" \
    -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
    -d "{\"scope\":{\"user_id\":\"$uid\"},\"confirm\":true}" |
    python3 -c "import json,sys; print(json.load(sys.stdin)['job_id'])") || return 1
  for _ in $(seq 1 40); do
    s=$(curl -s "$API_URL/v1/memories/purge/status/$job" -H "X-API-Key: $API_KEY")
    st=$(echo "$s" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
    if [ "$st" = "completed" ]; then
      echo "$uid purged: $(echo "$s" | python3 -c "import json,sys; print(json.load(sys.stdin)['memories_deleted'])") rows"
      return 0
    fi
    [ "$st" = "failed" ] && { echo "$uid PURGE FAILED: $s"; return 1; }
    sleep 5
  done
  echo "$uid purge TIMEOUT"
  return 2
}

rc=0
for sid in "$@"; do
  purge_one "$sid" || rc=1
done
exit $rc
