# Deep Recall — Architecture

## Design Philosophy

This system distills the best ideas from Mem0 (Extract→Reconcile→Persist pipeline, scoped memory, audit separation) and EverMemOS (structured MemCells, foresight, hybrid retrieval, profile consolidation) onto a Cloudflare-native stack. The goal is a reusable memory layer that any product can plug into — with no external databases, no Kubernetes, and no multi-vendor infra to manage.

Every Cloudflare primitive earns its place by solving a specific problem that the reference systems struggled with.

---

## Service Map

The system is six Workers plus the storage primitives they orchestrate.

| Worker            | Reachable via            | Role                                                                                                      |
| ----------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| **memory-api**    | HTTPS (public)           | Gateway — auth, validation, idempotency; routes to ingestion/retrieval; hosts `/v1/*` and `/admin/*`      |
| **ingestion**     | Service binding only     | Durable 6-step Workflow: parse → extract → embed → policy → reconcile → persist                           |
| **retrieval**     | Service binding only     | Hybrid search: D1 FTS5 + Vectorize fan-out → RRF fusion → cross-encoder rerank                            |
| **data**          | RPC only (`DataService`) | The data access layer — the ONLY worker with storage bindings (D1, Vectorize, KV, R2, Workers AI)         |
| **consolidation** | Queue + cron only        | Background jobs: profile consolidation, expiry sweep, confidence decay, conflict resolution, async purges |
| **management**    | HTTPS (admin)            | Product onboarding/decommissioning, fleet schema migrations — provisions via the Cloudflare REST API      |

Supporting components, all owned by the data worker or shared packages:

| Component               | Primitive                                  | Role                                                                                              |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Memory Store**        | D1 (with FTS5) — one per product           | Structured records, scoping, lifecycle states, provenance, keyword index                          |
| **Semantic Index**      | Vectorize — one per product                | Vector embeddings for similarity search, metadata-filtered by scope                               |
| **Policy Engine**       | `@deeprecall/policy` (pure module)         | Deterministic rule layer between LLM extraction and storage                                       |
| **Embeddings + Rerank** | Workers AI (`bge-m3`, `bge-reranker-base`) | 1024-dim embeddings; cross-encoder reranking of the fused pool                                    |
| **LLM Provider**        | Vercel AI SDK + Anthropic/Bedrock          | Extraction, reconciliation, profile consolidation (`claude-sonnet-5` default)                     |
| **Database Router**     | data worker (`DataService`)                | Maps product identity to the right `DB_<slug>` / `VEC_<slug>` binding                             |
| **Audit Log**           | D1 (append-only table) — per product       | Full mutation history — every add, update, supersede, expire, delete                              |
| **Config Store**        | KV                                         | Product registry, hashed API-key index, extraction templates, policy overrides                    |
| **Document Store**      | R2                                         | Uploaded source documents (PDFs, text, transcripts); D1 `documents` table holds metadata + R2 key |
| **Observability**       | Console + Axiom                            | Structured logging with trace-id correlation across all six workers                               |

### Trust boundaries

Only memory-api and management accept HTTP. The other four workers set `workers_dev: false` / `preview_urls: false` — they have no public URL and are reachable only through service bindings, RPC, queues, and cron. Two auth layers sit on top:

- **Product API keys** (`X-API-Key`) are stored **hashed** — KV holds `apikey:<sha256(key)>` → product id; auth is a single O(1) lookup. Keys are shown once at onboard/rotate and never persisted in plaintext.
- **Internal service calls** from memory-api to ingestion/retrieval carry an `X-Internal-Key` shared secret; both targets verify it with a constant-time compare before any work and **fail closed** (500 if the secret is unset, 401 on mismatch). This protects against a config regression ever re-exposing the internal workers.
- **Admin endpoints** (`/admin/*` on memory-api and management) require a separate `ADMIN_KEY` worker secret via the `X-Admin-Key` header.

---

## Multi-Tenancy Strategy: D1-per-Product

Since this system serves multiple products, the single most important infrastructure decision is how to handle multi-tenancy at the data layer.

### The Decision: One D1 Database per Product

Each product that onboards gets its own dedicated D1 database (and its own Vectorize index). The **Database Router** inside the data worker resolves product identity to the correct D1 binding and Vectorize index on every request — by naming convention, accessing `env["DB_<product_id>"]` / `env["VEC_<product_id>"]` at runtime with no lookup on the hot path. (The KV product registry records each product's binding names and config for the workers upstream — auth resolution, onboarding bookkeeping — not for the router itself.)

### Why Per-Product Isolation (Not a Shared Database)

- **Storage headroom.** D1 caps at 10GB per database. A shared database means all products compete for that 10GB — one high-volume product could crowd out others. Per-product gives each the full 10GB.
- **Blast radius.** A runaway ingestion bug in one product can't fill the database or degrade queries for another.
- **Independent lifecycle.** Each product can have different retention policies, expiry schedules, and schema migration rollout timing. You can upgrade Product A's schema while Product B waits.
- **Compliance isolation.** A medical assistant with strict PII rules gets a physically separate database from a coding assistant. Simplifies audits and data deletion.
- **Performance.** FTS5 indexes and query plans stay scoped to one product's data volume. No need for `WHERE product_id = ?` on every query — it's implicit from the database choice.

### How It Works

```
Request arrives (product identity resolved from the API key)
        |
        v
  ┌──────────────────────┐
  │   Database Router     │
  │   (data worker,       │
  │    DataService RPC)   │
  │                       │
  │  binding-name         │
  │  convention:          │
  │    -> DB_<product_id> │
  │    -> VEC_<product_id>│
  └──────────┬───────────┘
             |
     ┌───────┴───────┐
     v               v
  D1: product_a    D1: product_b
  Vec: product_a   Vec: product_b
```

When a new product onboards, the **management worker** provisions a new D1 database over the Cloudflare REST API, applies the schema, creates a Vectorize index, generates an API key (returned once), registers everything in KV, and emits the `wrangler.jsonc` binding snippet to add to the data worker before redeploying it. See [ONBOARDING.md](./ONBOARDING.md).

### Tradeoffs and Mitigations

**Schema migrations across databases.** The management worker reads pending migration steps from `@deeprecall/db` (the single schema source of truth), iterates over all registered product databases, and applies them (`POST /admin/migrations/migrate-all`). Each database tracks its own `schema_version` in a metadata table.

**Cross-product queries** (e.g., "what does this user prefer across all our products?"). Rare, but solvable by fan-out: query each relevant product's D1 in parallel and merge. Workers handle concurrent subrequests efficiently, so this adds latency proportional to the slowest database, not the sum.

**Operational overhead.** D1 is serverless — no instances, no connection pools. Adding a database is an API call. The overhead is purely the routing lookup.

### Why D1 Over Postgres (Supabase)

D1 is co-located with Workers — queries have zero network hop. Supabase (Postgres) is more powerful (richer SQL, better full-text search, pgvector, no 10GB ceiling), but every query adds a network round-trip to an external database. For a memory system where retrieval is the hot path (called on every agent turn), that latency difference matters.

The decision: **start with D1 for latency, design for portability to Postgres.**

### Data-Layer Portability Rule

All database access goes through repository interfaces in `@deeprecall/db`; all vector access goes through `@deeprecall/vectorize`. Business logic and API layers import interfaces, never D1/Vectorize types or raw SQL. Swapping D1 for Supabase (or any other store) requires only:

1. **New repository implementations** — same interfaces, Postgres SQL instead of SQLite SQL
2. **New migrations** — rewritten for Postgres syntax
3. **FTS5 → Postgres full-text search** — the hardest part; `tsvector`/`tsquery` replaces FTS5, `ts_rank` replaces BM25
4. **Optionally: Vectorize → pgvector** — if consolidating vector search into Postgres too

Everything above the data layer (API routes, business logic, policy engine, AI layer, logger) stays untouched.

**Enforcement rule:** Never import D1/Vectorize types or write SQL outside `@deeprecall/db`, `@deeprecall/vectorize`, and the data worker. If this discipline holds, the migration surface is two packages.

### When to Reconsider

If a single product exceeds 10GB of memory data, if D1's SQLite limitations block a feature, or if you need complex cross-product joins as a core feature, that product could migrate its storage backend to Postgres while the rest stay on D1 — the portability rule makes this a per-product decision.

### Scoping Within a Product

Product identity is structural — it comes from which D1 database the request hits, which is resolved from the API key. **`product_id` is never part of a request body.** Inside a product, every memory has a three-column scope: `(user_id?, agent_id?, session_id?)`. The `Scope` type on the wire is the same shape with a Zod refine: **at least one of `user_id` or `agent_id` must be present** (`session_id` alone is not enough). Vectorize metadata mirrors this — when a scope field is absent we omit the key rather than writing `null`, because Vectorize filters don't match against null values reliably.

This gives three first-class scope shapes:

| Shape        | `user_id` | `agent_id` | Meaning                                          |
| ------------ | --------- | ---------- | ------------------------------------------------ |
| User-only    | set       | null       | Traditional per-user memory                      |
| Agent-only   | null      | set        | Shared agent knowledge not bound to any end user |
| User + agent | set       | set        | A specific user talking to a specific agent      |

The agent-only shape is the reason scope keys are nullable. It lets a product keep a standalone-agent knowledge base (playbooks, defaults, operational notes) that surfaces for every user who chats with that agent.

**Three match rules apply to different operations:**

- **Relaxed match** — used by retrieval, `GET /v1/memories`, search, `/admin/memories/dump`, `/admin/audit/recent`. For each scope key K the caller provides, `memory[K] === caller[K] OR memory[K] IS NULL`. Null on the memory means "applies to everyone on that dimension." This is how a user-scoped query still surfaces agent-only shared memories.
- **Strict match** — used by rate-limit counting, purges, and the per-scope fact selection that feeds profile consolidation. Exact equality on provided keys; null on the memory does **not** match. Strict is used anywhere ambiguity would be destructive (you don't want `purge(user_id='dana')` to also delete every agent-only memory with `user_id IS NULL`).
- **Authorization match** — used by `POST /v1/correct` and `GET /v1/inspect/:memory_id`. Strict equality **plus** at least one positive match on a non-null memory field. Non-contradiction alone is not enough — the caller must prove ownership of at least one scope field. On scope mismatch these endpoints return **403** (not 404): memory ids are random UUIDs, so existence-probing is infeasible and a clear 403 is more useful to legitimate callers.

**Profile consolidation is disjoint.** User-scoped profiles and agent-only profiles consolidate into separate memory pools. Agent-with-user memories (both set) roll up under the user profile. Standalone-agent memories (`user_id IS NULL`, `agent_id` set) roll up under an agent profile. The explicit tradeoff: a product that only uses agents-bound-to-users does not get a "pure" agent profile — its agent memories are partitioned by user. A product that ingests standalone-agent content gets a proper per-agent profile that all its users can see.

---

## Worker Details

### memory-api (gateway)

The single public entry point. URL-versioned REST API:

**Public endpoints (product API key):**

- `POST /v1/ingest` — submit content for memory extraction; optional `idempotency-key` header
- `POST /v1/query` — hybrid retrieval for a scope + mode
- `POST /v1/answer` — retrieval plus a single LLM call synthesizing a citation-backed answer (the only public endpoint that invokes an LLM synchronously; the query hot path stays LLM-free)
- `POST /v1/correct` — user-initiated correction (suppress, expire, delete, pin, update)
- `GET /v1/inspect/:memory_id` — full record with provenance, audit trail, supersede chain
- `GET /v1/memories` — list with scope/status/type filters, `since` timestamp, cursor pagination
- `POST /v1/memories/purge`, `/v1/memories/purge-all`, `GET /v1/memories/purge/status/:job_id` — async scoped/product-wide deletion with pollable job status
- `POST /v1/documents`, `GET /v1/documents`, `GET|PUT|DELETE /v1/documents/:id`, `GET /v1/documents/:id/content`, `POST /v1/documents/purge`, `GET /v1/documents/purge/status/:job_id` — document CRUD + async purge with pollable job status
- `GET /v1/health` — unauthenticated health check

**Admin endpoints (`X-Admin-Key`)** cover memory dump/purge, pipeline test-extract/test-reconcile, audit inspection, dead letters, and consolidation triggers — see [ADMIN_GUIDE.md](./ADMIN_GUIDE.md).

**Idempotency:** ingest accepts an `idempotency-key`; keys are product-scoped, stored in D1 with a 24h TTL, and only 2xx responses are cached. Duplicate keys return the original response without re-processing.

**Responsibilities:** authentication, validation, idempotency, routing. Thin layer — business logic lives in `src/` service modules (documents, corrections, answer), not in routes.

### ingestion (pipeline)

The heart of the system — a durable Cloudflare Workflow that converts raw content into structured memory.

**Input channels, unified after Step 1:**

- **Chat:** conversation turns via `POST /v1/ingest`. The calling product decides when and how to batch turns.
- **Documents:** a file uploaded via `POST /v1/documents` goes to R2 and gets a `documents` row in D1; memory-api's documents service chunks the text (paragraph-first with sentence-boundary fallback, ~8000-char windows with overlap) and dispatches one pipeline run per chunk with `document_id` preserved.
- **Structured data:** pre-structured facts with `source_channel = 'api'` bypass LLM extraction but still pass policy and reconciliation.

**Pipeline steps:**

```
Step 1: Parse & Classify
   → Determine source channel, classify scene type
   → Select extraction template from KV (template:<product>:<scene_type>)

Step 2: Extract (LLM via Vercel AI SDK — claude-sonnet-5 default)
   → Structured output: candidate MemCells (content, type, source_actor,
     source_type, confidence, validity window, tags, entity triple)

Step 3: Embed (Workers AI bge-m3, via the data worker)
   → 1024-dim embeddings for each candidate, batched

Step 4: Policy Check (deterministic, no LLM)
   → PII rules, confidence thresholds, rate limits, auto-expiry tagging

Step 5: Reconcile (LLM-assisted comparison)
   → Query existing memories in the same scope (hybrid search fan-out)
   → Decision per candidate: ADD / SUPERSEDE / MERGE / SKIP
   → Pinned memories (user_stated, confidence 1.0) are never auto-superseded

Step 6: Persist
   → D1 write, Vectorize upsert, audit log append (create-before-supersede
     FK ordering), consolidation message enqueued
```

**Why Workflows:** each step is durable — if the LLM call in Step 2 fails, it retries without re-running Step 1. If the worker restarts mid-pipeline, it resumes from the last successful step. Critical for a pipeline with multiple LLM calls and writes.

### retrieval (hybrid search)

```
Input: query text + scope + mode (product identity from the API key)

1. Fan out (parallel):
   a. D1 FTS5 → ranked keyword matches (BM25)
   b. Vectorize → ranked semantic matches (cosine), scope-filtered via metadata
   (a relaxed-scope query fans out over the matching filter variants and
    unions best-per-memory scores)

2. RRF fusion:  score(d) = Σ 1/(k + rank_i(d)), k = 60
   → merges the two arms' incomparable score scales

3. Cross-encoder rerank (Workers AI bge-reranker-base) over the fused pool,
   then cut to top_k

4. Post-filter: drop expired foresight and suppressed memories; ghost-vector
   defense (a Vectorize hit with no D1 row is discarded)

5. Return ranked memories with scores and provenance
```

**Retrieval modes:**

- `recall` (default) — relevant facts for this turn
- `full_briefing` — profile memories + active foresight prepended to relevant facts; for conversation starts and handoffs
- `profile` — just the consolidated profile; skips embedding entirely
- `foresight` — _not yet implemented; currently falls through to plain hybrid search_

**Why a separate worker:** hybrid search is its own subsystem — pool widths, fusion, and rerank windows are tuned independently of the gateway — and a service binding keeps it zero-hop from memory-api. (Ingestion's reconciliation step runs its own scope-filtered vector search directly through the data worker rather than through this worker.)

### data (data access layer)

A `WorkerEntrypoint` (`DataService`) exposing ~50 RPC methods over the storage primitives: memory CRUD and scope queries, FTS search, vector upsert/query/delete, document records + R2 blobs, audit log, idempotency keys, dead letters, embeddings, and reranking. Every other worker binds to it; **no other worker has a storage binding**. This is what makes the portability rule enforceable — and what makes the rest of the fleet deployable without touching resource IDs.

### consolidation (background jobs)

Queue consumer + cron. Jobs:

- **Profile consolidation** — clusters high-confidence facts per scope and synthesizes/updates a profile-type memory (LLM-assisted); user-scoped and agent-only pools are disjoint.
- **Expiry sweep** — marks foresight past `validity_end` as expired; cleans expired idempotency keys. Daily (`0 3 * * *`).
- **Confidence decay** — reduces confidence of unreinforced memories; archives below the floor and deletes their vectors. Daily.
- **Conflict resolution** — detects contradictory active memories (semantic similarity ≥ 0.85) and auto-resolves per policy: user_stated > agent_inferred > higher confidence > more recent; pinned memories skipped.
- **Weekly profile rebuild** — full pass over active users and agents (`0 4 * * SUN`).
- **Async purges** — scoped/product-wide memory and document purges dispatched from the public purge endpoints, with job status in KV.

**Dead letters:** after 3 retries a failed message is written to the `dead_letters` table with payload, error, and attempt count; invalid payloads that fail Zod validation dead-letter immediately. Admin endpoints list and reprocess them.

### management (provisioning)

Onboards products (provision D1 + Vectorize over the Cloudflare REST API, apply schema, generate API key, register in KV, emit the data-worker binding snippet), decommissions them (delete all resources + KV entries), rotates API keys, and runs fleet-wide schema migrations. The canonical schema and migration steps come from `@deeprecall/db` — the management worker contains no SQL of its own.

---

## Memory Store Schema (D1, per product)

```sql
-- Primary memory records
memories (
  id              TEXT PRIMARY KEY,
  content         TEXT NOT NULL,
  episode         TEXT,              -- narrative summary (from MemCell)
  type            TEXT NOT NULL,     -- 'fact' | 'episode' | 'foresight' | 'profile'
  status          TEXT NOT NULL,     -- 'active' | 'superseded' | 'expired' | 'archived' | 'suppressed'

  -- Scoping (product_id is implicit — each product has its own DB)
  user_id         TEXT,
  agent_id        TEXT,
  session_id      TEXT,

  -- Provenance
  source_actor    TEXT NOT NULL,
  source_type     TEXT NOT NULL,     -- 'user_stated' | 'agent_inferred' | 'system_imported' | 'document_extracted' | 'api_ingested'
  source_channel  TEXT,              -- 'chat' | 'document' | 'api' | 'research' | 'manual'
  confidence      REAL DEFAULT 0.5,

  -- Document reference (for memories extracted from uploaded files)
  document_id     TEXT,

  -- Lifecycle
  validity_start  TEXT,
  validity_end    TEXT,              -- null = permanent
  observed_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  superseded_by   TEXT REFERENCES memories(id),

  tags            TEXT,              -- JSON array
  subject         TEXT,              -- entity triple (graph roadmap)
  predicate       TEXT,
  object          TEXT
)

-- Source documents stored in R2 (metadata + R2 key; blobs live in R2)
documents (
  id, r2_key, filename, mime_type, size_bytes,
  file_type,          -- closed set, server-derived from MIME
  document_type,      -- free-form classification tag from the product
  description,
  user_id, agent_id, session_id,   -- the scope the upload targeted
  uploaded_at, metadata
)

-- Full-text search index (lowercase fts5 — D1 requirement), trigger-synced
memories_fts USING fts5 (content, episode, subject, object)

-- Append-only audit log
memory_audit (id, memory_id, action, reason, old_value, new_value, triggered_by, created_at)

-- Schema version tracking for migrations
db_metadata (key, value)

-- Idempotency keys (TTL-managed, cleaned by the daily sweep)
idempotency_keys (key, response, created_at, expires_at)

-- Failed queue messages after max retries
dead_letters (id, queue_name, payload, error, attempts, first_failed_at, last_failed_at)
```

The authoritative DDL is `packages/db/src/migrations/0001_initial_schema.sql`; a byte-identity test pins the copy the management worker applies during onboarding.

**Why D1 (per product):**

- FTS5 gives BM25-ranked keyword search — the keyword half of hybrid retrieval, without Elasticsearch.
- Per-product isolation means scoping is structural, not per-query.
- The audit log is just an append-only table — simple, queryable, no extra infra.
- The entity-triple columns are ready for graph support (roadmap).

---

## Semantic Index (Vectorize, per product)

- **Dimensions:** 1024 (matching `bge-m3`) · **Metric:** cosine
- **Metadata indexes (all six required):** `user_id`, `agent_id`, `type`, `status`, `source_type` (string), `confidence` (number). Vectorize silently ignores filters on unindexed properties — creating these is a deploy-time step, see [DEPLOYMENT.md](./DEPLOYMENT.md).
- **Null-omit rule:** when a scope key is absent on a memory, the metadata key is **omitted** — never written as `null`. Vectorize filters don't match null values reliably; key absence is what makes relaxed-match scoping work.
- Each vector's metadata stores `memory_id` as the join key back to D1. `product_id` is unnecessary — each product has its own index.

---

## Configuration Store (KV)

Read-often/write-rarely config; eventual consistency (~60s propagation) is fine here.

```
apikey:<sha256(key)>                → product_id          (hashed auth index — O(1) lookup)
product:<product_id>:api_key_hash  → sha256 of the active key (bookkeeping, not a secret)
product:<product_id>:db_binding    → D1 binding name (e.g. "DB_default")
product:<product_id>:vec_binding   → Vectorize binding name (e.g. "VEC_default")
product:<product_id>:config        → JSON: { name, policyOverrides, features, ... }
product:<product_id>:policy_overrides → per-product policy rule overrides
template:<product_id>:<scene_type> → extraction prompt template text
purge_job:<product_id>:<job_id>    → async purge job status (24h TTL)
```

Product API keys are never stored in plaintext. The admin key is a **worker secret** (`ADMIN_KEY`), not a KV entry.

---

## LLM Provider (Vercel AI SDK)

All LLM calls (extraction, reconciliation, conflict adjudication, profile consolidation, `/v1/answer`) go through the Vercel AI SDK. Embeddings are separate — they use Workers AI directly.

- **Default model:** `claude-sonnet-5` (set per call-site in `packages/ai`, overridable per product).
- **Runtime seam:** `createClaudeModel` in `packages/ai/src/claude.ts` serves the same first-party model ids through either the **Anthropic API** or **AWS Bedrock** (geo inference profiles, `us.anthropic.*`), selected by the `ANTHROPIC_PROVIDER` env var (default: `bedrock`). `BEDROCK_MODEL_OVERRIDES` can pin exact Bedrock ids without a code change.
- **`/v1/answer` is provider-agnostic:** `resolveModel("<anthropic|openai|google>:<model-id>")` lets a product's answer model be swapped via KV config or the `ANSWER_MODEL` var — no redeploy.
- **Why the AI SDK:** provider-agnostic interface, native structured output (typed MemCell extraction), TypeScript-native on Workers.

---

## Observability

A static `Logger` (`@deeprecall/logger`) writes structured JSON to the console (visible in the Cloudflare dashboard and `wrangler tail`) and, when `AXIOM_API_TOKEN`/`AXIOM_DATASET` are set, ships the same entries to Axiom for retention, querying, and alerting. Axiom is optional — without credentials the logger is console-only.

- Every entry carries `service`, `step`, `product_id`, `user_id`, `trace_id`, `duration_ms`, `level`.
- The `trace_id` propagates memory-api → ingestion → retrieval via the `x-trace-id` header, so one ingest request is traceable across workers.
- Sensitive data (memory content, PII) is never logged — only IDs, types, and operational metadata.

---

## Full Data Flow: Content → Memory

```
┌──────────────┐
│  Product App │  (coding assistant, support bot, …)
│ content+scope│
└──────┬───────┘
       │ X-API-Key
       ▼
┌──────────────┐     ┌────────────┐
│  memory-api  │────▶│  KV Config │  (hashed-key auth, idempotency, product config)
│  /v1/ingest  │     └────────────┘
└──────┬───────┘
       │ X-Internal-Key (service binding)
       ▼
┌──────────────────────────────────────────────────────────┐
│            ingestion worker — Workflow                    │
│                                                           │
│  1 Parse&Classify → 2 Extract (LLM) → 3 Embed (bge-m3)    │
│           → 4 Policy → 5 Reconcile (LLM) → 6 Persist      │
└──────────────────────────┬────────────────────────────────┘
                           │ DataService RPC
                           ▼
                    ┌─────────────┐
                    │ data worker  │
                    └──┬────┬───┬──┘
                       ▼    ▼   ▼
                   ┌────┐ ┌─────────┐ ┌──────────┐
                   │ D1 │ │Vectorize│ │ D1 audit │
                   │FTS5│ │         │ │   log    │
                   └────┘ └─────────┘ └──────────┘
       │
       ▼ (after persist)
┌──────────────┐      ┌──────────────────┐
│    Queue     │─────▶│  consolidation    │  profile rebuild, expiry sweep,
│   message    │      │     worker        │  decay, conflicts, purges
└──────────────┘      └──────────────────┘
```

Retrieval (`/v1/query`) follows the same shape through the retrieval worker: embed query → FTS5 + Vectorize fan-out → RRF → rerank → post-filter → ranked memories. `/v1/correct` supersedes in place: mark old superseded, create replacement, re-embed, audit both.

---

## Cloudflare Constraints & Gotchas

- **D1 FTS5:** must use lowercase `fts5` when creating virtual tables — D1 is case-sensitive here, unlike standard SQLite. D1 databases with virtual tables can't be exported directly.
- **Workflows:** step timeouts and retry policies apply per step; the 6-step pipeline is well within platform limits.
- **Vectorize:** max 10 metadata indexes per index (we use 6). TopK capped at 100 (50 when returning metadata). String metadata filters compare the first 64 bytes only. **No local simulator** — local dev and tests stub or skip Vectorize (see DEPLOYMENT.md).
- **Workers AI:** no local simulator either, and no guaranteed latency SLA — the pipeline tolerates spikes via Workflow step retries.
- **Wrangler:** always deploy with `--env dev|production`; a bare deploy creates a stray top-level worker. Metadata indexes must exist before vectors are inserted for filters to apply to them.

---

## Current Scope vs. Roadmap

### Current scope (implemented)

- Memory API with URL-versioned endpoints, idempotency, hashed API keys, admin surface
- 6-step ingestion Workflow (Vercel AI SDK + `claude-sonnet-5`, Anthropic API or Bedrock)
- Policy engine: PII filtering, confidence thresholds, rate limits, auto-expiry
- D1 memory store with FTS5; append-only audit log; per-product isolation
- Vectorize semantic index with scope metadata filtering
- Hybrid retrieval: RRF fusion + cross-encoder reranking; recall/full_briefing/profile modes
- `/v1/answer` grounded answering with citation validation, cross-provider model resolution
- Document ingestion: R2 storage, PDF/text extraction, chunking, full CRUD + cascading deletes
- User-facing purge flows (scoped and product-wide, async with job status) — data deletion cascades through D1, Vectorize, and R2
- Consolidation jobs: profile synthesis, expiry sweep, confidence decay, conflict resolution, dead letters
- Management API: onboarding, decommissioning, key rotation, fleet migrations
- Structured logging with cross-worker trace correlation (console + optional Axiom)

### Roadmap

- **Session Coordinator (Durable Object):** optional managed buffering/dedup for chat products — deferred because the stateless API keeps the system product-agnostic; products batch turns themselves.
- **`foresight` retrieval mode:** dedicated handling (currently falls through to hybrid search).
- **Request-level rate limiting** at the gateway, ahead of paid LLM steps.
- **Retrieval caching** (Workers Cache API or KV with TTL).
- **Graph memory:** entity-relationship queries over the existing subject/predicate/object columns.
- **Cross-product memory sharing** (with user consent), memory importance ranking, real-time push, analytics dashboard, memory inspector UI.
