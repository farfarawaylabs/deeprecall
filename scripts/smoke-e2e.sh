#!/usr/bin/env bash
#
# Post-deploy end-to-end smoke check for Deep Recall.
#
# Ingests a small synthetic conversation for a throwaway user, polls until the
# extracted facts are retrievable through /v1/query, then purges the throwaway
# scope. Fails (nonzero exit) if any step errors or the facts never appear.
#
# Required environment:
#   MEMORY_API_URL   Base URL of the deployed memory-api (e.g. https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev)
#   API_KEY          Product API key (sent as X-API-Key)
#
# Optional environment:
#   POLL_INTERVAL_SECONDS   Seconds between retrieval polls (default: 5)
#   TIMEOUT_SECONDS         Max seconds to wait for facts to appear (default: 90)
#
# Dependencies: curl, jq
set -euo pipefail

: "${MEMORY_API_URL:?MEMORY_API_URL is required (e.g. https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev)}"
: "${API_KEY:?API_KEY is required (product API key for the X-API-Key header)}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-90}"

for dep in curl jq; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "ERROR: required dependency '$dep' not found on PATH" >&2
    exit 1
  fi
done

BASE_URL="${MEMORY_API_URL%/}"
SMOKE_USER_ID="smoke-$(date +%s)"
FAILED=0

log() { printf '[smoke] %s\n' "$*"; }
fail() {
  printf '[smoke] FAIL: %s\n' "$*" >&2
  FAILED=1
}

# api METHOD PATH [JSON_BODY] — curl wrapper. Sets API_STATUS and API_BODY
# globals. MUST be called directly (never via $(...) command substitution —
# a subshell would discard both globals).
API_STATUS=""
API_BODY=""
api() {
  local method="$1" path="$2" body="${3:-}"
  local response
  if [[ -n "$body" ]]; then
    response=$(curl -sS -w '\n%{http_code}' -X "$method" "${BASE_URL}${path}" \
      -H 'Content-Type: application/json' \
      -H "X-API-Key: ${API_KEY}" \
      -d "$body")
  else
    response=$(curl -sS -w '\n%{http_code}' -X "$method" "${BASE_URL}${path}" \
      -H "X-API-Key: ${API_KEY}")
  fi
  API_STATUS="${response##*$'\n'}"
  API_BODY="${response%$'\n'*}"
}

# Purge the throwaway scope. Runs on EXIT so a mid-run failure still cleans up.
CLEANUP_DONE=0
cleanup() {
  [[ "$CLEANUP_DONE" == 1 ]] && return 0
  CLEANUP_DONE=1
  log "Cleaning up: purging scope user_id=${SMOKE_USER_ID}"
  api POST '/v1/memories/purge' "$(jq -n --arg uid "$SMOKE_USER_ID" \
    '{scope: {user_id: $uid}, confirm: true}')" || {
    fail 'purge request failed to send'
    return 0
  }
  if [[ "$API_STATUS" != "202" ]]; then
    fail "purge returned HTTP ${API_STATUS}: ${API_BODY}"
    return 0
  fi
  local job_id
  job_id=$(jq -r '.job_id // empty' <<<"$API_BODY")
  log "Purge accepted (job ${job_id:-unknown})"
}
trap cleanup EXIT

log "Target: ${BASE_URL}"
log "Throwaway scope: user_id=${SMOKE_USER_ID}"

# ── Step 1: health ──────────────────────────────────────────
api GET '/v1/health'
if [[ "$API_STATUS" != "200" ]]; then
  fail "health check returned HTTP ${API_STATUS}: ${API_BODY}"
  exit 1
fi
HEALTH_STATUS=$(jq -r '.status // "unknown"' <<<"$API_BODY")
log "Health: ${HEALTH_STATUS}"
[[ "$HEALTH_STATUS" == "ok" ]] || log "WARNING: health status is '${HEALTH_STATUS}', continuing"

# ── Step 2: ingest a synthetic conversation with clear facts ─
CONTENT="User: Hi! Just so you know, my favorite programming language is Zig.
Assistant: Noted! What do you do for work?
User: I work as a marine biologist in Reykjavik. Also, my dog is named Biscuit.
Assistant: A marine biologist in Reykjavik with a dog named Biscuit — got it!"

api POST '/v1/ingest' "$(jq -n --arg uid "$SMOKE_USER_ID" --arg content "$CONTENT" \
  '{content: $content, scope: {user_id: $uid}, source_channel: "chat"}')"
if [[ "$API_STATUS" != "202" ]]; then
  fail "ingest returned HTTP ${API_STATUS}: ${API_BODY}"
  exit 1
fi
INSTANCE_ID=$(jq -r '.instance_id // empty' <<<"$API_BODY")
log "Ingest accepted (workflow instance ${INSTANCE_ID:-unknown})"

# ── Step 3: poll /v1/query until the facts are retrievable ──
# query_hits QUERY PATTERN — 0 if any returned memory content matches PATTERN.
query_hits() {
  local query="$1" pattern="$2"
  api POST '/v1/query' "$(jq -n --arg uid "$SMOKE_USER_ID" --arg q "$query" \
    '{query: $q, scope: {user_id: $uid}, top_k: 10}')" || return 1
  [[ "$API_STATUS" == "200" ]] || return 1
  jq -e --arg re "$pattern" \
    '[.memories[].memory.content | select(test($re; "i"))] | length > 0' \
    <<<"$API_BODY" >/dev/null
}

log "Polling /v1/query for extracted facts (timeout ${TIMEOUT_SECONDS}s)..."
DEADLINE=$(($(date +%s) + TIMEOUT_SECONDS))
RETRIEVED=0
while [[ $(date +%s) -lt $DEADLINE ]]; do
  if query_hits 'What is my favorite programming language?' 'zig'; then
    RETRIEVED=1
    break
  fi
  # Surface workflow progress while waiting (best-effort; ignore errors).
  api GET "/v1/ingest/status/${INSTANCE_ID}" || true
  status=$(jq -r '.status // empty' <<<"$API_BODY" 2>/dev/null || true)
  log "  not yet retrievable (workflow status: ${status:-unknown}); retrying in ${POLL_INTERVAL_SECONDS}s"
  sleep "$POLL_INTERVAL_SECONDS"
done

if [[ "$RETRIEVED" != 1 ]]; then
  fail "fact 'Zig' was not retrievable within ${TIMEOUT_SECONDS}s"
  exit 1
fi
log 'Fact 1 retrievable: favorite language (Zig)'

# ── Step 4: verify a second independent fact ────────────────
if query_hits 'What is the name of my dog?' 'biscuit'; then
  log 'Fact 2 retrievable: dog name (Biscuit)'
else
  fail "fact 'Biscuit' was not retrievable"
fi

# ── Step 5: cleanup + verdict ───────────────────────────────
cleanup
trap - EXIT

if [[ "$FAILED" != 0 ]]; then
  log 'RESULT: FAIL'
  exit 1
fi
log 'RESULT: PASS'
