#!/bin/bash
# Set up a newly onboarded product's D1 database and Vectorize index.
#
# NOTE: As of 2026-04, POST /admin/products/onboard automatically creates the
# schema and all 6 Vectorize metadata indexes. This script is retained for:
#   - Recovering products that were onboarded before auto-creation landed
#   - Manually backfilling a metadata index that was dropped or failed partway
#   - Reapplying D1 migrations after a schema change
#
# Run AFTER:
#   1. Onboarding via POST /admin/products/onboard
#   2. Adding the bindings to workers/data/wrangler.jsonc
#
# Usage:
#   bash scripts/setup-product-db.sh <product-id> [env]
#
# Example:
#   bash scripts/setup-product-db.sh second-product dev

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: bash scripts/setup-product-db.sh <product-id>"
  echo ""
  echo "Example: bash scripts/setup-product-db.sh second-product"
  exit 1
fi

PRODUCT_ID="$1"
ENV="${2:-dev}"
DB_BINDING="DB_${PRODUCT_ID}"
VEC_NAME="deeprecall-vectors-${PRODUCT_ID}-${ENV}"
WRANGLER_CONFIG="workers/data/wrangler.jsonc"

echo ""
echo "═══════════════════════════════════════════════"
echo "  Setting up product: ${PRODUCT_ID} (${ENV})"
echo "═══════════════════════════════════════════════"
echo ""

# Step 1: Run D1 migrations
echo "Step 1: Running D1 migrations for ${DB_BINDING}..."
pnpx wrangler d1 migrations apply "${DB_BINDING}" --env "${ENV}" --remote -c "${WRANGLER_CONFIG}"
echo ""

# Step 2: Create Vectorize metadata indexes (idempotent — duplicates are a no-op on Cloudflare's side)
echo "Step 2: Creating Vectorize metadata indexes for ${VEC_NAME}..."
pnpx wrangler vectorize create-metadata-index "${VEC_NAME}" --property-name=user_id --type=string
pnpx wrangler vectorize create-metadata-index "${VEC_NAME}" --property-name=agent_id --type=string
pnpx wrangler vectorize create-metadata-index "${VEC_NAME}" --property-name=status --type=string
pnpx wrangler vectorize create-metadata-index "${VEC_NAME}" --property-name=type --type=string
pnpx wrangler vectorize create-metadata-index "${VEC_NAME}" --property-name=source_type --type=string
pnpx wrangler vectorize create-metadata-index "${VEC_NAME}" --property-name=confidence --type=number
echo ""

echo "═══════════════════════════════════════════════"
echo "  Done! Next steps:"
echo "  1. Redeploy the data worker: pnpm deploy:dev:data"
echo "  2. Test with the product's API key"
echo "═══════════════════════════════════════════════"
echo ""
