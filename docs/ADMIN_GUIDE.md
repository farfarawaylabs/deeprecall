# Deep Recall Admin Guide

This guide covers administrative operations for the Deep Recall memory system. It is intended for operators and engineers responsible for managing the platform.

Deep Recall consists of six Cloudflare Workers:

| Worker        | Purpose                                                       |
| ------------- | ------------------------------------------------------------- |
| memory-api    | Public API gateway and admin endpoints                        |
| data          | D1, Vectorize, KV, and R2 data access (service binding only)  |
| ingestion     | LLM extraction, embedding, reconciliation pipeline            |
| retrieval     | Hybrid search (vector + full-text)                            |
| consolidation | Queue consumer and cron jobs (expiry, decay, profile rebuild) |
| management    | Product onboarding, migrations, multi-product administration  |

---

## 1. Admin Authentication

All admin endpoints on both the memory-api and management workers require the `X-Admin-Key` header.

```
X-Admin-Key: <your-admin-key>
```

Requests without a valid admin key receive a `401` response:

```json
{
  "error": {
    "code": "AUTHENTICATION_ERROR",
    "message": "Missing X-Admin-Key header"
  }
}
```

### Where the admin key is stored

The admin key is a **per-worker Cloudflare secret** named `ADMIN_KEY`. It must be set on both workers that expose admin endpoints:

- `workers/memory-api`
- `workers/management`

Both workers must hold the **same value** — the key is compared against the incoming header at request time.

### Setting the admin key

Use the helper script — it generates a random key, uploads it to both workers in one go, and prints it once:

```bash
bash scripts/setup-admin-key.sh dev          # or: production
```

To supply your own value instead of a randomly generated one:

```bash
ADMIN_KEY="my-chosen-value" bash scripts/setup-admin-key.sh production
```

**Local (`wrangler dev`):** set `ADMIN_KEY=...` in each worker's `.dev.vars` file (the dev script prints the line for you).

### Rotating the admin key

Re-run `scripts/setup-admin-key.sh <env>`. The new value replaces the old secret on both workers. Rotation takes effect on the next request — no redeploy needed.

---

## 2. Memory API Admin Endpoints

Base URLs:

- Production: `https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev`
- Development: `https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev`

Examples below use the dev URL. Swap the host for the production domain when operating against prod.

All endpoints below are prefixed with `/admin` and require the `X-Admin-Key` header.

### 2.1 Detailed Health Check

**GET** `/admin/health/detailed`

Returns the status and latency of all backing services: D1, Vectorize, KV, Ingestion (service binding), and Retrieval (service binding).

```bash
curl -s https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/health/detailed \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "status": "ok",
  "service": "memory-api",
  "timestamp": "2026-04-14T12:00:00.000Z",
  "checks": {
    "d1": { "status": "ok", "latency_ms": 12 },
    "vectorize": { "status": "ok", "latency_ms": 45 },
    "kv": { "status": "ok", "latency_ms": 3 },
    "ingestion": { "status": "ok", "latency_ms": 8 },
    "retrieval": { "status": "ok", "latency_ms": 6 }
  }
}
```

The top-level `status` is `"ok"` when all checks pass, or `"degraded"` if any check fails.

---

### 2.2 Dump Memories

**GET** `/admin/memories/dump`

List memories for a scope. Useful for debugging. Uses **relaxed match** — passing only `user_id` also returns agent-only memories (where `user_id IS NULL`) that apply to every user.

| Query Param | Required | Default     | Description                                                        |
| ----------- | -------- | ----------- | ------------------------------------------------------------------ |
| user_id     | No\*     | --          | User scope                                                         |
| agent_id    | No\*     | --          | Agent scope                                                        |
| product_id  | No       | `"default"` | Product scope (top-level admin field, not inside the memory scope) |

> \* At least one of `user_id` or `agent_id` must be present.

```bash
# User-scoped (includes any agent-only shared memories)
curl -s "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/memories/dump?user_id=user-123&product_id=default" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq

# Agent-only
curl -s "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/memories/dump?agent_id=sales-agent&product_id=default" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "memories": [
    {
      "id": "mem-abc-123",
      "content": "User prefers dark mode",
      "type": "fact",
      "status": "active",
      "confidence": 0.85,
      "user_id": "user-123",
      "created_at": "2026-04-10T08:30:00.000Z"
    }
  ],
  "total": 1
}
```

---

### 2.3 Purge Memories

**POST** `/admin/memories/purge`

Deletes memories, vectors, and audit entries for a scope. Uses **strict match** — only memories whose non-null scope fields exactly equal the request are deleted. Agent-only memories (`user_id IS NULL`) are not touched when purging by `user_id` alone. This action is irreversible.

| Body Field | Required | Default     | Description                           |
| ---------- | -------- | ----------- | ------------------------------------- |
| user_id    | No\*     | --          | User scope                            |
| agent_id   | No\*     | --          | Agent scope                           |
| product_id | No       | `"default"` | Product scope (top-level admin field) |

> \* At least one of `user_id` or `agent_id` must be present.

```bash
# Purge user memories (leaves agent-only shared memories untouched)
curl -s -X POST https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/memories/purge \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-123", "product_id": "default"}' | jq

# Purge agent-only shared memories
curl -s -X POST https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/memories/purge \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "sales-agent", "product_id": "default"}' | jq

# Purge a specific user+agent conversation
curl -s -X POST https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/memories/purge \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-123", "agent_id": "sales-agent", "product_id": "default"}' | jq
```

Response:

```json
{
  "message": "Purge complete",
  "memories_deleted": 42,
  "vectors_deleted": 42,
  "audits_deleted": 85
}
```

---

### 2.4 Test Extraction

**POST** `/admin/pipeline/test-extract`

Run LLM extraction on arbitrary text and return the extracted memory candidates. Nothing is persisted.

| Body Field | Required | Default             | Description                       |
| ---------- | -------- | ------------------- | --------------------------------- |
| content    | Yes      | --                  | The text to extract memories from |
| scene_type | No       | `"one_on_one_chat"` | Scene context for extraction      |

Valid `scene_type` values: `one_on_one_chat`, `group_chat`, `document`, `research`, `manual`.

```bash
curl -s -X POST https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/pipeline/test-extract \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "I just moved to Berlin and started a new job at a fintech company.",
    "scene_type": "one_on_one_chat"
  }' | jq
```

Response:

```json
{
  "candidates": [
    {
      "content": "User lives in Berlin",
      "type": "fact",
      "confidence": 0.9,
      "source_type": "user_stated",
      "tags": ["location"]
    },
    {
      "content": "User works at a fintech company",
      "type": "fact",
      "confidence": 0.85,
      "source_type": "user_stated",
      "tags": ["employment"]
    }
  ],
  "count": 2,
  "message": "Extraction test complete (nothing persisted)"
}
```

---

### 2.5 Test Reconciliation

**POST** `/admin/pipeline/test-reconcile`

Run the reconciliation step against a user's existing memories. Returns the LLM's merge/supersede/create decision without persisting anything.

| Body Field        | Required | Default     | Description                                   |
| ----------------- | -------- | ----------- | --------------------------------------------- |
| candidate_content | Yes      | --          | The candidate memory text to reconcile        |
| user_id           | Yes      | --          | User whose memories to compare against        |
| product_id        | No       | `"default"` | Product scope                                 |
| top_k             | No       | `5`         | Number of similar memories to retrieve (1-20) |

```bash
curl -s -X POST https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/pipeline/test-reconcile \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "candidate_content": "User lives in Munich",
    "user_id": "user-123",
    "product_id": "default",
    "top_k": 5
  }' | jq
```

Response:

```json
{
  "decision": {
    "action": "supersede",
    "target_memory_id": "mem-abc-123",
    "reasoning": "The user previously stated they live in Berlin but now says Munich, indicating a move."
  },
  "similar_memories": [
    {
      "id": "mem-abc-123",
      "content": "User lives in Berlin",
      "score": 0.92
    }
  ],
  "message": "Reconciliation test complete (nothing persisted)"
}
```

---

### 2.6 Recent Audit Entries

**GET** `/admin/audit/recent`

Retrieve recent audit log entries for a scope, ordered by recency. Uses **relaxed match**.

| Query Param | Required | Default     | Description                           |
| ----------- | -------- | ----------- | ------------------------------------- |
| user_id     | No\*     | --          | User scope                            |
| agent_id    | No\*     | --          | Agent scope                           |
| limit       | No       | `50`        | Number of entries (max 200)           |
| product_id  | No       | `"default"` | Product scope (top-level admin field) |

> \* At least one of `user_id` or `agent_id` must be present.

```bash
# By user
curl -s "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/audit/recent?user_id=user-123&limit=10" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq

# By agent (agent-only memories)
curl -s "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/audit/recent?agent_id=sales-agent&limit=10" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "entries": [
    {
      "id": "aud-xyz-789",
      "memory_id": "mem-abc-123",
      "action": "created",
      "reason": "Extracted from user conversation",
      "triggered_by": "ingestion_pipeline",
      "created_at": "2026-04-10T08:30:00.000Z"
    }
  ],
  "total": 1
}
```

Valid audit actions: `created`, `superseded`, `merged`, `expired`, `suppressed`, `deleted`, `confidence_updated`, `corrected`.

---

### 2.7 List Dead Letters

**GET** `/admin/dead-letters`

List messages that failed processing after the maximum retry attempts (3).

| Query Param | Required | Default     | Description                 |
| ----------- | -------- | ----------- | --------------------------- |
| limit       | No       | `50`        | Number of entries (max 200) |
| product_id  | No       | `"default"` | Product scope               |

```bash
curl -s "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/dead-letters?limit=20" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "entries": [
    {
      "id": "dl-abc-001",
      "queue_name": "consolidation",
      "payload": "{\"type\":\"profile_rebuild\",\"product_id\":\"default\",\"scope\":{\"user_id\":\"user-456\"}}",
      "error": "Failed after 3 attempts",
      "attempts": 3,
      "first_failed_at": "2026-04-12T03:00:05.000Z",
      "last_failed_at": "2026-04-12T03:02:15.000Z"
    }
  ],
  "total": 1
}
```

---

### 2.8 Reprocess Dead Letter

**POST** `/admin/dead-letters/:id/reprocess`

Re-enqueue a dead letter back into the consolidation queue and delete it from the dead letter table.

| Path Param | Description          |
| ---------- | -------------------- |
| :id        | Dead letter entry ID |

| Query Param | Required | Default     | Description   |
| ----------- | -------- | ----------- | ------------- |
| product_id  | No       | `"default"` | Product scope |

```bash
curl -s -X POST "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/dead-letters/dl-abc-001/reprocess?product_id=default" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "message": "Dead letter requeued for processing",
  "dead_letter_id": "dl-abc-001"
}
```

---

### 2.9 Trigger Consolidation Job

**POST** `/admin/consolidation/trigger`

Manually enqueue a consolidation job. `product_id` is **top-level** on the request body (not inside scope). At least one of `user_id` or `agent_id` must be present.

| Body Field | Required | Default     | Description                                              |
| ---------- | -------- | ----------- | -------------------------------------------------------- |
| type       | Yes      | --          | Job type (see below)                                     |
| product_id | No       | `"default"` | Top-level product scope                                  |
| user_id    | No\*     | --          | User scope                                               |
| agent_id   | No\*     | --          | Agent scope                                              |
| memory_ids | No       | --          | Specific memory IDs (required for `conflict_resolution`) |

> \* At least one of `user_id` or `agent_id` must be present. User-scoped and agent-only profiles consolidate **disjointly** — a user profile rolls up only user-bound memories, and an agent-only profile rebuild rolls up only standalone-agent memories (those with `user_id IS NULL`).

Valid `type` values:

| Type                  | Description                                                      |
| --------------------- | ---------------------------------------------------------------- |
| `profile_rebuild`     | Regenerate the profile memory from all active facts in the scope |
| `expiry_sweep`        | Expire memories past their `validity_end` date                   |
| `confidence_decay`    | Apply time-based confidence decay to old memories                |
| `conflict_resolution` | Check specified memories for conflicts                           |

```bash
# User-scoped profile rebuild
curl -s -X POST https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/consolidation/trigger \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "profile_rebuild",
    "product_id": "default",
    "user_id": "user-123"
  }' | jq

# Agent-only profile rebuild (standalone-agent knowledge base)
curl -s -X POST https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/consolidation/trigger \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "profile_rebuild",
    "product_id": "default",
    "agent_id": "sales-agent"
  }' | jq
```

Response:

```json
{
  "message": "Consolidation job 'profile_rebuild' enqueued",
  "product_id": "default",
  "scope": {
    "user_id": "user-123"
  }
}
```

**ConsolidationMessage shape (on the queue):**

The consolidation worker receives messages with `product_id` promoted to the top level, separate from the `scope` object.

```json
// User-scoped profile rebuild
{
  "type": "profile_rebuild",
  "product_id": "default",
  "scope": { "user_id": "user-123" }
}

// Agent-only profile rebuild
{
  "type": "profile_rebuild",
  "product_id": "default",
  "scope": { "agent_id": "sales-agent" }
}

// User+agent conversation conflict resolution
{
  "type": "conflict_resolution",
  "product_id": "default",
  "scope": { "user_id": "user-123", "agent_id": "sales-agent" },
  "memory_ids": ["mem-abc", "mem-def"]
}
```

---

### 2.10 Consolidation Status

**GET** `/admin/consolidation/status`

Check the dead letter count and recent consolidation activity.

| Query Param | Required | Default     | Description                                                           |
| ----------- | -------- | ----------- | --------------------------------------------------------------------- |
| product_id  | No       | `"default"` | Product scope                                                         |
| user_id     | No       | --          | If provided, includes recent consolidation audit entries for the user |

```bash
curl -s "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/consolidation/status?product_id=default&user_id=user-123" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "dead_letter_count": 3,
  "recent_consolidation_activity": [
    {
      "id": "aud-cons-001",
      "memory_id": "mem-abc-123",
      "action": "confidence_updated",
      "triggered_by": "consolidation",
      "created_at": "2026-04-13T03:00:10.000Z"
    }
  ],
  "cron_schedule": {
    "daily_sweep": "0 3 * * * (3 AM UTC \u2014 expiry sweep + confidence decay)",
    "weekly_profile": "0 4 * * 0 (Sunday 4 AM UTC \u2014 profile rebuild)"
  }
}
```

---

## 3. Management API Endpoints

Base URLs:

- Production: `https://deeprecall-management-prod.<your-subdomain>.workers.dev`
- Development: `https://deeprecall-management-dev.<your-subdomain>.workers.dev`

Examples below use the dev URL. Swap the host for the production domain when operating against prod.

All endpoints below are prefixed with `/admin` and require the `X-Admin-Key` header.

### 3.1 Onboard a Product

**POST** `/admin/products/onboard`

Provision a new product. This creates a D1 database, a Vectorize index, generates an API key, applies the initial schema, and registers everything in KV.

| Body Field       | Required | Default | Description                                                          |
| ---------------- | -------- | ------- | -------------------------------------------------------------------- |
| product_id       | Yes      | --      | Lowercase alphanumeric with hyphens, 3-30 chars (e.g., `my-product`) |
| name             | Yes      | --      | Human-readable product name (1-100 chars)                            |
| policy_overrides | No       | `{}`    | JSON object of policy overrides                                      |
| features         | No       | `{}`    | JSON object of feature flags                                         |

```bash
curl -s -X POST https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/products/onboard \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "product_id": "my-saas-app",
    "name": "My SaaS Application",
    "policy_overrides": {},
    "features": {}
  }' | jq
```

Response (201):

```json
{
  "product_id": "my-saas-app",
  "api_key": "generated-uuid-api-key",
  "db_name": "deeprecall-db-my-saas-app-dev",
  "db_id": "d1-database-uuid",
  "vectorize_name": "deeprecall-vectors-my-saas-app-dev",
  "wrangler_snippet": {
    "d1_databases": [
      {
        "binding": "DB_my-saas-app",
        "database_name": "deeprecall-db-my-saas-app-dev",
        "database_id": "d1-database-uuid"
      }
    ],
    "vectorize": [
      {
        "binding": "VEC_my-saas-app",
        "index_name": "deeprecall-vectors-my-saas-app-dev"
      }
    ]
  },
  "message": "Product onboarded. Add the wrangler snippet to workers/data/wrangler.jsonc and redeploy."
}
```

**After onboarding**, you must:

1. Copy the `wrangler_snippet` bindings into `workers/data/wrangler.jsonc`.
2. Redeploy the data worker (and all workers that depend on it).

---

### 3.2 List Products

**GET** `/admin/products`

List all registered products.

```bash
curl -s https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/products \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "products": [
    {
      "product_id": "default",
      "name": "Default Product",
      "db_id": "d1-uuid",
      "db_name": "deeprecall-db-default-dev",
      "vectorize_name": "deeprecall-vectors-default-dev",
      "created_at": "2026-03-01T00:00:00.000Z"
    }
  ],
  "total": 1
}
```

---

### 3.3 API Key Storage (Hashed, Show-Once)

API keys are **stored hashed, never in plaintext.** memory-api authenticates a request by hashing the presented key (SHA-256) and looking up `apikey:<hash>` in KV — an O(1) resolution regardless of tenant count, with no scan. Because only the hash is stored, **a key is shown exactly once**: in the `onboard` response and in the `rotate-key` response. There is **no endpoint to retrieve a key** — if an operator loses it, rotate to issue a new one.

> Migration note: existing deployments that predate hashed keys must run **§3.4 Migrate the API Key Index** once during rollout to backfill the `apikey:<hash>` entries from the legacy plaintext keys.

---

### 3.4 Migrate the API Key Index

**POST** `/admin/products/migrate-key-index`

One-time backfill that builds the hashed `apikey:<hash>` auth index (and a `:api_key_hash` bookkeeping entry per product) from any legacy plaintext `product:<id>:api_key` entries. Idempotent — safe to re-run.

| Query Param | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| cleanup     | `true` to also delete the legacy plaintext entries after indexing |

**Rollout order (zero-downtime):**

1. Deploy the management worker (this endpoint + hashed onboard/rotate).
2. `POST /admin/products/migrate-key-index` (no `cleanup`) — backfills hashes while the old auth still reads plaintext.
3. Deploy the memory-api worker (hashed-index auth).
4. Verify a known key still authenticates on the public API, then `POST /admin/products/migrate-key-index?cleanup=true` to delete the plaintext.

> **Freeze onboarding _and_ key rotation between steps 1 and 3.** During that window the still-old memory-api authenticates by scanning plaintext keys, but the hashed onboard/rotate no longer writes plaintext — so a product onboarded or a key rotated mid-rollout would not authenticate on the old worker (and a rotation would not fully revoke the old key there). The window is only as long as the two deploys take.

```bash
curl -s -X POST "https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/products/migrate-key-index" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "migrated": 3,
  "cleanup": false,
  "results": [
    { "product_id": "default", "status": "indexed" },
    { "product_id": "my-product-a", "status": "indexed" },
    { "product_id": "my-product-b", "status": "indexed" }
  ]
}
```

---

### 3.5 Rotate a Product API Key

**POST** `/admin/products/:id/rotate-key`

Generate a new API key for a product, replacing the existing one. This is the way to revoke a leaked key, and — since keys are hashed at rest — the only way to recover from a lost key. The memory-api auth middleware resolves keys via the hashed KV index, so the new key takes effect as soon as the KV write propagates and the old key stops working once its index entry is deleted — **no redeploy is required**. Works for the `default` product too.

| Path Param | Description       |
| ---------- | ----------------- |
| :id        | Product ID (slug) |

```bash
curl -s -X POST https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/products/my-product/rotate-key \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "product_id": "my-product",
  "api_key": "newly-generated-uuid-api-key",
  "message": "API key rotated. The previous key is now invalid; update the product to use the new key. No redeploy is required."
}
```

Returns `404` if the product is not registered. After rotating, distribute the new key to the product and confirm the old key returns `401` on the public API.

---

### 3.5 Delete a Product

**DELETE** `/admin/products/:id`

Permanently delete a product and all its Cloudflare resources (D1 database, Vectorize index, R2 documents, KV entries). The `default` product cannot be deleted.

Requires `confirm: true` in the request body as a safeguard against accidental deletion.

```bash
curl -s -X DELETE https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/products/my-product \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"confirm": true}' | jq
```

Response:

```json
{
  "product_id": "my-product",
  "status": "deleted",
  "results": {
    "r2_documents": { "status": "deleted" },
    "vectorize_index": { "status": "deleted" },
    "d1_database": { "status": "deleted" },
    "kv_entries": { "status": "deleted" }
  },
  "manual_steps": [
    "Remove the DB_my-product and VEC_my-product bindings from workers/data/wrangler.jsonc",
    "Redeploy the data worker: pnpm deploy:dev:data (or deploy:prod:data)"
  ]
}
```

After deletion, manually remove the `DB_<product_id>` and `VEC_<product_id>` bindings from `workers/data/wrangler.jsonc` and redeploy the data worker.

If any resource fails to delete, the response `status` will be `"partial_failure"` with details in `results`.

---

### 3.6 Check Product Migration Status

**POST** `/admin/products/:id/migrate`

Check the schema version for a specific product's D1 database and get migration instructions.

```bash
curl -s -X POST https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/products/default/migrate \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "product_id": "default",
  "db_name": "deeprecall-db-default-dev",
  "db_id": "d1-uuid",
  "current_schema_version": "3",
  "latest_schema_version": "3",
  "up_to_date": true,
  "instructions": "Schema is up to date. No migrations needed."
}
```

If migrations are pending:

```json
{
  "product_id": "default",
  "db_name": "deeprecall-db-default-dev",
  "db_id": "d1-uuid",
  "current_schema_version": "1",
  "latest_schema_version": "3",
  "up_to_date": false,
  "instructions": "Run pending migrations with: pnpx wrangler d1 migrations apply deeprecall-db-default-dev --env dev --remote"
}
```

---

### 3.7 Migrate All Products

**POST** `/admin/migrations/migrate-all`

Run pending schema migrations across all registered product databases.

```bash
curl -s -X POST https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/migrations/migrate-all \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "status": "success",
  "latest_schema_version": "3",
  "total_products": 2,
  "migrated": 1,
  "up_to_date": 1,
  "errors": 0,
  "results": [
    {
      "product_id": "default",
      "db_name": "deeprecall-db-default-dev",
      "previous_version": "3",
      "new_version": "3",
      "status": "up_to_date",
      "migrations_applied": []
    },
    {
      "product_id": "my-saas-app",
      "db_name": "deeprecall-db-my-saas-app-dev",
      "previous_version": "1",
      "new_version": "3",
      "status": "migrated",
      "migrations_applied": ["2", "3"]
    }
  ]
}
```

---

### 3.8 Migration Status Overview

**GET** `/admin/migrations/status`

View schema version status across all registered products.

```bash
curl -s https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/migrations/status \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

Response:

```json
{
  "status": "all_current",
  "latest_schema_version": "3",
  "total_products": 2,
  "pending_migrations": 0,
  "products": [
    {
      "product_id": "default",
      "db_name": "deeprecall-db-default-dev",
      "db_id": "d1-uuid",
      "current_schema_version": "3",
      "latest_schema_version": "3",
      "up_to_date": true
    }
  ]
}
```

---

## 4. Troubleshooting Guide

### 4.1 Dead Letter Investigation and Reprocessing

Dead letters are consolidation queue messages that failed after 3 retry attempts.

**Investigation workflow:**

1. List dead letters to identify failures:

   ```bash
   curl -s "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/dead-letters?limit=50" \
     -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
   ```

2. Inspect the `payload` field (JSON string) to understand the original message. The `error` field describes why processing failed.

3. Check Axiom logs (see Section 4.4) for the full error stack trace around the `first_failed_at` / `last_failed_at` timestamps.

4. Fix the root cause (e.g., a misconfigured binding, a transient API outage that has resolved).

5. Reprocess the dead letter:
   ```bash
   curl -s -X POST "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/dead-letters/DEAD_LETTER_ID/reprocess" \
     -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
   ```

### 4.2 Queue Backlog and Consolidation Failures

Check consolidation status for dead letter count and recent activity:

```bash
curl -s "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/consolidation/status?product_id=default" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
```

If the `dead_letter_count` is growing:

- Check if the consolidation worker is deployed and healthy.
- Review Axiom logs for repeated error patterns.
- Verify that the DATA service binding is reachable from the consolidation worker.

To manually trigger a specific job for a user (e.g., after fixing a configuration issue):

```bash
curl -s -X POST https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/consolidation/trigger \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "expiry_sweep", "user_id": "user-123"}' | jq
```

### 4.3 Checking Service Health

Run the detailed health check to identify which backing service is degraded:

```bash
curl -s https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/health/detailed \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq '.checks'
```

If a specific service shows `"status": "error"`:

- **d1**: Check the D1 database status in the Cloudflare dashboard. Verify the database ID in `wrangler.jsonc` matches the deployed resource.
- **vectorize**: Verify the Vectorize index exists and metadata indexes are configured (see Section 4.6).
- **kv**: Check KV namespace binding and that the namespace ID is correct.
- **ingestion / retrieval**: These are service bindings. Verify the upstream worker is deployed. Redeploy in the correct order (see Section 7).

### 4.4 Axiom Log Querying

All workers send structured logs to Axiom. Datasets:

- Development: `deeprecall-dev`
- Production: `deeprecall-prod`

Log in to [app.axiom.co](https://app.axiom.co) and query the relevant dataset.

Useful APL queries:

```
// All errors in the last hour
['deeprecall-dev']
| where _time > ago(1h)
| where level == "error"
| sort by _time desc

// Errors for a specific user
['deeprecall-dev']
| where _time > ago(24h)
| where user_id == "user-123"
| where level == "error"
| sort by _time desc

// Consolidation job failures
['deeprecall-dev']
| where _time > ago(24h)
| where service == "consolidation"
| where level == "error"
| sort by _time desc

// Trace a specific request by trace_id
['deeprecall-dev']
| where trace_id == "abc-123-trace-id"
| sort by _time asc
```

### 4.5 Common Issues

#### Vectorize metadata index missing

**Symptom**: Vector searches return no results even though vectors exist, or filter parameters are silently ignored.

**Cause**: Vectorize requires explicit metadata index configuration. Without indexes, metadata filters fail silently and return empty results.

**Fix**: Create the required metadata indexes via the Cloudflare dashboard or API. Required indexes for Deep Recall: `user_id` (string), `agent_id` (string), `status` (string), `type` (string), `source_type` (string), `confidence` (number).

#### D1 migration stuck

**Symptom**: `migrate-all` reports `"error"` status for a product, or the product returns schema errors.

**Fix**:

1. Check migration status:
   ```bash
   curl -s -X POST https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/products/PRODUCT_ID/migrate \
     -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
   ```
2. If the REST API migration failed, run migrations directly via the wrangler CLI:
   ```bash
   pnpx wrangler d1 migrations apply deeprecall-db-PRODUCT_ID-dev --env dev --remote
   ```
3. If the database is in an inconsistent state (partial migration), inspect the `db_metadata` table:
   ```bash
   pnpx wrangler d1 execute deeprecall-db-PRODUCT_ID-dev --env dev --remote \
     --command "SELECT * FROM db_metadata"
   ```

#### Workers AI rate limits

**Symptom**: Extraction or embedding requests fail with rate limit errors from the Anthropic API or Workers AI.

**Fix**:

- Check your Anthropic API usage and limits at [console.anthropic.com](https://console.anthropic.com).
- For embedding rate limits (Workers AI), reduce batch sizes or add delays between ingestion batches.
- The consolidation queue has built-in retry with a 10-second delay between retries (max 3 attempts). Transient rate limits typically self-resolve.

#### Foreign key ordering errors

**Symptom**: D1 returns a foreign key constraint error when creating a memory that supersedes another.

**Cause**: The `superseded_by` column references `memories(id)`. D1 enforces FK constraints strictly, so the new memory must be inserted before setting `superseded_by` on the old one.

**Fix**: This is handled in the ingestion pipeline. If you see this error, verify the pipeline logic creates the new memory row before updating the old row's `superseded_by` field.

#### ArrayBuffer detaches across RPC

**Symptom**: Errors like "ArrayBuffer has been detached" when processing documents via service bindings.

**Cause**: ArrayBuffer objects are transferred (not copied) across Cloudflare RPC boundaries. Once transferred, the original reference becomes detached.

**Fix**: Clone the buffer before passing it across a service binding call: `new Uint8Array(buffer.slice(0))`.

---

## 5. Cron Jobs

The consolidation worker runs two scheduled jobs. Both iterate over all registered products in KV.

| Schedule                        | Cron Expression | Description                                                                                                                                |
| ------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Daily at 3:00 AM UTC            | `0 3 * * *`     | Expiry sweep (expire memories past `validity_end`) + confidence decay (reduce confidence of aging memories, archive those below threshold) |
| Weekly on Sunday at 4:00 AM UTC | `0 4 * * SUN`   | Profile rebuild for all active users across all products                                                                                   |

The cron triggers are defined in `workers/consolidation/wrangler.jsonc`.

Queue configuration:

- Max batch size: 10 messages
- Max batch timeout: 30 seconds
- Max retries: 3
- Retry delay: 10 seconds

After 3 failed attempts, a message is moved to the dead letters table and acknowledged.

---

## 6. KV Configuration Reference

All configuration is stored in the `CONFIG` KV namespace.

### Product Keys

| Key Pattern                     | Value               | Description                                                                                                           |
| ------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apikey:<sha256(key)>`          | product_id          | Hashed API-key auth index — memory-api resolves a request by hashing the presented key and looking this up (O(1))     |
| `product:<id>:api_key_hash`     | hex string          | SHA-256 of the product's current key (non-secret bookkeeping; lets rotate/decommission delete the index entry)        |
| `product:<id>:db_binding`       | e.g., `DB_default`  | D1 binding name in the data worker                                                                                    |
| `product:<id>:vec_binding`      | e.g., `VEC_default` | Vectorize binding name in the data worker                                                                             |
| `product:<id>:config`           | JSON                | Full product configuration (product_id, name, db_id, db_name, vectorize_name, policy_overrides, features, created_at) |
| `product:<id>:policy_overrides` | JSON                | Policy override settings for the product                                                                              |

### System Keys

| Key Pattern                          | Value  | Description                                                                                                                                   |
| ------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin:api_key`                      | String | Admin authentication key for all admin endpoints                                                                                              |
| `template:<product_id>:<scene_type>` | String | Custom LLM extraction template. Must contain `{content}` placeholder or the LLM will extract from the instructions instead of the input text. |
| `consolidation:confidence_decay`     | JSON   | Decay configuration (rate, min_threshold, archive_below)                                                                                      |

### Example: Viewing KV values

```bash
# List all keys with a prefix
pnpx wrangler kv key list --namespace-id NAMESPACE_ID --remote --prefix "product:"

# Get a specific value
pnpx wrangler kv key get "product:default:config" --namespace-id NAMESPACE_ID --remote

# Set a value
pnpx wrangler kv key put "consolidation:confidence_decay" \
  '{"rate": 0.01, "min_threshold": 0.1, "archive_below": 0.05}' \
  --namespace-id NAMESPACE_ID --remote
```

---

## 7. Deployment

### Deploy Order

Workers must be deployed in a specific order due to service binding dependencies. Each worker depends on the workers listed before it being available:

```
data -> retrieval -> ingestion -> memory-api -> consolidation -> management
```

### Deployment Commands

Deploy all workers to dev:

```bash
pnpm deploy:dev
```

Deploy all workers to production:

```bash
pnpm deploy:prod
```

Deploy a single worker:

```bash
pnpm deploy:dev:data
pnpm deploy:dev:retrieval
pnpm deploy:dev:ingestion
pnpm deploy:dev:memory-api
pnpm deploy:dev:consolidation
pnpm deploy:dev:management
```

The `deploy:dev` and `deploy:prod` scripts handle the ordering automatically by chaining the individual deploy commands in sequence.

### Pre-Deployment Checklist

1. Run the build to verify no compilation errors:

   ```bash
   pnpm build
   ```

2. Run type checking:

   ```bash
   pnpm typecheck
   ```

3. Check migration status across all products:

   ```bash
   curl -s https://deeprecall-management-dev.<your-subdomain>.workers.dev/admin/migrations/status \
     -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
   ```

4. After deployment, verify health:
   ```bash
   curl -s https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/admin/health/detailed \
     -H "X-Admin-Key: YOUR_ADMIN_KEY" | jq
   ```

### Database Migrations

For the default product, run migrations via the wrangler CLI:

```bash
pnpm db:migrate:dev    # Dev environment
pnpm db:migrate:prod   # Production environment
```

For additional products, use the management API migrate-all endpoint or run directly:

```bash
pnpx wrangler d1 migrations apply deeprecall-db-PRODUCT_ID-dev --env dev --remote
```
