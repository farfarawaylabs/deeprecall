# memory-api

The public gateway — the only worker products talk to. Hosts the `/v1/*` API (ingest, query, answer, correct, inspect, memories, documents, purges) and the `/admin/*` surface. Validates requests, resolves the product from the hashed API-key index in KV, enforces idempotency, and routes work downstream. Business logic lives in `src/` service modules (documents, corrections, answer); routes stay validate → logic → format.

## Bindings

- **Upstream of:** `INGESTION` and `RETRIEVAL` (service bindings, authenticated with `X-Internal-Key`), `DATA` (RPC to `DataService`), `CONSOLIDATION_QUEUE` (producer, for admin triggers and purge jobs)
- **Storage:** `CONFIG` (KV — auth index, product registry, templates)

## Secrets

| Secret                                        | Notes                                                           |
| --------------------------------------------- | --------------------------------------------------------------- |
| `INTERNAL_SERVICE_KEY`                        | Required; identical on ingestion + retrieval                    |
| `ADMIN_KEY`                                   | Required; `X-Admin-Key` for `/admin/*`                          |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | For `/v1/answer` via Bedrock (or `ANTHROPIC_API_KEY` if direct) |
| `OPENAI_API_KEY`, `GOOGLE_API_KEY`            | Optional — cross-provider `/v1/answer` models                   |
| `AXIOM_API_TOKEN`                             | Optional — log shipping                                         |

## Deploy

```bash
pnpm deploy:dev:memory-api    # or: wrangler deploy --env dev|production
```

Deploys **after** data, retrieval, and ingestion (see [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)).
