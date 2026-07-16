# Deployment Guide

How to take Deep Recall from a fresh clone to a running deployment on Cloudflare, plus how to run it locally. Every command below is runnable from the repository root.

Deep Recall is six Workers deployed as two wrangler environments (`dev` and `production`). The workers depend on each other through service bindings, so **deploy order matters** — the provided root scripts (`pnpm deploy:dev`, `pnpm deploy:prod`) already deploy in the correct order:

```
data → retrieval → ingestion → memory-api → consolidation → management
```

Only `memory-api` (the public API) and `management` (the admin/provisioning API) are reachable over HTTP. The other four have `workers_dev: false` and are reachable only via service bindings, queues, and cron.

## 1. Prerequisites

- **Cloudflare account** on the Workers Paid plan (Cloudflare Queues requires it).
- **Node.js 22+** and **pnpm 10** (`corepack enable` picks up the pinned version from `package.json`).
- **wrangler auth**: `pnpx wrangler login` (or set `CLOUDFLARE_API_TOKEN` in your shell).
- **LLM credentials** for extraction/reconciliation/consolidation — either:
  - AWS credentials with Bedrock access to Anthropic models (the default: `ANTHROPIC_PROVIDER=bedrock`), or
  - an Anthropic API key (set `ANTHROPIC_PROVIDER=anthropic`).
- Optional: an [Axiom](https://axiom.co) account for structured log retention (workers log to the Cloudflare dashboard regardless).

Install dependencies and verify the tree is healthy:

```bash
pnpm install
npx turbo build typecheck lint test
```

## 2. Create Cloudflare resources

Create the resources for the `dev` environment (repeat with the `-prod` names for production). Save every ID the commands print — they go into the wrangler configs in step 3.

```bash
# D1 database (one per product; "default" is the built-in first product)
pnpx wrangler d1 create deeprecall-db-default-dev

# Vectorize index — dimensions/metric must match the embedding model (bge-m3, 1024, cosine)
pnpx wrangler vectorize create deeprecall-vectors-default-dev --dimensions 1024 --metric cosine

# KV namespace (product registry, API-key index, extraction templates, config)
pnpx wrangler kv namespace create deeprecall-config-dev

# Queue (consolidation + purge jobs)
pnpx wrangler queues create deeprecall-consolidation-queue-dev

# R2 bucket (uploaded documents)
pnpx wrangler r2 bucket create deeprecall-documents-dev
```

### Vectorize metadata indexes (required — filters fail silently without them)

Vectorize only filters on properties that have a metadata index, and a missing index does not error — queries just return unfiltered results. Create all six **before ingesting anything**:

```bash
for prop in user_id agent_id type status source_type; do
  pnpx wrangler vectorize create-metadata-index deeprecall-vectors-default-dev \
    --property-name "$prop" --type string
done
pnpx wrangler vectorize create-metadata-index deeprecall-vectors-default-dev \
  --property-name confidence --type number
```

## 3. Fill in wrangler configs

The configs carry no `account_id` — wrangler targets the account you're logged into (`pnpx wrangler login`), or set `CLOUDFLARE_ACCOUNT_ID` in your shell if you have access to more than one. Fill in the `<PLACEHOLDER>` resource IDs:

- `workers/data/wrangler.jsonc` → the D1 `database_id` and KV namespace `id` from step 2 (`<D1_DATABASE_ID_DEV>`, `<KV_NAMESPACE_ID_DEV>`, and their `_PROD` counterparts), in both the `dev` and `production` env blocks. The data worker is the only worker with storage bindings.
- `workers/memory-api`, `workers/ingestion`, `workers/consolidation`, `workers/management` → the same KV namespace `id` placeholders (they bind the same `CONFIG` namespace).

The binding names (`DB_default`, `VEC_default`, `CONFIG`, `DOCUMENTS_BUCKET`) are code-visible — keep them as-is. Additional products get `DB_<slug>` / `VEC_<slug>` bindings emitted by the onboarding endpoint (see [ONBOARDING.md](./ONBOARDING.md)).

## 4. Deploy, then set secrets

On a first-ever deploy the workers don't exist yet, so deploy first, then set secrets — each `wrangler secret put` takes effect immediately on the live worker. Until `INTERNAL_SERVICE_KEY` is set, ingest/query requests fail closed with a 500 (by design); that window closes as soon as step 4b completes.

> On an **existing** deployment the order reverses: set new secrets before deploying config that depends on them, so the fail-closed check never fires.

### 4a. Deploy all six workers

```bash
pnpm deploy:dev        # data → retrieval → ingestion → memory-api → consolidation → management
```

Always deploy through these scripts (or `wrangler deploy --env dev|production` per worker). A bare `wrangler deploy` without `--env` targets the top-level (non-environment) worker definition, which is not what you want.

### 4b. Secrets matrix

What each worker actually reads (verified against the code):

| Secret                                          | Workers                              | Required?                                           | Purpose                                                                                       |
| ----------------------------------------------- | ------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `INTERNAL_SERVICE_KEY`                          | memory-api, ingestion, retrieval     | **Yes** — identical value on all three              | Authenticates memory-api → ingestion/retrieval service-binding calls; both verify fail-closed |
| `ADMIN_KEY`                                     | memory-api, management               | **Yes**                                             | `X-Admin-Key` auth for all `/admin/*` endpoints                                               |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`    | ingestion, memory-api, consolidation | Yes when `ANTHROPIC_PROVIDER=bedrock` (the default) | Bedrock credentials for Claude calls (`AWS_REGION` is a var in wrangler.jsonc)                |
| `ANTHROPIC_API_KEY`                             | ingestion, memory-api, consolidation | Yes when `ANTHROPIC_PROVIDER=anthropic`             | Direct Anthropic API access                                                                   |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | management                           | **Yes**                                             | Provisions D1/Vectorize for product onboarding (token needs D1 edit and Vectorize edit only)  |
| `OPENAI_API_KEY`, `GOOGLE_API_KEY`              | memory-api                           | Optional                                            | Cross-provider models for `/v1/answer` (`resolveModel`)                                       |
| `AXIOM_API_TOKEN`                               | all except data                      | Optional                                            | Ships structured logs to Axiom; without it, console-only (`AXIOM_DATASET` is a var)           |
| `AWS_SESSION_TOKEN`, `BEDROCK_MODEL_OVERRIDES`  | ingestion, memory-api, consolidation | Optional                                            | Temporary AWS creds; JSON map pinning first-party model ids to exact Bedrock ids              |

The data worker needs no secrets.

```bash
# Internal service key — one value, three workers
KEY=$(openssl rand -hex 32)
for w in memory-api ingestion retrieval; do
  printf '%s' "$KEY" | pnpx wrangler secret put INTERNAL_SERVICE_KEY --env dev \
    --config "workers/$w/wrangler.jsonc"
done

# Admin key — generates, uploads to memory-api + management, prints once
bash scripts/setup-admin-key.sh dev

# LLM credentials (default provider is Bedrock)
for w in ingestion memory-api consolidation; do
  pnpx wrangler secret put AWS_ACCESS_KEY_ID --env dev --config "workers/$w/wrangler.jsonc"
  pnpx wrangler secret put AWS_SECRET_ACCESS_KEY --env dev --config "workers/$w/wrangler.jsonc"
done

# Management provisioning credentials
pnpx wrangler secret put CLOUDFLARE_API_TOKEN --env dev --config workers/management/wrangler.jsonc
pnpx wrangler secret put CLOUDFLARE_ACCOUNT_ID --env dev --config workers/management/wrangler.jsonc
```

To use the Anthropic API instead of Bedrock, change the `ANTHROPIC_PROVIDER` var to `"anthropic"` in the wrangler.jsonc of those three workers and set `ANTHROPIC_API_KEY` on each.

## 5. Seed KV

The auth middleware, product registry, and extraction templates read from KV. Pass the namespace and database IDs from step 2 as environment variables:

```bash
KV_ID=<kv-namespace-id> D1_DATABASE_ID=<d1-database-id> bash scripts/seed-kv-dev.sh
```

This registers the `default` product, writes the hashed API-key index (`apikey:<sha256>` — keys are never stored in plaintext), and seeds the document extraction template. **It prints the product API key exactly once — save it.**

## 6. Run migrations

```bash
pnpm db:migrate:dev    # applies packages/db/src/migrations to DB_default (--remote)
```

Migrations for additionally onboarded products run through the management API instead: `POST /admin/migrations/migrate-all` (see [ADMIN_GUIDE.md](./ADMIN_GUIDE.md)).

## 7. Verify

```bash
curl "https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev/v1/health"

# End-to-end: ingest → poll query → purge, fails nonzero on any error
MEMORY_API_URL="https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev" \
API_KEY="<product api key from step 5>" \
bash scripts/smoke-e2e.sh
```

## 8. Production

Repeat steps 2–7 with the `-prod` resource names, the `production` env block in each wrangler.jsonc, and:

```bash
pnpm deploy:prod
bash scripts/setup-admin-key.sh production
KV_ID=<kv-namespace-id> D1_DATABASE_ID=<d1-database-id> bash scripts/seed-kv-prod.sh
pnpm db:migrate:prod
```

---

## Local development

Local emulation covers D1, KV, R2, Queues, and Workflows. **Vectorize and Workers AI have no local simulator**, so the full ingest → embed → query pipeline cannot run offline — use a deployed `dev` environment as the integration surface. Local dev is still useful for iterating on routes, middleware, validation, and anything covered by the test suite (which runs entirely locally: `pnpm test`).

1. Copy `.dev.vars.example` → `.dev.vars` in each of the five workers that have one (`memory-api`, `ingestion`, `retrieval`, `consolidation`, `management`) and fill in values. `.dev.vars` values override wrangler.jsonc `vars`, so to call the Anthropic API directly in local dev add `ANTHROPIC_PROVIDER=anthropic` alongside `ANTHROPIC_API_KEY`.
2. Seed local KV (fixed, deterministic keys): `bash scripts/seed-kv-local.sh`
3. Apply migrations to the local D1: `pnpm db:migrate:local`
4. Start the stack:

```bash
pnpm dev
```

**Caveat:** the root `dev` script loads only the memory-api, ingestion, and retrieval configs — not the data worker that all of them bind to. For service bindings to resolve locally, include it explicitly:

```bash
pnpx wrangler dev --env dev \
  -c workers/memory-api/wrangler.jsonc \
  -c workers/ingestion/wrangler.jsonc \
  -c workers/retrieval/wrangler.jsonc \
  -c workers/data/wrangler.jsonc
```

Single workers can be run in isolation with `pnpm dev:<worker>` (e.g. `pnpm dev:management`).

## Troubleshooting

- **`/v1/ingest` or `/v1/query` return 500 with no detail** — `INTERNAL_SERVICE_KEY` is missing or differs between memory-api and ingestion/retrieval. The internal auth check fails closed.
- **Queries return memories from the wrong user/agent** — the Vectorize metadata indexes are missing (step 2). Filters on unindexed properties are silently ignored.
- **401 on every request** — KV was never seeded (step 5), or you're sending the raw key against a namespace seeded for a different environment. Auth resolves keys via the hashed `apikey:` index in the `CONFIG` namespace.
- **`wrangler deploy` created a worker named `deeprecall-<name>` (no `-dev`/`-prod` suffix)** — you deployed without `--env`. Delete the stray worker and use the root deploy scripts.
- **Consolidation never runs** — the queue from step 2 must exist before the consolidation worker deploys; cron triggers (`0 3 * * *` daily sweep, `0 4 * * SUN` weekly profile rebuild) only attach on a successful deploy.
