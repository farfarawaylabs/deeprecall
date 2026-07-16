# ingestion

Runs the durable 6-step memory pipeline as a Cloudflare Workflow: parse & classify → extract (LLM) → embed → policy check → reconcile (LLM) → persist. Each step retries independently; a failure in reconciliation never re-runs extraction. Internal-only: `workers_dev: false`, reachable exclusively through memory-api's service binding, which must present `X-Internal-Key` (verified fail-closed before any work).

## Bindings

- **Downstream of:** memory-api (service binding)
- **Upstream of:** `DATA` (RPC — all D1/Vectorize/R2 writes and embeddings), `CONSOLIDATION_QUEUE` (producer — enqueues after persist)
- **Storage:** `CONFIG` (KV — extraction templates, policy overrides), `INGESTION_WORKFLOW` (Workflow binding to its own `IngestionWorkflow` class)

## Secrets

| Secret                                        | Notes                                                    |
| --------------------------------------------- | -------------------------------------------------------- |
| `INTERNAL_SERVICE_KEY`                        | Required; identical on memory-api + retrieval            |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | LLM calls via Bedrock (or `ANTHROPIC_API_KEY` if direct) |
| `AXIOM_API_TOKEN`                             | Optional — log shipping                                  |

## Deploy

```bash
pnpm deploy:dev:ingestion    # or: wrangler deploy --env dev|production
```

Deploys **after** data and retrieval, **before** memory-api (see [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)).
