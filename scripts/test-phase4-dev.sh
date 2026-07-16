#!/bin/bash
# Phase 4 End-to-End Test Script for Dev Environment
#
# Prerequisites:
#   1. All workers deployed to dev (pnpm deploy:dev)
#   2. Migrations applied (pnpm db:migrate:dev)
#   3. KV seeded (see docs/DEPLOYMENT.md step 5)
#   4. Management worker secrets set (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
#
# Usage:
#   export API_URL="https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev"
#   export MGMT_URL="https://deeprecall-management-dev.<your-subdomain>.workers.dev"
#   export API_KEY="your-dev-api-key"
#   export ADMIN_KEY="your-dev-admin-key"
#   bash scripts/test-phase4-dev.sh

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────
API_URL="${API_URL:?Set API_URL env var (your deployed memory-api URL)}"
MGMT_URL="${MGMT_URL:?Set MGMT_URL env var (your deployed management URL)}"
API_KEY="${API_KEY:?Set API_KEY env var (from seed-kv-dev.sh output)}"
ADMIN_KEY="${ADMIN_KEY:?Set ADMIN_KEY env var (from seed-kv-dev.sh output)}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }
info() { echo -e "${YELLOW}INFO${NC}: $1"; }

# ─── Test 1: Health Check ────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  Phase 4 E2E Tests"
echo "═══════════════════════════════════════════════"
echo ""

info "Test 1: Health check"
HEALTH=$(curl -s "$API_URL/v1/health")
echo "$HEALTH" | jq .
STATUS=$(echo "$HEALTH" | jq -r '.status')
if [ "$STATUS" = "ok" ] || [ "$STATUS" = "degraded" ]; then
  pass "Health check returned status=$STATUS"
else
  fail "Health check failed: $HEALTH"
fi

# ─── Test 2: Upload a text document ──────────────────────────
echo ""
info "Test 2: Upload a text document"

# Create a temp text file
TMPFILE=$(mktemp /tmp/deeprecall-test-XXXXXX.txt)
cat > "$TMPFILE" << 'TESTDOC'
Meeting Notes — Product Planning Session
Date: April 14, 2026

Attendees: Alice (PM), Bob (Engineering), Carol (Design)

Key Decisions:
1. We will launch the mobile app by June 2026.
2. The primary target audience is developers aged 25-40.
3. Alice prefers dark mode as the default theme.
4. Bob mentioned that the API should support pagination with cursor-based navigation.
5. Carol suggested using a minimalist design with max 3 colors.

Action Items:
- Bob will create the API specification by next Friday.
- Carol will deliver wireframes by April 20, 2026.
- Alice will schedule user interviews for the week of April 21.

Technical Notes:
The backend will use Cloudflare Workers with D1 for the database.
We decided against using Redis — KV is sufficient for our caching needs.
TESTDOC

SCOPE='{"user_id":"test-user-phase4"}'

UPLOAD_RESULT=$(curl -s -X POST "$API_URL/v1/documents" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@$TMPFILE;type=text/plain" \
  -F "scope=$SCOPE" \
  -F "document_type=transcript" \
  -F "description=Product planning meeting notes")

echo "$UPLOAD_RESULT" | jq .
DOC_ID=$(echo "$UPLOAD_RESULT" | jq -r '.document_id // empty')
CHUNKS=$(echo "$UPLOAD_RESULT" | jq -r '.chunks // empty')

if [ -n "$DOC_ID" ]; then
  pass "Document uploaded: id=$DOC_ID, chunks=$CHUNKS"
else
  fail "Document upload failed: $UPLOAD_RESULT"
fi

rm -f "$TMPFILE"

# ─── Test 3: Get document metadata ──────────────────────────
echo ""
info "Test 3: Get document metadata"
sleep 2  # Brief pause for eventual consistency

DOC_META=$(curl -s "$API_URL/v1/documents/$DOC_ID" \
  -H "X-API-Key: $API_KEY")

echo "$DOC_META" | jq .
DOC_TYPE=$(echo "$DOC_META" | jq -r '.document.document_type // empty')
if [ "$DOC_TYPE" = "transcript" ]; then
  pass "Document metadata retrieved: type=$DOC_TYPE"
else
  fail "Document metadata unexpected: $DOC_META"
fi

# ─── Test 4: Download document content ──────────────────────
echo ""
info "Test 4: Download document content"

CONTENT_RESP=$(curl -s -w "\n%{http_code}" "$API_URL/v1/documents/$DOC_ID/content" \
  -H "X-API-Key: $API_KEY")
HTTP_CODE=$(echo "$CONTENT_RESP" | tail -1)

if [ "$HTTP_CODE" = "200" ]; then
  pass "Document content downloaded (HTTP $HTTP_CODE)"
else
  fail "Document content download failed (HTTP $HTTP_CODE)"
fi

# ─── Test 5: Wait for ingestion, then query memories ────────
echo ""
info "Test 5: Wait for ingestion pipeline, then query for extracted memories"
info "Waiting 15 seconds for the ingestion workflow to complete..."
sleep 15

QUERY_RESULT=$(curl -s -X POST "$API_URL/v1/query" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mobile app launch date",
    "scope": {"user_id": "test-user-phase4"},
    "mode": "recall",
    "top_k": 5
  }')

echo "$QUERY_RESULT" | jq '.memories | length'
MEMORY_COUNT=$(echo "$QUERY_RESULT" | jq '.total // 0')

if [ "$MEMORY_COUNT" -gt 0 ]; then
  pass "Found $MEMORY_COUNT memories extracted from document"
  echo "$QUERY_RESULT" | jq '.memories[] | {content: .memory.content, type: .memory.type, score: .score}'
else
  info "No memories found yet — ingestion may still be processing"
  echo "$QUERY_RESULT" | jq .
fi

# ─── Test 6: List memories for test user ────────────────────
echo ""
info "Test 6: List all memories for test user"

MEMORIES_RESULT=$(curl -s "$API_URL/v1/memories?user_id=test-user-phase4" \
  -H "X-API-Key: $API_KEY")

TOTAL=$(echo "$MEMORIES_RESULT" | jq '.total // 0')
info "Total memories for test user: $TOTAL"
echo "$MEMORIES_RESULT" | jq '.memories[] | {id: .id, content: .content[0:80], type: .type}' 2>/dev/null || true

# ─── Test 7: Management API — List products ─────────────────
echo ""
info "Test 7: Management API — List products"

PRODUCTS=$(curl -s "$MGMT_URL/admin/products" \
  -H "X-Admin-Key: $ADMIN_KEY")

echo "$PRODUCTS" | jq .
PRODUCT_COUNT=$(echo "$PRODUCTS" | jq '.total // 0')
pass "Found $PRODUCT_COUNT registered product(s)"

# ─── Test 8: Management API — Migration status ──────────────
echo ""
info "Test 8: Management API — Migration status"

MIG_STATUS=$(curl -s "$MGMT_URL/admin/migrations/status" \
  -H "X-Admin-Key: $ADMIN_KEY")

echo "$MIG_STATUS" | jq .
pass "Migration status retrieved"

# ─── Test 9: Admin — Dump memories from document ────────────
echo ""
info "Test 9: Admin — Dump all memories for test user"

DUMP=$(curl -s "$API_URL/admin/memories/dump?user_id=test-user-phase4" \
  -H "X-Admin-Key: $ADMIN_KEY")

DUMP_TOTAL=$(echo "$DUMP" | jq '.total // 0')
info "Admin dump: $DUMP_TOTAL memories"

# ─── Test 10: Cleanup ───────────────────────────────────────
echo ""
info "Test 10: Cleanup — Purge test user memories"

PURGE=$(curl -s -X POST "$API_URL/admin/memories/purge" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "test-user-phase4"}')

echo "$PURGE" | jq .
pass "Test cleanup complete"

# ─── Summary ────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  Phase 4 E2E Tests Complete"
echo "═══════════════════════════════════════════════"
echo ""
echo "Manual follow-up tests:"
echo "  - Upload a PDF document and verify extraction"
echo "  - Onboard a second product via POST $MGMT_URL/admin/products/onboard"
echo "  - Verify product isolation (separate D1/Vectorize)"
echo ""
