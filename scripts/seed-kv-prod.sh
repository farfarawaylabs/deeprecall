#!/bin/bash
# Seed KV with initial configuration for the production environment.
# Run from the project root: bash scripts/seed-kv-prod.sh
#
# Prerequisites: the deeprecall-config-prod KV namespace and the default D1
# database must exist (see docs/DEPLOYMENT.md). Pass their ids via env vars:
#   KV_ID=<kv-namespace-id> D1_DATABASE_ID=<d1-database-id> bash scripts/seed-kv-prod.sh

set -euo pipefail

: "${KV_ID:?KV_ID is required (id of the deeprecall-config-prod KV namespace)}"
: "${D1_DATABASE_ID:?D1_DATABASE_ID is required (id of the deeprecall-db-default-prod D1 database)}"

echo "Seeding KV namespace: deeprecall-config-prod ($KV_ID)"

# Generate a secure product API key for the default tenant.
# Note: the admin key is a worker secret, not KV — set it separately via
# scripts/setup-admin-key.sh (see docs/ADMIN_GUIDE.md).
API_KEY="prod-$(openssl rand -hex 32)"
# Keys are stored hashed, never in plaintext. memory-api resolves a request by
# hashing the presented key and looking up apikey:<hash>. This is shown once.
API_KEY_HASH="$(printf '%s' "$API_KEY" | shasum -a 256 | cut -d' ' -f1)"

echo ""
echo "=== Production Product API Key (SAVE THIS SECURELY — NOT recoverable later!) ==="
echo "Product API Key: $API_KEY"
echo "================================================================================"
echo ""

# Product: default. Only the hash is persisted (auth index + bookkeeping).
pnpx wrangler kv key put --namespace-id="$KV_ID" --remote "apikey:$API_KEY_HASH" "default"
pnpx wrangler kv key put --namespace-id="$KV_ID" --remote "product:default:api_key_hash" "$API_KEY_HASH"
pnpx wrangler kv key put --namespace-id="$KV_ID" --remote "product:default:db_binding" "DB_default"
pnpx wrangler kv key put --namespace-id="$KV_ID" --remote "product:default:vec_binding" "VEC_default"
pnpx wrangler kv key put --namespace-id="$KV_ID" --remote "product:default:config" '{"product_id":"default","name":"default","db_id":"'"$D1_DATABASE_ID"'","db_name":"deeprecall-db-default-prod","vectorize_name":"deeprecall-vectors-default-prod","policyOverrides":{},"features":{}}'

# Extraction template for document scene type
pnpx wrangler kv key put --namespace-id="$KV_ID" --remote "template:default:document" 'You are a memory extraction system. Analyze the following document and extract structured memories.

For each memory, determine:
- **content**: The core fact, finding, decision, or actionable item. Be concise but complete. Include enough context to be understandable without the original document.
- **episode**: A brief narrative summary of the document context (or null if not applicable).
- **type**: One of:
  - "fact" — A stable piece of information (finding, decision, requirement, preference, etc.)
  - "episode" — A notable event or experience described in the document
  - "foresight" — Something planned or expected in the future (deadlines, launches, meetings)
  - "profile" — A high-level summary (rarely extracted directly)
- **source_actor**: Who authored or stated this (e.g., "document_author", a person'"'"'s name if mentioned)
- **source_type**: "document_extracted"
- **confidence**: 0.0 to 1.0. Explicit statements get 0.85-1.0. Implied information gets 0.5-0.75.
- **validity_start / validity_end**: ISO timestamps if the memory has a time window. Null otherwise.
- **tags**: Categorization tags (e.g., ["technical", "architecture"], ["meeting", "decision"])
- **subject / predicate / object**: Entity-relationship triple if applicable. Null if not a clear relationship.

Rules:
- Extract ALL meaningful facts, decisions, findings, requirements, and action items.
- Do NOT extract boilerplate, headers, formatting instructions, or metadata.
- For technical documents: extract architecture decisions, API details, configuration requirements.
- For research documents: extract key findings, methodologies, and conclusions.
- For transcripts: extract decisions made, action items, and key discussion points.
- For foresight items, estimate validity_end based on context.

Document:
{content}'

echo ""
echo "Production KV seeding complete."
echo ""
echo "Save the product API key above — you will need it for the X-API-Key header."
echo ""
echo "If this is the first time setting up prod, also set the admin key secret:"
echo "  bash scripts/setup-admin-key.sh production"
