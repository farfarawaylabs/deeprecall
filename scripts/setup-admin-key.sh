#!/bin/bash
# One-time setup of the ADMIN_KEY worker secret.
#
# Usage:
#   bash scripts/setup-admin-key.sh dev
#   bash scripts/setup-admin-key.sh production
#
# Generates a random admin key, uploads it as the ADMIN_KEY secret on both
# workers that expose admin endpoints (memory-api and management), and prints
# the value once so you can save it.
#
# To rotate the key later, run this again — the new value replaces the old.
# To use a specific pre-chosen key, set ADMIN_KEY in the environment:
#   ADMIN_KEY="my-chosen-value" bash scripts/setup-admin-key.sh production

set -euo pipefail

ENV="${1:-}"
if [[ "$ENV" != "dev" && "$ENV" != "production" ]]; then
  echo "Usage: $0 {dev|production}" >&2
  exit 1
fi

if [[ -z "${ADMIN_KEY:-}" ]]; then
  if [[ "$ENV" == "production" ]]; then
    ADMIN_KEY="prod-admin-$(openssl rand -hex 32)"
  else
    ADMIN_KEY="dev-admin-key-$(openssl rand -hex 16)"
  fi
fi

echo ""
echo "=== Admin API Key ($ENV) — SAVE THIS SECURELY ==="
echo "$ADMIN_KEY"
echo "================================================="
echo ""
echo "This value will not be shown again. Use it in the X-Admin-Key header for all"
echo "admin endpoints on the memory-api and management workers."
echo ""

for WORKER in memory-api management; do
  echo "Uploading ADMIN_KEY secret to workers/$WORKER ($ENV)..."
  printf '%s' "$ADMIN_KEY" | pnpx wrangler secret put ADMIN_KEY --env "$ENV" \
    --config "workers/$WORKER/wrangler.jsonc"
done

echo ""
echo "Done. Both workers now hold the new admin key."
if [[ "$ENV" == "dev" ]]; then
  echo ""
  echo "For local (wrangler dev), also add this to each worker's .dev.vars file:"
  echo "  ADMIN_KEY=$ADMIN_KEY"
fi
