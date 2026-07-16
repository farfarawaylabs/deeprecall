# Deep Recall -- Product Onboarding Guide

This guide walks through onboarding a new product (tenant) to the Deep Recall memory system. Each product receives its own D1 database and Vectorize index, ensuring complete data isolation between tenants.

---

## Base URLs

| Worker         | Production                                                        | Development                                                      |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Memory API     | `https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev` | `https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev` |
| Management API | `https://deeprecall-management-prod.<your-subdomain>.workers.dev` | `https://deeprecall-management-dev.<your-subdomain>.workers.dev` |

The examples in this guide use the dev URLs. When onboarding against production, swap the host for the corresponding production domain.

---

## Prerequisites

Before onboarding a new product, make sure the following are in place:

1. **Deep Recall is deployed and running.** All six workers must be live: `data`, `retrieval`, `ingestion`, `memory-api`, `consolidation`, and `management`.
2. **Management worker secrets are configured.** The management worker must have `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set as secrets.
3. **Admin API key is available.** You will authenticate admin requests with the `X-Admin-Key` header.

---

## Step 1: Onboard via Management API

Call the management API to provision the product's D1 database, Vectorize index, and API key.

**Request:**

```bash
curl -X POST https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/products/onboard \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: <your-admin-key>" \
  -d '{
    "product_id": "my-product",
    "name": "My Product",
    "policy_overrides": {},
    "features": { "document_ingestion": true },
    "answer_model": "anthropic:claude-opus-4-8"
  }'
```

**`product_id` rules:** lowercase alphanumeric characters and hyphens only, between 3 and 30 characters.

**`answer_model` (optional):** per-product model for `POST /v1/answer`, as `<provider>:<model-id>` where provider is `anthropic`, `openai`, or `google` (e.g. `openai:gpt-5`, `google:gemini-3-pro`). If omitted, `/v1/answer` falls back to the memory-api `ANSWER_MODEL` env var, then the built-in default. The selected provider's API key must be set as a memory-api secret.

**Response (example):**

```json
{
  "product_id": "my-product",
  "api_key": "dr_live_abc123...",
  "db_name": "deeprecall-db-my-product-dev",
  "db_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "vectorize_name": "deeprecall-vectors-my-product-dev",
  "wrangler_snippet": "..."
}
```

> **IMPORTANT:** Save the `api_key` immediately. It cannot be retrieved later. Store it securely -- you will need it for all API calls scoped to this product.

---

## Step 2: Add Wrangler Bindings

The onboard response includes a `wrangler_snippet` with the binding configuration you need. Add these bindings to `workers/data/wrangler.jsonc` under the appropriate environment block.

**Example for the dev environment:**

In the `env.dev.d1_databases` array, add:

```jsonc
{
  "binding": "DB_my-product",
  "database_name": "deeprecall-db-my-product-dev",
  "database_id": "<db_id from onboard response>",
}
```

In the `env.dev.vectorize` array, add:

```jsonc
{
  "binding": "VEC_my-product",
  "index_name": "deeprecall-vectors-my-product-dev",
}
```

Repeat the same for the production environment block when you are ready to deploy to production, using the corresponding production resource names and IDs.

---

## Step 3: Redeploy the Data Worker

After updating the wrangler configuration, redeploy the data worker so it picks up the new bindings:

```bash
pnpm deploy:dev:data
```

Only the data worker needs redeployment. All other workers (memory-api, ingestion, retrieval, consolidation, management) access storage through service bindings to the data worker, so they do not require any changes.

---

## Step 4: Metadata Indexes (Automatic)

The onboard endpoint automatically creates the 6 Vectorize metadata indexes required for filtered queries (`user_id`, `agent_id`, `status`, `type`, `source_type`, `confidence`). No manual step is needed for a freshly-onboarded product.

> If `/v1/query` returns zero results for a new product despite successful ingestion, the metadata indexes are the first thing to verify: `pnpx wrangler vectorize list-metadata-index deeprecall-vectors-<product_id>-<env>`. If the list is short or empty (network hiccup during onboarding, older product onboarded before this was automated), recreate the missing ones with `pnpx wrangler vectorize create-metadata-index ...`.

---

## Step 5: Optionally Set a Custom Extraction Template

If the product needs a custom prompt for memory extraction, set it via KV. Each template is scoped to a product and scene type.

```bash
pnpx wrangler kv key put \
  --namespace-id="<KV_NAMESPACE_ID>" \
  --remote \
  "template:my-product:one_on_one_chat" \
  "Your custom extraction prompt here...

{content}"
```

> **IMPORTANT:** The template **must** contain the `{content}` placeholder. Without it, the LLM will attempt to extract memories from the instruction text itself rather than from the actual conversation content.

Available scene types for templates: `one_on_one_chat`, `group_chat`, `document`, `system_event`, `api_direct`.

---

## Step 6: Test the New Product

### Test Ingestion

Submit a piece of content to verify the ingestion pipeline works end-to-end:

```bash
curl -X POST https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/v1/ingest \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <api-key-from-step-1>" \
  -d '{
    "content": "User likes dark mode and prefers TypeScript.",
    "scope": {
      "user_id": "user-1"
    },
    "source_channel": "chat"
  }'
```

> The API key identifies the product — do not include `product_id` in request bodies. Scope is `(user_id?, agent_id?, session_id?)` and must contain at least one of `user_id` or `agent_id`. See `docs/API_GUIDE.md` for the full scope model.

A successful response returns a workflow instance ID. The ingestion pipeline runs asynchronously -- allow a few seconds for extraction, embedding, and persistence to complete.

### Test Query

Query the memories to verify they were stored and are retrievable:

```bash
curl -X POST https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/v1/query \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <api-key-from-step-1>" \
  -d '{
    "query": "What does the user prefer?",
    "scope": {
      "user_id": "user-1"
    },
    "mode": "full_briefing"
  }'
```

The response should include extracted memories about dark mode and TypeScript preferences.

---

## Verifying Product Isolation

Deep Recall enforces strict data isolation between products. Each product has its own D1 database and Vectorize index, so there is no shared storage layer.

To verify isolation:

1. **Cross-product queries return nothing.** Query product A's user memories using product B's scope -- no results should appear.
2. **Cross-product API keys are rejected.** Attempt to query product A's data using product B's API key -- the request should fail with an authentication error.
3. **Separate storage.** Confirm that each product's D1 database and Vectorize index contain only that product's data.

---

## Optional Configuration

### Policy Overrides

Set product-specific policies for PII handling, confidence thresholds, and rate limits by writing to KV:

```bash
pnpx wrangler kv key put \
  --namespace-id="<KV_NAMESPACE_ID>" \
  --remote \
  "product:my-product:policy_overrides" \
  '{"min_confidence": 0.7, "pii_mode": "redact", "rate_limit_rpm": 60}'
```

### Feature Flags

Enable or disable features per product. Currently supported flags:

- `document_ingestion` -- allows the product to ingest documents (PDFs, etc.) in addition to text content.

Feature flags are set during onboarding (Step 1) via the `features` field and can be updated through the management API.

### Custom Extraction Templates

Define custom extraction prompts per scene type to tailor how memories are extracted for a specific product. See Step 5 for details.

---

## Troubleshooting

| Symptom                                                | Likely Cause                                    | Fix                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Queries return no results despite successful ingestion | Missing Vectorize metadata indexes              | Run the commands in Step 4                                                                            |
| API key rejected                                       | Wrong product scope or key not saved            | Re-onboard the product to generate a new key                                                          |
| Extraction produces irrelevant memories                | Custom template missing `{content}` placeholder | Update the KV template to include `{content}`                                                         |
| Data worker fails to start after binding update        | Malformed `wrangler.jsonc`                      | Validate JSON syntax and check binding names match the pattern `DB_<product-id>` / `VEC_<product-id>` |
| Ingestion works but query returns stale data           | Vectorize indexing delay                        | Wait a few seconds and retry; Vectorize indexes asynchronously                                        |

---

## Deployment Order Reference

When deploying all workers (e.g., after infrastructure changes), deploy in this order to respect service binding dependencies:

```
data -> retrieval -> ingestion -> memory-api -> consolidation -> management
```

For product onboarding, only the data worker needs redeployment (Step 3).
