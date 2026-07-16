# Deep Recall API Guide

## Overview

Deep Recall provides a REST API for extracting, storing, and retrieving structured memories from conversations and documents. All public endpoints are under `/v1/`, admin endpoints under `/admin/`.

## Base URLs

URLs below use the default `workers.dev` addresses — substitute your own subdomain, or a custom domain if you attach one to the memory-api worker.

| Worker                      | Production                                                        | Development                                                      |
| --------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Memory API (public + admin) | `https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev` | `https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev` |
| Management API              | `https://deeprecall-management-prod.<your-subdomain>.workers.dev` | `https://deeprecall-management-dev.<your-subdomain>.workers.dev` |

> The ingestion, retrieval, data, and consolidation workers have **no public URL** — they are reachable only through service bindings, RPC, queues, and cron. Only memory-api and management accept HTTP.

All examples below use the production URLs. Swap in the dev URL when testing against dev.

## Authentication

### Public API

All `/v1/` endpoints require an API key in the `X-API-Key` header:

```
X-API-Key: your-api-key
```

### Admin API

All `/admin/` endpoints require an admin key in the `X-Admin-Key` header:

```
X-Admin-Key: your-admin-key
```

## Scope Model

**Your API key identifies the product.** Do not include `product_id` in request bodies — it is derived from the API key. The scope object on a request is now `(user_id?, agent_id?, session_id?)` with the Zod-enforced constraint that **at least one of `user_id` or `agent_id` must be present**. `session_id` is always optional and is only meaningful alongside one of the other two.

Memories themselves are stored with the same three optional scope columns (plus the implicit product from the database). A memory may therefore be scoped to a specific user, a specific agent, both, or neither — and null columns are treated as "applies to everyone on that dimension" by the relaxed matchers described below.

### The three scope shapes

| Shape                         | `user_id` | `agent_id` | Use case                                                                                                   |
| ----------------------------- | --------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| User-only                     | set       | null       | Traditional per-user memory. "Dana prefers dark mode."                                                     |
| Agent-only (shared knowledge) | null      | set        | Agent-level knowledge shared across all users. "The sales agent's default greeting."                       |
| User + agent (conversation)   | set       | set        | A specific user talking to a specific agent. "Dana is currently negotiating pricing with the sales agent." |

Agent-only memories (`user_id` null, `agent_id` set) are a first-class shape: they let a product store knowledge that isn't bound to any end user.

### The three match rules

Different endpoints apply different matching logic when comparing a caller's scope to a stored memory's scope.

- **Relaxed match** (used by retrieval, `GET /v1/memories`, search, `/admin/memories/dump`, `/admin/audit/recent`):
  For each scope key K the caller provides, `memory[K] === caller[K] OR memory[K] IS NULL`. A null on the memory means "applies to everyone on that dimension", so shared agent knowledge surfaces for every user who chats with that agent.
- **Strict match** (used by rate-limit counting, `/admin/memories/purge`, profile-fact selection):
  Exact equality on every scope key the caller provides. Null on the memory does **not** match. Strict match is used when ambiguity would be destructive — you don't want `DELETE WHERE user_id = 'dana'` to also pull in every agent-only memory where `user_id IS NULL`.
- **Authorization match** (used by `POST /v1/correct`, `GET /v1/inspect/:memory_id`):
  Strict equality **plus** at least one positive match on a non-null memory field. Non-contradiction alone is not enough — the caller must prove ownership of at least one scope field. This prevents a caller who knows only a memory id from mutating or inspecting a memory they don't own.

## Error Format

All errors follow this structure:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": {}
  }
}
```

Error codes:

| Code                   | HTTP Status | Description                                                                                                                    |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `VALIDATION_ERROR`     | 400         | Invalid request body, query parameters, or path parameters (includes the "at least one of `user_id` or `agent_id`" scope rule) |
| `AUTHENTICATION_ERROR` | 401/403     | Missing/invalid API key, insufficient permissions, or memory outside the caller's scope (correction / inspection)              |
| `NOT_FOUND`            | 404         | Requested resource does not exist                                                                                              |
| `CONFLICT`             | 409         | Resource already exists (e.g., duplicate product ID)                                                                           |
| `FILE_TOO_LARGE`       | 413         | Uploaded file exceeds the 25 MB limit                                                                                          |
| `UNSUPPORTED_CONTENT`  | 422         | Cannot extract text from the uploaded file type                                                                                |
| `FEATURE_DISABLED`     | 403         | Requested feature is not enabled for this product                                                                              |
| `INGESTION_ERROR`      | 502         | Document uploaded but ingestion pipeline failed to start                                                                       |
| `INTERNAL_ERROR`       | 500         | Unexpected server error                                                                                                        |
| `CONFIGURATION_ERROR`  | 500         | Missing required server configuration (admin endpoints only)                                                                   |
| `PROVISIONING_ERROR`   | 500         | Failed to provision Cloudflare resources (management API only)                                                                 |
| `SERVICE_UNAVAILABLE`  | 503         | Downstream service is unavailable                                                                                              |

---

## Public Endpoints

### POST /v1/ingest

Submit content for memory extraction. The ingestion pipeline runs asynchronously as a Cloudflare Workflow.

**Request Body:**

| Field              | Type   | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `content`          | string | Yes      | The text to extract memories from                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scope.user_id`    | string | No\*     | User identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scope.agent_id`   | string | No\*     | Agent identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `scope.session_id` | string | No       | Session identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `source_channel`   | string | No       | `chat` (default), `document`, `api`, `research`, `manual`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `scene_type`       | string | No       | Auto-classified if omitted. Options: `one_on_one_chat`, `group_chat`, `document`, `system_event`, `api_direct`                                                                                                                                                                                                                                                                                                                                                     |
| `occurred_at`      | string | No       | ISO 8601 timestamp of when the content originally occurred (e.g. the conversation's session time). Extraction anchors relative dates in the content ("last week", "yesterday") against this moment instead of the ingestion time, resolving them to absolute dates in the stored memories. Must include a timezone: `2023-05-08T13:56:00Z` and `2023-05-08T13:56:00+02:00` are accepted; a bare date (`2023-05-08`) or zone-less timestamp is rejected with a 400. |

> \* At least one of `user_id` or `agent_id` must be present. Product identity comes from your API key — do not send `product_id`.

> **Custom extraction templates:** if your product uses a custom template (KV), add a `{reference_time}` placeholder wherever the prompt should state when the content occurred — `occurred_at` is interpolated there. Templates without the placeholder still work, but `occurred_at` is then ignored for that product. Use each placeholder exactly once: only the first occurrence of `{content}` and `{reference_time}` is replaced.

**Headers:**

| Header            | Required | Description                                                                                                                |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `idempotency-key` | No       | Prevents duplicate processing. Same key within 24h returns the cached response with `x-idempotency-status: cached` header. |

**Example Request (user-scoped):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/ingest \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "content": "User: I love Italian food, especially pasta.\nAssistant: Great taste! Any favorite restaurants?",
    "scope": {
      "user_id": "user-001"
    },
    "source_channel": "chat",
    "occurred_at": "2026-07-01T18:30:00Z"
  }'
```

**Example Request (agent-only — shared agent knowledge, not tied to any end user):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/ingest \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "content": "The sales agent always opens with a friendly greeting and asks about pain points before pitching features.",
    "scope": {
      "agent_id": "sales-agent"
    },
    "source_channel": "manual"
  }'
```

**Response (202 Accepted):**

```json
{
  "instance_id": "abc123-def456",
  "status": "queued",
  "message": "Ingestion workflow started"
}
```

> Because ingestion runs asynchronously, poll `GET /v1/ingest/status/:instance_id` to see the outcome — this will tell you if candidates were rejected by policy (e.g., confidence threshold, PII) or skipped by reconcile (duplicates, pinned-memory conflicts).

---

### GET /v1/ingest/status/:instance_id

Poll for the outcome of a previously submitted ingestion. This is the companion to `POST /v1/ingest`: the `instance_id` returned in the 202 response identifies the workflow, and this endpoint reports whether candidates were extracted, approved, persisted, or rejected — without having to inspect D1 or workflow logs.

This endpoint exists because silent policy rejections would otherwise be invisible to the caller. For example, `source_type=agent_inferred` extractions below the default 0.7 confidence threshold are dropped by the policy engine and never persisted; the POST response has no way to surface that.

**Path Parameters:**

| Parameter     | Required | Description                                                      |
| ------------- | -------- | ---------------------------------------------------------------- |
| `instance_id` | Yes      | The workflow id returned from `POST /v1/ingest`. Must be a UUID. |

**Response Fields:**

| Field         | Description                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance_id` | Echoed back from the path.                                                                                                                      |
| `status`      | Workflow state: `queued`, `running`, `paused`, `waiting`, `waitingForEvent`, `complete`, `errored`, `terminated`, `unknown`.                    |
| `result`      | Populated only when `status === "complete"`. See below.                                                                                         |
| `summary`     | Human-readable one-liner distinguishing persisted N / no candidates extracted / all rejected by policy / approved but all skipped by reconcile. |
| `error`       | Non-null when `status === "errored"` or `terminated`; null otherwise.                                                                           |

When `status === "complete"`, `result` contains:

| Field                  | Description                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_ids`           | Ids of memories that were actually persisted.                                                                                                                                                           |
| `candidates_extracted` | Total candidates the extractor produced.                                                                                                                                                                |
| `candidates_approved`  | Candidates that passed policy.                                                                                                                                                                          |
| `candidates_persisted` | Candidates that survived reconcile and were written to the store.                                                                                                                                       |
| `rejections`           | Array of `{ step, content_preview, reason }` entries. `step` is `policy` (rule-based, e.g. confidence threshold, PII) or `reconcile` (LLM-based SKIP decision, e.g. duplicate, pinned-memory conflict). |

**Status codes:**

- `200 OK` — workflow found, payload returned.
- `400 VALIDATION_ERROR` — `instance_id` is not a well-formed UUID.
- `404 NOT_FOUND` — no workflow with that id.

**Example Request:**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/ingest/status/f5fbf041-7408-44c3-beb4-ed9e9ac28877" \
  -H "X-API-Key: your-key"
```

**Example Response — persisted:**

```json
{
  "instance_id": "f5fbf041-7408-44c3-beb4-ed9e9ac28877",
  "status": "complete",
  "result": {
    "memory_ids": ["mem-abc"],
    "candidates_extracted": 1,
    "candidates_approved": 1,
    "candidates_persisted": 1,
    "rejections": []
  },
  "summary": "Persisted 1 memory.",
  "error": null
}
```

**Example Response — rejected by policy (confidence threshold):**

```json
{
  "instance_id": "f5fbf041-7408-44c3-beb4-ed9e9ac28877",
  "status": "complete",
  "result": {
    "memory_ids": [],
    "candidates_extracted": 2,
    "candidates_approved": 0,
    "candidates_persisted": 0,
    "rejections": [
      {
        "step": "policy",
        "content_preview": "User might prefer Python...",
        "reason": "Agent-inferred memory confidence 0.6 is below threshold 0.7"
      },
      {
        "step": "policy",
        "content_preview": "User possibly located in Oregon...",
        "reason": "Agent-inferred memory confidence 0.55 is below threshold 0.7"
      }
    ]
  },
  "summary": "All 2 candidates rejected by policy.",
  "error": null
}
```

**Example Response — approved but skipped by reconcile (duplicate):**

```json
{
  "instance_id": "f5fbf041-7408-44c3-beb4-ed9e9ac28877",
  "status": "complete",
  "result": {
    "memory_ids": [],
    "candidates_extracted": 1,
    "candidates_approved": 1,
    "candidates_persisted": 0,
    "rejections": [
      {
        "step": "reconcile",
        "content_preview": "User loves Italian food, especially pasta...",
        "reason": "Candidate is a near-duplicate of mem-123 (User loves Italian food) — skipping to avoid redundant storage."
      }
    ]
  },
  "summary": "1 candidate approved but all skipped by reconcile.",
  "error": null
}
```

---

### POST /v1/query

Retrieve relevant memories via semantic search.

**Request Body:**

| Field              | Type   | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`            | string | Yes      | The search text                                                                                                                                                                                                                                                                                                                                                                                                   |
| `scope.user_id`    | string | No\*     | User identifier                                                                                                                                                                                                                                                                                                                                                                                                   |
| `scope.agent_id`   | string | No\*     | Agent identifier                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scope.session_id` | string | No       | Session identifier                                                                                                                                                                                                                                                                                                                                                                                                |
| `mode`             | string | No       | `recall` (default), `full_briefing`, `foresight`, `profile` — see [Retrieval modes](#retrieval-modes) below                                                                                                                                                                                                                                                                                                       |
| `top_k`            | number | No       | Max results, 1-50. Default: 30 — sized for the dominant consumer, an LLM agent grounding its own prompt (answer quality keeps improving up to ~30 memories, and retrieval latency is flat in `top_k`: the funnel fetches and reranks the same candidate pool regardless). Pass a smaller value (e.g. 10) when showing results directly to a human, or cut by `score` — results carry real [0,1] relevance scores. |

> \* At least one of `user_id` or `agent_id` must be present. Query uses **relaxed match**: a user-scoped query will also surface agent-only memories for the same product, since memories with `user_id IS NULL` are treated as applying to everyone on that dimension.

**Example Request (user-scoped):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/query \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "query": "What food does the user like?",
    "scope": {
      "user_id": "user-001"
    },
    "top_k": 5
  }'
```

**Example Request (agent-only):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/query \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "query": "How does the sales agent open conversations?",
    "scope": {
      "agent_id": "sales-agent"
    },
    "top_k": 5
  }'
```

**Example Request (user + agent conversation):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/query \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "query": "What is the current negotiation status?",
    "scope": {
      "user_id": "user-001",
      "agent_id": "sales-agent"
    },
    "mode": "full_briefing",
    "top_k": 10
  }'
```

**Response (200 OK):**

```json
{
  "memories": [
    {
      "memory": {
        "id": "mem-123",
        "content": "User loves Italian food, especially pasta",
        "type": "fact",
        "status": "active",
        "confidence": 0.92,
        "source_type": "user_stated",
        "source_channel": "chat",
        "created_at": "2026-04-13T12:00:00Z"
      },
      "score": 0.89
    }
  ],
  "total": 1,
  "mode": "recall"
}
```

#### Retrieval modes

Scope (`user_id` / `agent_id` / `session_id`) decides _which memories are eligible_. `mode` decides _which shape_ of recall you get back from among them.

| Mode               | Returns                                                                                                                                            | Uses query text? | Use when                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `recall` (default) | Reranked hybrid-search top hits. Foresight memories compete through the same ranking — they appear when relevant to the query, not unconditionally | Yes              | Per-turn reply drafting — most calls should use this                                                              |
| `full_briefing`    | Profile rollups + upcoming foresight **prepended**, then reranked hybrid-search hits                                                               | Yes              | Session start, handoffs, agent warm-up after long gaps                                                            |
| `foresight`        | Active `type=foresight` items only (in-progress tasks, upcoming events)                                                                            | Yes (to rank)    | "What's still open with this person?" — **⚠ not yet implemented, currently falls through to plain hybrid search** |
| `profile`          | Consolidated `type=profile` rollups only                                                                                                           | No               | "Who is this person?" — cheapest mode, skips embedding generation                                                 |

Notes:

- `recall` and `full_briefing` run the full retrieval funnel: Vectorize + FTS5 in parallel → RRF fusion → cross-encoder rerank. The returned `score` is the cross-encoder's query-conditioned relevance in `[0, 1]` — higher means the memory genuinely answers the query, and scores are comparable across queries. `full_briefing` additionally prepends profile + foresight rows (injected rows carry fixed scores: profile 1.0, foresight 0.95).
- `profile` bypasses the funnel entirely — no embedding is generated, no semantic search happens. The `query` field is still required by the schema but is not used.
- Foresight items whose `validity_end` has passed are excluded from the upcoming-plans injection in `full_briefing`, but remain retrievable by relevance in every mode — a plan whose window passed is still part of the user's history.

---

### POST /v1/answer

Answer a question **grounded in the product's memories**. Unlike `/v1/query` (which returns ranked memories for your own agent to reason over), `/v1/answer` retrieves memories and then makes a single LLM call to synthesize a direct, citation-backed answer.

> **Latency note.** This endpoint makes an LLM call and is therefore **slower than `/v1/query`** by design. Use it only when you want a synthesized answer rather than raw memories. The retrieval hot path (`/v1/query`) never calls an LLM.

**Request Body:**

| Field              | Type   | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `question`         | string | Yes      | The question to answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `scope.user_id`    | string | No\*     | User identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `scope.agent_id`   | string | No\*     | Agent identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `scope.session_id` | string | No       | Session identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mode`             | string | No       | Retrieval mode used to gather grounding memories: `recall` (default), `full_briefing`, `foresight`, `profile`                                                                                                                                                                                                                                                                                                                                                                              |
| `top_k`            | number | No       | How many memories to retrieve as grounding context, 1-50. Default: 30 (same as `/v1/query`): the extra grounding costs ~1K input tokens and no added retrieval latency, and measurably improves multi-hop and open-ended answers. The answer model ignores irrelevant grounding.                                                                                                                                                                                                           |
| `max_tokens`       | number | No       | Optional cap on generated answer tokens (64-64000). Omit to use the default (generous for Anthropic answer models, or the provider's own default for OpenAI/Google) — grounded answers are short, so it won't truncate a normal answer. If set explicitly, keep it within the configured model's output cap (Anthropic ≥ 64000; some OpenAI/Google models are lower). The Anthropic answer model runs adaptive thinking, which shares this budget, so a small value can starve the answer. |

> \* At least one of `user_id` or `agent_id` must be present (same scope rules and **relaxed match** as `/v1/query`).

**Example Request:**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/answer \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "question": "What kind of food should I recommend to this user?",
    "scope": {
      "user_id": "user-001"
    },
    "mode": "recall",
    "top_k": 10
  }'
```

**Response (200 OK):**

```json
{
  "answer": "Recommend Italian food — the user particularly likes pasta.",
  "based_on": ["mem-123"],
  "memories": [
    {
      "memory": {
        "id": "mem-123",
        "content": "User loves Italian food, especially pasta",
        "type": "fact",
        "status": "active",
        "confidence": 0.92,
        "source_type": "user_stated",
        "source_channel": "chat",
        "created_at": "2026-04-13T12:00:00Z"
      },
      "score": 0.89
    }
  ],
  "model": "anthropic:claude-sonnet-5",
  "usage": {
    "input_tokens": 412,
    "output_tokens": 24
  }
}
```

**Response fields:**

| Field      | Description                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `answer`   | The grounded natural-language answer. If the retrieved memories don't contain the answer, this says so plainly rather than inventing facts. |
| `based_on` | Memory ids the answer is grounded in. Validated against the retrieved set — the model cannot cite anything it wasn't given.                 |
| `memories` | The memories retrieved as grounding context (same shape as `/v1/query`), for provenance.                                                    |
| `model`    | The model spec actually used for this answer.                                                                                               |
| `usage`    | Token usage for the answer-generation call.                                                                                                 |

#### Model selection

The answer model is a `<provider>:<model-id>` spec. Providers: `anthropic`, `openai`, `google`. Resolution precedence:

1. **Per-product** — `answer_model` in the product's KV config, set via the `answer_model` field when onboarding a product through the Management API.
2. **Per-environment** — the `ANSWER_MODEL` var in the memory-api worker.
3. **Default** — `anthropic:claude-sonnet-5`.

Examples: `anthropic:claude-opus-4-8`, `openai:gpt-5`, `google:gemini-3-pro`. Swapping models is a config change — no redeploy of application code required. The provider's API key must be present as a worker secret (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`); only the selected provider's key is needed.

---

### GET /v1/health

Check the health status of D1 and Vectorize.

**Example:**

```bash
curl https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/health \
  -H "X-API-Key: your-key"
```

**Response (200 OK):**

```json
{
  "status": "ok",
  "service": "memory-api",
  "timestamp": "2026-04-13T12:00:00Z",
  "checks": {
    "d1": "ok",
    "vectorize": "ok"
  }
}
```

---

### POST /v1/correct

Apply a correction to an existing memory.

**Request Body:**

| Field              | Type   | Required     | Description                                       |
| ------------------ | ------ | ------------ | ------------------------------------------------- |
| `memory_id`        | string | Yes          | ID of the memory to correct                       |
| `action`           | string | Yes          | `suppress`, `expire`, `delete`, `pin`, `update`   |
| `scope.user_id`    | string | No\*         | User scope the caller is acting under             |
| `scope.agent_id`   | string | No\*         | Agent scope the caller is acting under            |
| `scope.session_id` | string | No           | Session identifier (not used for authorization)   |
| `reason`           | string | No           | Reason for the correction (logged in audit trail) |
| `updated_content`  | string | For `update` | New content to replace the memory with            |

> \* At least one of `scope.user_id` or `scope.agent_id` must be present — it's what `authorizeScope` compares against the memory.

**Actions:**

| Action     | Effect                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| `suppress` | Sets status to `suppressed`, removes from vector search                   |
| `expire`   | Sets status to `expired`                                                  |
| `delete`   | Soft deletes (status `archived`), removes from vector search              |
| `pin`      | Sets confidence=1.0, source_type=`user_stated`; immune to auto-supersede  |
| `update`   | Supersedes old memory, creates new with corrected content + new embedding |

> Correction uses **authorization match**: the caller's scope must strictly equal the memory's non-null scope fields, **and** at least one of those fields must be non-null on the memory. If the memory lives outside the caller's scope, the request returns `403 AUTHENTICATION_ERROR`.

**Example (suppress, user-scoped memory):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/correct \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "memory_id": "mem-123",
    "action": "suppress",
    "scope": { "user_id": "user-001" },
    "reason": "User requested removal"
  }'
```

**Example (update, user-scoped memory):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/correct \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "memory_id": "mem-123",
    "action": "update",
    "scope": { "user_id": "user-001" },
    "updated_content": "User now works at Anthropic",
    "reason": "Changed jobs"
  }'
```

**Example (correcting an agent-only memory):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/correct \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{
    "memory_id": "mem-agent-456",
    "action": "update",
    "scope": { "agent_id": "sales-agent" },
    "updated_content": "The sales agent now opens with a question about the prospects goals before discussing features.",
    "reason": "Playbook updated"
  }'
```

**Response (200 OK):**

```json
{
  "action": "update",
  "memory_id": "mem-123",
  "new_memory_id": "mem-456",
  "message": "Memory mem-123 updated successfully"
}
```

---

### GET /v1/inspect/:memory_id

Full memory record with provenance, audit trail, and superseded_by chain.

**Query Parameters:**

| Parameter  | Required | Description                      |
| ---------- | -------- | -------------------------------- |
| `user_id`  | No\*     | User scope to authorize against  |
| `agent_id` | No\*     | Agent scope to authorize against |

> \* At least one of `user_id` or `agent_id` must be present. Inspect uses **authorization match** (strict equality on provided keys plus at least one positive match on a non-null memory field). A mismatch returns **`403 AUTHENTICATION_ERROR`** — not `404`. This is deliberate: memory ids are random UUIDs, so existence-probing is infeasible, and a clear 403 is more useful to legitimate callers who passed the wrong scope.
>
> **Migration note:** Before this change, `GET /v1/inspect/:memory_id` performed no scope check — any API key holder for the product could inspect any memory by id. Integrations that relied on that behavior will now receive 403s unless they pass the memory's owning scope.

**Example (user-scoped memory):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/inspect/mem-123?user_id=user-001" \
  -H "X-API-Key: your-key"
```

**Example (agent-only memory):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/inspect/mem-agent-456?agent_id=sales-agent" \
  -H "X-API-Key: your-key"
```

**Example (user + agent conversation):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/inspect/mem-789?user_id=user-001&agent_id=sales-agent" \
  -H "X-API-Key: your-key"
```

**Response (200 OK):**

```json
{
  "memory": {
    "id": "mem-123",
    "content": "User loves Italian food",
    "type": "fact",
    "status": "active",
    "confidence": 0.92,
    "...": "..."
  },
  "audit_trail": [
    {
      "id": "audit-001",
      "memory_id": "mem-123",
      "action": "created",
      "reason": "Extracted from ingestion pipeline",
      "triggered_by": "ingestion_pipeline",
      "created_at": "2026-04-13T12:00:00Z"
    }
  ],
  "superseded_by_chain": []
}
```

---

### GET /v1/memories

List memories with filters and cursor pagination. Results are ordered by `created_at DESC, id DESC`.

When scope keys are provided, lookup uses **relaxed match** — passing only `user_id` will also return agent-only memories (where `user_id IS NULL`) that apply to every user in the product. When **no** scope keys are provided, the response is product-wide (all memories the API key's product can see). Combine with `since` for sync/ETL pulls that need everything ingested after a given timestamp.

**Query Parameters:**

| Parameter  | Required | Description                                                                             |
| ---------- | -------- | --------------------------------------------------------------------------------------- |
| `user_id`  | No       | User scope                                                                              |
| `agent_id` | No       | Agent scope                                                                             |
| `status`   | No       | Filter by status: `active`, `superseded`, `expired`, `archived`, `suppressed`           |
| `type`     | No       | Filter by type: `fact`, `episode`, `foresight`, `profile`                               |
| `since`    | No       | ISO 8601 timestamp — only memories with `created_at >= since` are returned (inclusive). |
| `limit`    | No       | 1-100, default 20                                                                       |
| `cursor`   | No       | Pagination cursor from previous response                                                |

**Example (user-scoped):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/memories?user_id=user-001&status=active&limit=10" \
  -H "X-API-Key: your-key"
```

**Example (agent-only):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/memories?agent_id=sales-agent&status=active&limit=10" \
  -H "X-API-Key: your-key"
```

**Example (user + agent):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/memories?user_id=user-001&agent_id=sales-agent&limit=10" \
  -H "X-API-Key: your-key"
```

**Example (product-wide, ingested since timestamp):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/memories?since=2026-05-01T00:00:00Z&limit=100" \
  -H "X-API-Key: your-key"
```

**Example (user-scoped, ingested since timestamp):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/memories?user_id=user-001&since=2026-05-01T00:00:00Z" \
  -H "X-API-Key: your-key"
```

**Response (200 OK):**

```json
{
  "memories": [
    {
      "id": "mem-123",
      "content": "User loves Italian food",
      "type": "fact",
      "status": "active",
      "...": "..."
    }
  ],
  "cursor": "2026-04-13T12:00:00Z|mem-123",
  "total": 1
}
```

---

### POST /v1/documents

Upload a document for memory extraction. The file is stored in R2, then the content is chunked and each chunk is processed through the memory extraction pipeline.

**Content-Type:** `multipart/form-data`

**Form Fields:**

| Field             | Type          | Required | Description                                                                                                                                                                                         |
| ----------------- | ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`            | file          | Yes      | The document file. See "Supported file types" below.                                                                                                                                                |
| `scope`           | string (JSON) | Yes      | JSON string with `user_id` and/or `agent_id` (at least one), and optional `session_id`. **Do not include `product_id`** — it is derived from the API key.                                           |
| `document_type`   | string        | No       | Free-form classification tag (e.g., `"transcript"`, `"meeting_notes"`, `"knowledge_file"`). Stored on the document row and usable as a filter on `GET /v1/documents`. Empty or missing stores NULL. |
| `description`     | string        | No       | Human-readable description of the document                                                                                                                                                          |
| `scene_type`      | string        | No       | Default: `document`                                                                                                                                                                                 |
| `idempotency_key` | string        | No       | Prevents duplicate processing                                                                                                                                                                       |

**Supported file types** — the server derives an enum `file_type` from the upload's MIME type (with filename fallback) and rejects anything outside this list with `422 UNSUPPORTED_CONTENT`:

| `file_type` | Matches                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `pdf`       | MIME `application/pdf`                                                        |
| `markdown`  | MIME `text/markdown` / `text/x-markdown`, or filename `*.md` / `*.markdown`   |
| `text`      | MIME `text/*` (other than markdown), or filename `*.txt` when MIME is missing |
| `json`      | MIME `application/json`, or filename `*.json` when MIME is missing            |

`file_type` is persisted on the document row and can be used as a filter on `GET /v1/documents`.

**Example (user-scoped document):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/documents \
  -H "X-API-Key: your-key" \
  -F "file=@research-notes.md" \
  -F 'scope={"user_id": "user-001"}' \
  -F "document_type=knowledge_file" \
  -F "description=Q1 research summary"
```

**Example (agent-only document — shared knowledge):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/documents \
  -H "X-API-Key: your-key" \
  -F "file=@sales-playbook.pdf" \
  -F 'scope={"agent_id": "sales-agent"}' \
  -F "document_type=playbook" \
  -F "description=Sales agent playbook"
```

**Response (202 Accepted):**

```json
{
  "document_id": "doc-abc123",
  "instance_id": "wf-def456",
  "instance_ids": ["wf-def456", "wf-ghi789"],
  "chunks": 3,
  "filename": "research-notes.md",
  "size_bytes": 4096,
  "message": "Document uploaded and 3 chunk(s) queued for extraction"
}
```

---

### GET /v1/documents/:document_id

Retrieve metadata for a previously uploaded document.

**Path Parameters:**

| Parameter     | Required | Description                                   |
| ------------- | -------- | --------------------------------------------- |
| `document_id` | Yes      | Document ID returned from the upload endpoint |

**Example:**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/documents/doc-abc123" \
  -H "X-API-Key: your-key"
```

**Response (200 OK):**

```json
{
  "document": {
    "id": "doc-abc123",
    "r2_key": "products/default/documents/doc-abc123",
    "filename": "research-notes.md",
    "mime_type": "text/markdown",
    "size_bytes": 4096,
    "file_type": "markdown",
    "document_type": "knowledge_file",
    "description": "Q1 research summary",
    "user_id": "user-001",
    "agent_id": null,
    "session_id": null,
    "uploaded_at": "2026-04-13T12:00:00Z",
    "metadata": {}
  }
}
```

---

### GET /v1/documents/:document_id/content

Download the raw content of a previously uploaded document. Returns the file with its original MIME type.

**Path Parameters:**

| Parameter     | Required | Description |
| ------------- | -------- | ----------- |
| `document_id` | Yes      | Document ID |

**Example:**

```bash
curl -OJ "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/documents/doc-abc123/content" \
  -H "X-API-Key: your-key"
```

**Response (200 OK):**

Returns the raw file content with `Content-Type` set to the original MIME type and a `Content-Disposition` header for download (e.g., `attachment; filename="research-notes.md"`).

---

### GET /v1/documents

List documents for the authenticated product with cursor pagination. Scope filters are optional and use **relaxed match** — null on the row passes — mirroring `GET /v1/memories` semantics. So a query for `user_id=u1` surfaces documents uploaded by `u1` _and_ agent-only documents (no user). When no scope filter is provided, every document in the product is returned.

**Query Parameters:**

| Parameter       | Required                     | Description                                                                 |
| --------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `user_id`       | No                           | Relaxed match: docs with `user_id = <value>` OR `user_id IS NULL` pass      |
| `agent_id`      | No                           | Relaxed match: docs with `agent_id = <value>` OR `agent_id IS NULL` pass    |
| `session_id`    | No                           | Relaxed match on the session the upload happened in                         |
| `document_type` | No                           | Exact match on the free-form classification tag supplied at upload time     |
| `file_type`     | No                           | Restrict to a derived file format: `pdf`, `markdown`, `text`, `json`        |
| `limit`         | No (default `50`, max `100`) | Page size                                                                   |
| `cursor`        | No                           | Pass back the `next_cursor` from a previous response to fetch the next page |

Results are ordered by `uploaded_at DESC, id DESC`. Omit filters to list every document the product owns.

**Example:**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/documents?user_id=user-001&limit=20" \
  -H "X-API-Key: your-key"
```

**Response (200 OK):**

```json
{
  "documents": [
    {
      "id": "doc-abc123",
      "r2_key": "default/documents/doc-abc123/research-notes.md",
      "filename": "research-notes.md",
      "mime_type": "text/markdown",
      "size_bytes": 4096,
      "file_type": "markdown",
      "document_type": "knowledge_file",
      "description": "Q1 research summary",
      "user_id": "user-001",
      "agent_id": null,
      "session_id": null,
      "uploaded_at": "2026-04-13T12:00:00Z",
      "metadata": null
    }
  ],
  "next_cursor": "2026-04-13T12:00:00Z|doc-abc123"
}
```

When `next_cursor` is `null`, there are no more pages.

---

### PUT /v1/documents/:document_id

Replace a document's content with a new upload. The `document_id` stays the same but every other aspect of the doc (file bytes, filename, MIME type, extracted memories) is replaced.

**What happens, in order:**

1. Validate the new file + scope + extract text (same checks as upload). If any fail, the old document is untouched.
2. Cascade-delete memories extracted from the old version — vectors, audit rows, and memory rows all go.
3. Delete the old R2 blob.
4. Upload the new R2 blob under `{product_id}/documents/{document_id}/{filename}`.
5. Update the document row (filename, mime_type, size, r2_key, file_type, document_type, description, user_id/agent_id/session_id). `file_type` is re-derived from the new upload; scope is replaced by whatever is in the new multipart `scope` body.
6. Chunk the new content and fan out ingestion workflows that reference the same `document_id`.

The `scope` in the new multipart body replaces the document's prior scope (user_id, agent_id, session_id) atomically — callers can reassign a document from one user/agent/session to another.

**Request:** `multipart/form-data` (same fields as `POST /v1/documents`, plus no `document_id` because it's in the URL).

| Field             | Required                | Description                                                                   |
| ----------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `file`            | Yes                     | New document content. Max 25 MB.                                              |
| `scope`           | Yes                     | JSON-encoded scope for the re-ingestion (user_id and/or agent_id)             |
| `document_type`   | No                      | Free-form tag. Pass an empty string to clear; omit to keep the existing value |
| `description`     | No                      | Pass to replace the existing description; omit to keep it                     |
| `scene_type`      | No (default `document`) | Scene type passed to the extraction pipeline                                  |
| `idempotency_key` | No                      | Per-chunk idempotency key: `{key}:chunk-{i}` is sent to the pipeline          |

**Guardrails:**

- Unsupported MIME types return `422 UNSUPPORTED_CONTENT` before any destructive work runs.
- If the old document has more than 5000 linked memories the call returns `409 CASCADE_TOO_LARGE` — delete + re-upload via `POST /v1/documents/purge` + `POST /v1/documents` instead.

**Example:**

```bash
curl -X PUT "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/documents/doc-abc123" \
  -H "X-API-Key: your-key" \
  -F "file=@./research-notes-v2.md;type=text/markdown" \
  -F 'scope={"user_id":"user-001"}' \
  -F "description=Q1 research summary — revised"
```

**Response (202 Accepted):**

```json
{
  "document_id": "doc-abc123",
  "instance_id": "ingest_123",
  "instance_ids": ["ingest_123"],
  "chunks": 1,
  "filename": "research-notes-v2.md",
  "size_bytes": 5120,
  "old_memories_deleted": 3,
  "old_vectors_deleted": 3,
  "old_audits_deleted": 4,
  "message": "Document replaced and 1 chunk(s) sent for ingestion"
}
```

---

### DELETE /v1/documents/:document_id

Delete a single document and cascade-clean everything extracted from it. Runs synchronously.

**What gets deleted:**

- Every memory with `document_id = :document_id`, plus that memory's vector and audit rows
- The R2 blob
- The document row in D1

**Guardrail:** If the document has more than 5000 linked memories the call returns `409 CASCADE_TOO_LARGE` — use `POST /v1/documents/purge` with scope for async processing.

**Example:**

```bash
curl -X DELETE "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/documents/doc-abc123" \
  -H "X-API-Key: your-key"
```

**Response (200 OK):**

```json
{
  "deleted": true,
  "document_id": "doc-abc123",
  "memories_deleted": 3,
  "vectors_deleted": 3,
  "audits_deleted": 4
}
```

---

### POST /v1/documents/purge

Asynchronously delete many documents at once. Either scoped (user/agent — strict match) or product-wide. Returns 202 + `job_id`; poll `GET /v1/documents/purge/status/:job_id` to watch completion.

**Request Body:**

Exactly one of `scope` or `confirm_product_id` must be provided.

| Field                | Required                                 | Description                                                              |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| `scope.user_id`      | Scoped variant — one of user_id/agent_id | Purge documents where `user_id = <value>` (strict — null doesn't match)  |
| `scope.agent_id`     | Scoped variant — one of user_id/agent_id | Purge documents where `agent_id = <value>` (strict — null doesn't match) |
| `confirm_product_id` | Product-wide variant                     | Must exactly equal the product ID derived from the API key               |
| `confirm`            | Required when `dry_run` is false         | Must be `true`                                                           |
| `dry_run`            | No (default `false`)                     | Returns counts synchronously without scheduling a job                    |

**What gets deleted:**

- Matched document rows in D1
- Matched R2 blobs
- Every memory with `document_id` pointing at a deleted document, plus its vector and audit rows

**Example (scoped by user):**

```bash
curl -X POST "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/documents/purge" \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": { "user_id": "user-001" },
    "confirm": true
  }'
```

**Example (product-wide):**

```bash
curl -X POST "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/documents/purge" \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm_product_id": "default",
    "confirm": true
  }'
```

**Response (202 Accepted):**

```json
{
  "job_id": "purge_abc123",
  "status": "pending",
  "type": "purge_documents_scoped",
  "status_url": "/v1/documents/purge/status/purge_abc123"
}
```

**Dry-run response (200 OK):**

```json
{
  "dry_run": true,
  "scope": { "user_id": "user-001" },
  "documents_would_delete": 4,
  "memories_would_delete": 28
}
```

---

### GET /v1/documents/purge/status/:job_id

Poll the status of a document purge job. Jobs are stored in KV for 24h. Uses the same KV record format as memory purges — the `documents_deleted` and `r2_blobs_deleted` fields carry the doc-specific counts.

**Example:**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/documents/purge/status/purge_abc123" \
  -H "X-API-Key: your-key"
```

**Response (200 OK):**

```json
{
  "job_id": "purge_abc123",
  "product_id": "default",
  "type": "purge_documents_scoped",
  "status": "completed",
  "scope": { "user_id": "user-001" },
  "memories_deleted": 28,
  "vectors_deleted": 28,
  "audits_deleted": 31,
  "documents_deleted": 4,
  "r2_blobs_deleted": 4,
  "created_at": "2026-04-22T10:00:00Z",
  "started_at": "2026-04-22T10:00:01Z",
  "completed_at": "2026-04-22T10:00:05Z",
  "error": null
}
```

---

### POST /v1/memories/purge

Asynchronously delete every memory matching a given user and/or agent scope. The call returns immediately with a `job_id`; the actual deletion runs in the background and can be polled via `GET /v1/memories/purge/status/:job_id`.

Products can only purge data within their own tenant — the product is resolved from the `X-API-Key` header.

**Request Body:**

| Field            | Required                             | Description                                                 |
| ---------------- | ------------------------------------ | ----------------------------------------------------------- |
| `scope.user_id`  | At least one of `user_id`/`agent_id` | Only delete memories with this user_id                      |
| `scope.agent_id` | At least one of `user_id`/`agent_id` | Only delete memories with this agent_id                     |
| `confirm`        | Required when `dry_run` is false     | Must be `true` — defends against accidental invocations     |
| `dry_run`        | No (default `false`)                 | If `true`, returns the count synchronously without deleting |

**Scope matching is strict.** A memory is deleted only when every field you provide in `scope` exactly matches the memory. A memory with `user_id: null` is **not** deleted by a purge that names a `user_id`.

**What gets deleted:**

- Memory rows in D1
- Vector embeddings in Vectorize
- Audit log entries for those memories

**What does NOT get deleted:**

- Source documents (R2 + `documents` table) — purge these separately if needed
- Idempotency keys (cleaned automatically by the daily expiry sweep)
- Dead letters

**Example — async purge:**

```bash
curl -X POST "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/memories/purge" \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": { "user_id": "u_123" },
    "confirm": true
  }'
```

**Response (202 Accepted):**

```json
{
  "job_id": "purge_abc123",
  "status": "pending",
  "type": "purge_scoped",
  "status_url": "/v1/memories/purge/status/purge_abc123"
}
```

**Example — dry run (synchronous):**

```bash
curl -X POST "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/memories/purge" \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": { "agent_id": "agent-abc" },
    "dry_run": true
  }'
```

**Response (200 OK):**

```json
{
  "dry_run": true,
  "type": "purge_scoped",
  "scope": { "agent_id": "agent-abc" },
  "memories_would_delete": 42
}
```

---

### GET /v1/memories/purge/status/:job_id

Poll the status of a purge job. Jobs expire from storage 24 hours after creation; polling a stale or unknown job returns `404`.

**Path Parameters:**

| Parameter | Required | Description                                                                |
| --------- | -------- | -------------------------------------------------------------------------- |
| `job_id`  | Yes      | Job ID returned from `POST /v1/memories/purge` or `/v1/memories/purge-all` |

**Response (200 OK):**

```json
{
  "job_id": "purge_abc123",
  "product_id": "default",
  "type": "purge_scoped",
  "status": "completed",
  "scope": { "user_id": "u_123" },
  "memories_deleted": 42,
  "vectors_deleted": 42,
  "audits_deleted": 61,
  "created_at": "2026-04-22T12:00:00Z",
  "started_at": "2026-04-22T12:00:01Z",
  "completed_at": "2026-04-22T12:00:03Z",
  "error": null
}
```

**Status values:**

| Status       | Meaning                                                     |
| ------------ | ----------------------------------------------------------- |
| `pending`    | Queued, not yet picked up                                   |
| `processing` | Deletion in progress                                        |
| `completed`  | Terminal success — counts are final                         |
| `failed`     | Terminal failure after 3 retries — `error` holds the reason |

---

### POST /v1/memories/purge-all

Asynchronously delete **every memory** the calling product owns. Irreversible. Intended for full-tenant resets (e.g., test-data cleanup, customer off-boarding).

**Request Body:**

| Field                | Required                         | Description                                                                                               |
| -------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `confirm_product_id` | Yes                              | Must exactly equal the product ID derived from the API key                                                |
| `confirm`            | Required when `dry_run` is false | Must be `true`                                                                                            |
| `dry_run`            | No (default `false`)             | If `true`, returns an estimated count synchronously                                                       |
| `include_documents`  | No (default `false`)             | When `true`, also wipes every document row and R2 blob. Opt-in to preserve backwards-compatible semantics |

`confirm_product_id` forces the caller to name the product explicitly, so a misconfigured client cannot accidentally nuke the wrong tenant.

**What gets deleted:**

- Every memory row, every vector, and every audit entry owned by this product
- (When `include_documents: true`) every document row and every R2 blob under `{product_id}/documents/`

To wipe documents alone without touching memories, use `POST /v1/documents/purge` with `confirm_product_id` instead.

**What does NOT get deleted:**

- Dead letters
- Idempotency keys
- Product configuration in KV
- (When `include_documents: false` — the default) documents and their R2 blobs

**Example:**

```bash
curl -X POST "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/v1/memories/purge-all" \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm_product_id": "default",
    "confirm": true
  }'
```

**Response (202 Accepted):**

```json
{
  "job_id": "purge_xyz789",
  "status": "pending",
  "type": "purge_product",
  "status_url": "/v1/memories/purge/status/purge_xyz789"
}
```

Poll the status URL to watch the job complete.

---

## Admin Endpoints

### GET /admin/memories/dump

List all memories for a scope (debugging, no pagination). Uses **relaxed match** — passing only `user_id` also returns agent-only memories.

**Query Parameters:**

| Parameter  | Required | Description                |
| ---------- | -------- | -------------------------- |
| `user_id`  | No\*     | User to dump memories for  |
| `agent_id` | No\*     | Agent to dump memories for |

> \* At least one of `user_id` or `agent_id` must be present.

**Example (user-scoped):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/memories/dump?user_id=user-001" \
  -H "X-Admin-Key: your-admin-key"
```

**Example (agent-only):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/memories/dump?agent_id=sales-agent" \
  -H "X-Admin-Key: your-admin-key"
```

---

### POST /admin/memories/purge

Delete memories and vectors for a scope. Uses **strict match** — only memories whose non-null scope fields exactly equal the request are deleted. Agent-only memories (`user_id IS NULL`) are NOT deleted when purging by `user_id` alone. **Irreversible.**

**Request Body:**

| Field      | Required | Description |
| ---------- | -------- | ----------- |
| `user_id`  | No\*     | User scope  |
| `agent_id` | No\*     | Agent scope |

> \* At least one of `user_id` or `agent_id` must be present.

**Example (purge user memories only):**

```json
{
  "user_id": "user-001"
}
```

**Example (purge agent-only shared memories):**

```json
{
  "agent_id": "sales-agent"
}
```

**Example (purge a specific user+agent conversation):**

```json
{
  "user_id": "user-001",
  "agent_id": "sales-agent"
}
```

**Response:**

```json
{
  "message": "Purge complete",
  "memories_deleted": 5,
  "vectors_deleted": 5,
  "audits_deleted": 17
}
```

---

### GET /admin/health/detailed

Detailed health check with latency measurements for all services.

**Response:**

```json
{
  "status": "ok",
  "service": "memory-api",
  "timestamp": "2026-04-13T12:00:00Z",
  "checks": {
    "d1": { "status": "ok", "latency_ms": 2 },
    "vectorize": { "status": "ok", "latency_ms": 15 },
    "kv": { "status": "ok", "latency_ms": 1 },
    "ingestion": { "status": "ok", "latency_ms": 5 },
    "retrieval": { "status": "ok", "latency_ms": 3 }
  }
}
```

---

### POST /admin/pipeline/test-extract

Run LLM extraction on sample text without persisting any results.

**Request Body:**

| Field        | Type   | Required | Description                   |
| ------------ | ------ | -------- | ----------------------------- |
| `content`    | string | Yes      | Text to extract memories from |
| `scene_type` | string | No       | Default: `one_on_one_chat`    |

**Example:**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/pipeline/test-extract \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{
    "content": "User: I just started learning Rust.",
    "scene_type": "one_on_one_chat"
  }'
```

**Response:**

```json
{
  "candidates": [
    {
      "content": "User is learning Rust programming language",
      "type": "fact",
      "source_type": "user_stated",
      "confidence": 0.9,
      "tags": ["programming"]
    }
  ],
  "count": 1,
  "message": "Extraction test complete (nothing persisted)"
}
```

---

### POST /admin/pipeline/test-reconcile

Test reconciliation for a candidate against existing memories without persisting.

**Request Body:**

| Field               | Type   | Required | Description                                       |
| ------------------- | ------ | -------- | ------------------------------------------------- |
| `candidate_content` | string | Yes      | Content to test reconciliation for                |
| `user_id`           | string | No\*     | User scope to search similar memories for         |
| `agent_id`          | string | No\*     | Agent scope to search similar memories for        |
| `product_id`        | string | No       | Target product (defaults to `default`)            |
| `top_k`             | number | No       | Max similar memories to compare (1-20, default 5) |

> \* At least one of `user_id` or `agent_id` must be present.

**Response:**

```json
{
  "decision": {
    "action": "supersede",
    "reason": "Candidate provides updated workplace information",
    "existing_memory_id": "mem-123",
    "merged_content": null
  },
  "similar_memories": [{ "id": "mem-123", "content": "User works at Stripe", "score": 0.87 }],
  "message": "Reconciliation test complete (nothing persisted)"
}
```

---

### GET /admin/audit/recent

View recent audit entries for a scope. Uses **relaxed match**.

**Query Parameters:**

| Parameter  | Required | Description                    |
| ---------- | -------- | ------------------------------ |
| `user_id`  | No\*     | User to get audit entries for  |
| `agent_id` | No\*     | Agent to get audit entries for |
| `limit`    | No       | 1-200, default 50              |

> \* At least one of `user_id` or `agent_id` must be present.

**Example (user-scoped):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/audit/recent?user_id=user-001&limit=20" \
  -H "X-Admin-Key: your-admin-key"
```

**Example (agent-only):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/audit/recent?agent_id=sales-agent&limit=20" \
  -H "X-Admin-Key: your-admin-key"
```

**Response:**

```json
{
  "entries": [
    {
      "id": "audit-001",
      "memory_id": "mem-123",
      "action": "created",
      "reason": "Extracted from ingestion pipeline",
      "triggered_by": "ingestion_pipeline",
      "created_at": "2026-04-13T12:00:00Z"
    }
  ],
  "total": 1
}
```

---

### GET /admin/dead-letters

List dead letter entries — consolidation messages that failed after max retries.

**Query Parameters:**

| Parameter | Required | Description       |
| --------- | -------- | ----------------- |
| `limit`   | No       | 1-200, default 50 |

**Example:**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/dead-letters?limit=20" \
  -H "X-Admin-Key: your-admin-key"
```

**Response:**

```json
{
  "entries": [
    {
      "id": "dl-001",
      "queue_name": "consolidation",
      "payload": "{\"type\":\"profile_rebuild\",\"scope\":{...}}",
      "error": "Failed after 3 attempts",
      "attempts": 3,
      "first_failed_at": "2026-04-13T03:00:00Z",
      "last_failed_at": "2026-04-13T03:05:00Z"
    }
  ],
  "total": 1
}
```

---

### POST /admin/dead-letters/:id/reprocess

Requeue a dead letter for retry. The original message is re-sent to the consolidation queue and the dead letter entry is deleted.

**Path Parameters:**

| Parameter | Required | Description    |
| --------- | -------- | -------------- |
| `id`      | Yes      | Dead letter ID |

**Example:**

```bash
curl -X POST "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/dead-letters/dl-001/reprocess" \
  -H "X-Admin-Key: your-admin-key"
```

**Response:**

```json
{
  "message": "Dead letter requeued for processing",
  "dead_letter_id": "dl-001"
}
```

---

### POST /admin/consolidation/trigger

Manually trigger a consolidation job for a scope.

**Request Body:**

| Field        | Type     | Required | Description                                                                  |
| ------------ | -------- | -------- | ---------------------------------------------------------------------------- |
| `type`       | string   | Yes      | `profile_rebuild`, `expiry_sweep`, `confidence_decay`, `conflict_resolution` |
| `user_id`    | string   | No\*     | User scope                                                                   |
| `agent_id`   | string   | No\*     | Agent scope                                                                  |
| `product_id` | string   | No       | Target product (defaults to `default`)                                       |
| `memory_ids` | string[] | No       | Required for `conflict_resolution`                                           |

> \* At least one of `user_id` or `agent_id` must be present. Admin endpoints accept `product_id` explicitly (different auth than the public API — the admin key isn't scoped to a product).

**Job types:**

| Type                  | Description                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile_rebuild`     | Synthesize a profile memory from high-confidence facts. User-scoped and agent-only profiles are **disjoint** — they consolidate separately. |
| `expiry_sweep`        | Mark expired foresight items, clean up idempotency keys                                                                                     |
| `confidence_decay`    | Reduce confidence of stale memories (not updated in 30+ days)                                                                               |
| `conflict_resolution` | Detect and resolve contradictory memories                                                                                                   |

**Example (user profile rebuild):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/consolidation/trigger \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{
    "type": "profile_rebuild",
    "user_id": "user-001"
  }'
```

**Example (agent-only profile rebuild):**

```bash
curl -X POST https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/consolidation/trigger \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{
    "type": "profile_rebuild",
    "agent_id": "sales-agent"
  }'
```

**Response:**

```json
{
  "message": "Consolidation job 'profile_rebuild' enqueued",
  "scope": { "user_id": "user-001" }
}
```

---

### GET /admin/consolidation/status

Check consolidation system status: dead letter count and recent consolidation activity.

**Query Parameters:**

| Parameter    | Required | Description                                   |
| ------------ | -------- | --------------------------------------------- |
| `user_id`    | No       | Filter recent consolidation activity by user  |
| `agent_id`   | No       | Filter recent consolidation activity by agent |
| `product_id` | No       | Target product (defaults to `default`)        |

> `recent_consolidation_activity` is only populated when `user_id` or `agent_id` is provided. `dead_letter_count` is always returned.

**Example:**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/consolidation/status?user_id=user-001" \
  -H "X-Admin-Key: your-admin-key"
```

**Example (agent-only):**

```bash
curl "https://deeprecall-memory-api-prod.<your-subdomain>.workers.dev/admin/consolidation/status?agent_id=sales-agent" \
  -H "X-Admin-Key: your-admin-key"
```

**Response:**

```json
{
  "dead_letter_count": 0,
  "recent_consolidation_activity": [],
  "cron_schedule": {
    "daily_sweep": "0 3 * * * (3 AM UTC — expiry sweep + confidence decay)",
    "weekly_profile": "0 4 * * 0 (Sunday 4 AM UTC — profile rebuild)"
  }
}
```

---

## Management API

The management API runs on a separate worker and handles multi-tenant product onboarding, listing, and schema migrations. All management endpoints require the `X-Admin-Key` header.

### POST /admin/products/onboard

Onboard a new product (tenant) into the Deep Recall system. Creates the product's D1 database, Vectorize index, and API key.

**Request Body:**

| Field              | Type   | Required | Description                      |
| ------------------ | ------ | -------- | -------------------------------- |
| `product_id`       | string | Yes      | URL-safe slug, 3-30 characters   |
| `name`             | string | Yes      | Human-readable product name      |
| `policy_overrides` | object | No       | Override default memory policies |
| `features`         | array  | No       | Feature flags for the product    |

**Example:**

```bash
curl -X POST https://deeprecall-management-prod.<your-subdomain>.workers.dev/admin/products/onboard \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{
    "product_id": "my-product",
    "name": "My Product",
    "policy_overrides": {},
    "features": []
  }'
```

**Response (201 Created):**

```json
{
  "product_id": "my-product",
  "api_key": "dr_live_abc123...",
  "db_name": "deeprecall-my-product",
  "db_id": "d1-uuid-here",
  "vectorize_name": "deeprecall-my-product-memories",
  "wrangler_snippet": "[[d1_databases]]\nname = ...",
  "message": "Product 'my-product' onboarded successfully"
}
```

---

### GET /admin/products

List all registered products (tenants).

**Example:**

```bash
curl "https://deeprecall-management-prod.<your-subdomain>.workers.dev/admin/products" \
  -H "X-Admin-Key: your-admin-key"
```

**Response (200 OK):**

```json
{
  "products": [
    {
      "product_id": "my-product",
      "name": "My Product",
      "created_at": "2026-04-13T12:00:00Z"
    }
  ],
  "total": 1
}
```

---

### DELETE /admin/products/:id

Delete a product and all its Cloudflare resources (D1 database, Vectorize index, R2 documents, KV entries). This is a destructive, irreversible operation.

**Path Parameters:**

| Parameter | Required | Description                             |
| --------- | -------- | --------------------------------------- |
| `id`      | Yes      | Product ID (slug). Cannot be `default`. |

**Request Body:**

| Field     | Type    | Required | Description                                            |
| --------- | ------- | -------- | ------------------------------------------------------ |
| `confirm` | boolean | Yes      | Must be `true`. Safeguard against accidental deletion. |

**Example:**

```bash
curl -X DELETE "https://deeprecall-management-prod.<your-subdomain>.workers.dev/admin/products/my-product" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{"confirm": true}'
```

**Response (200 OK):**

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

If any resource fails to delete, `status` will be `"partial_failure"` and the failing step will include an `error` field. The other resources are still deleted.

---

### POST /admin/products/:id/migrate

Check or trigger schema migration for a specific product.

**Path Parameters:**

| Parameter | Required | Description       |
| --------- | -------- | ----------------- |
| `id`      | Yes      | Product ID (slug) |

**Example:**

```bash
curl -X POST "https://deeprecall-management-prod.<your-subdomain>.workers.dev/admin/products/my-product/migrate" \
  -H "X-Admin-Key: your-admin-key"
```

**Response (200 OK):**

```json
{
  "product_id": "my-product",
  "current_version": 3,
  "latest_version": 4,
  "status": "migrated",
  "message": "Schema migrated from v3 to v4"
}
```

---

### POST /admin/migrations/migrate-all

Run pending schema migrations across all registered product databases. For each product, reads the current schema version, determines pending migrations, executes them via the Cloudflare D1 API, and reports per-product results.

**Example:**

```bash
curl -X POST "https://deeprecall-management-prod.<your-subdomain>.workers.dev/admin/migrations/migrate-all" \
  -H "X-Admin-Key: your-admin-key"
```

**Response (200 OK):**

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
      "previous_version": "2",
      "new_version": "3",
      "status": "migrated",
      "migrations_applied": ["3"]
    },
    {
      "product_id": "my-product",
      "db_name": "deeprecall-db-my-product-dev",
      "previous_version": "3",
      "new_version": "3",
      "status": "up_to_date",
      "migrations_applied": []
    }
  ]
}
```

**Result status values:**

- `migrated` — Migrations were successfully applied
- `up_to_date` — No migrations needed
- `error` — Migration failed (partial results in `migrations_applied`)

---

### GET /admin/migrations/status

Get schema version status across all registered products.

**Example:**

```bash
curl "https://deeprecall-management-prod.<your-subdomain>.workers.dev/admin/migrations/status" \
  -H "X-Admin-Key: your-admin-key"
```

**Response (200 OK):**

```json
{
  "products": [
    {
      "product_id": "my-product",
      "current_version": 4,
      "latest_version": 4,
      "status": "up_to_date"
    }
  ],
  "total": 1,
  "latest_version": 4
}
```
