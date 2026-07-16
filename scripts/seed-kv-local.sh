#!/bin/bash
# Seed LOCAL KV for wrangler dev (local mode).
# Run from the project root: bash scripts/seed-kv-local.sh
#
# This writes to each worker's local .wrangler/state/ directory.
# Use fixed keys so they're deterministic across runs.

set -euo pipefail

API_KEY="dev-local-api-key"
ADMIN_KEY="dev-local-admin-key"
# Keys are stored hashed, never in plaintext. memory-api resolves a request by
# hashing the presented key and looking up apikey:<hash>.
API_KEY_HASH="$(printf '%s' "$API_KEY" | shasum -a 256 | cut -d' ' -f1)"

# Workers that have a CONFIG KV binding
WORKERS=("memory-api" "ingestion")

KV_ENTRIES=(
  "apikey:$API_KEY_HASH|default"
  "product:default:api_key_hash|$API_KEY_HASH"
  "product:default:db_binding|DB_default"
  "product:default:vec_binding|VEC_default"
  'product:default:config|{"name":"default","policyOverrides":{},"features":{}}'
)

for worker in "${WORKERS[@]}"; do
  echo "Seeding local KV for workers/$worker ..."
  cd "workers/$worker"

  for entry in "${KV_ENTRIES[@]}"; do
    key="${entry%%|*}"
    value="${entry#*|}"
    pnpx wrangler kv key put --binding CONFIG --env dev --local "$key" "$value" 2>/dev/null
    echo "  $key"
  done

  cd ../..
done

echo ""
echo "Local KV seeding complete."
echo ""
echo "Use these headers when testing locally:"
echo "  X-API-Key:   $API_KEY"
echo "  X-Admin-Key: $ADMIN_KEY"
echo ""
echo "The admin key is read from .dev.vars (not local KV). Ensure"
echo "workers/memory-api/.dev.vars and workers/management/.dev.vars contain:"
echo "  ADMIN_KEY=$ADMIN_KEY"
