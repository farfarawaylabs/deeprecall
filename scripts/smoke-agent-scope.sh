#!/bin/bash
# Agent-Scoped Memory Smoke Test (dev)
#
# Exercises the agent-only flow end-to-end: ingest → query → correct → inspect.
# Catches Vectorize metadata-index misconfig early — if the `agent_id` metadata
# index is missing, agent-scoped search will silently return nothing.
#
# Prerequisites:
#   1. All workers deployed to dev (pnpm deploy:dev)
#   2. Migrations applied (pnpm db:migrate:dev)
#   3. Vectorize agent_id metadata index created:
#        pnpx wrangler vectorize create-metadata-index \
#          deeprecall-vectors-default-dev --property-name agent_id --type string
#   4. KV seeded (see docs/DEPLOYMENT.md step 5)
#
# Usage:
#   export API_URL="https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev"
#   export API_KEY="your-dev-api-key"
#   bash scripts/smoke-agent-scope.sh

set -euo pipefail

API_URL="${API_URL:?Set API_URL env var (your deployed memory-api URL)}"
API_KEY="${API_KEY:?Set API_KEY env var (from seed-kv-dev.sh output)}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }
info() { echo -e "${YELLOW}INFO${NC}: $1"; }

AGENT_ID="smoke-agent-$(date +%s)"

# Dependency check — jq is used to parse JSON responses.
if ! command -v jq >/dev/null 2>&1; then
  fail "jq is required but not installed. Install: brew install jq"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo "  Agent-Scoped Memory Smoke Test"
echo "  Agent: $AGENT_ID"
echo "═══════════════════════════════════════════════"
echo ""

# ─── 1. Ingest: agent-only scope (no user_id) ────────────────
info "Test 1: Ingest with agent-only scope"
# Content is phrased as a direct user statement so the LLM extracts it as
# source_type=user_stated. Agent-inferred extractions below 0.7 confidence
# are rejected by the policy engine — which would make this smoke flaky
# against the default extraction template.
INGEST=$(curl -s -X POST "$API_URL/v1/ingest" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"content\": \"USER: Please remember — our Kubernetes clusters must be upgraded monthly for security patches. This is a strict company-wide requirement I need the agent to always enforce.\",
    \"scope\": { \"agent_id\": \"$AGENT_ID\" },
    \"source_channel\": \"api\"
  }")

INSTANCE_ID=$(echo "$INGEST" | jq -r '.instance_id // empty')
if [[ -z "$INSTANCE_ID" ]]; then
  fail "Ingest returned no instance_id: $INGEST"
fi
pass "Ingest accepted (instance: $INSTANCE_ID)"

# Let the workflow run. LLM extraction alone is often 10-15s; add margin.
# Override with: PIPELINE_WAIT_SECS=45 ./scripts/smoke-agent-scope.sh
PIPELINE_WAIT_SECS="${PIPELINE_WAIT_SECS:-30}"
info "Waiting ${PIPELINE_WAIT_SECS}s for pipeline..."
sleep "$PIPELINE_WAIT_SECS"

# Inspect the workflow outcome before the query, so rejections are visible
# even if the query step below returns 0 results.
info "Test 1b: Check workflow status"
STATUS=$(curl -s "$API_URL/v1/ingest/status/$INSTANCE_ID" \
  -H "x-api-key: $API_KEY")
WF_STATUS=$(echo "$STATUS" | jq -r '.status // "unknown"')
WF_SUMMARY=$(echo "$STATUS" | jq -r '.summary // empty')
info "Workflow status: $WF_STATUS — $WF_SUMMARY"

if [[ "$WF_STATUS" != "complete" ]]; then
  # Not necessarily a failure — may still be running. Surface for visibility.
  echo "$STATUS" | jq .
fi

# If the workflow completed with rejections, print them so the operator
# can see *why* nothing landed (e.g., confidence-threshold policy rejection).
REJECTIONS=$(echo "$STATUS" | jq -r '.result.rejections // [] | length')
if [[ "$REJECTIONS" != "0" && "$REJECTIONS" != "null" ]]; then
  info "Workflow reported $REJECTIONS rejection(s):"
  echo "$STATUS" | jq '.result.rejections'
fi

# ─── 2. Query: retrieve by agent-only scope ──────────────────
info "Test 2: Query by agent-only scope"
QUERY=$(curl -s -X POST "$API_URL/v1/query" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"How often should Kubernetes clusters be upgraded?\",
    \"scope\": { \"agent_id\": \"$AGENT_ID\" },
    \"mode\": \"recall\"
  }")

TOTAL=$(echo "$QUERY" | jq -r '.total // 0')
if [[ "$TOTAL" -lt 1 ]]; then
  fail "Agent-scoped query returned 0 results. Is the agent_id metadata index created on Vectorize? Response: $QUERY"
fi
pass "Query returned $TOTAL result(s) for agent-only scope"

MEMORY_ID=$(echo "$QUERY" | jq -r '.memories[0].memory.id')

# ─── 3. Inspect: authorize by agent_id ───────────────────────
info "Test 3: Inspect with matching agent_id"
INSPECT=$(curl -s -w "%{http_code}" -o /tmp/inspect.json \
  "$API_URL/v1/inspect/$MEMORY_ID?agent_id=$AGENT_ID" \
  -H "x-api-key: $API_KEY")

if [[ "$INSPECT" != "200" ]]; then
  cat /tmp/inspect.json
  fail "Inspect with matching agent_id returned $INSPECT (expected 200)"
fi
pass "Inspect authorized with matching agent_id"

# ─── 4. Inspect: rejects wrong scope (leak check) ────────────
info "Test 4: Inspect rejects wrong scope (403, not 404)"
INSPECT_WRONG=$(curl -s -w "%{http_code}" -o /tmp/inspect_wrong.json \
  "$API_URL/v1/inspect/$MEMORY_ID?agent_id=wrong-agent" \
  -H "x-api-key: $API_KEY")

if [[ "$INSPECT_WRONG" != "403" ]]; then
  cat /tmp/inspect_wrong.json
  fail "Inspect with wrong agent_id returned $INSPECT_WRONG (expected 403 — inspect should NOT leak memories across scopes)"
fi
pass "Inspect correctly rejects wrong scope with 403"

# ─── 5. Correct: suppress with agent-only scope ──────────────
info "Test 5: Correct (suppress) with agent-only scope"
CORRECT=$(curl -s -X POST "$API_URL/v1/correct" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"memory_id\": \"$MEMORY_ID\",
    \"action\": \"suppress\",
    \"scope\": { \"agent_id\": \"$AGENT_ID\" },
    \"reason\": \"smoke test cleanup\"
  }")

ACTION=$(echo "$CORRECT" | jq -r '.action // empty')
if [[ "$ACTION" != "suppress" ]]; then
  fail "Correct failed: $CORRECT"
fi
pass "Correction applied (action: $ACTION)"

# ─── 6. Memories list: accepts agent_id-only query ───────────
info "Test 6: List memories with agent_id query param"
LIST=$(curl -s "$API_URL/v1/memories?agent_id=$AGENT_ID" \
  -H "x-api-key: $API_KEY")

LIST_TOTAL=$(echo "$LIST" | jq -r '.total // 0')
info "List returned $LIST_TOTAL memories (may include the now-suppressed one)"

echo ""
echo "═══════════════════════════════════════════════"
echo "  All smoke tests passed"
echo "═══════════════════════════════════════════════"
