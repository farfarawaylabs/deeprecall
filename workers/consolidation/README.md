# consolidation

Background memory maintenance, driven by the consolidation queue and cron. Jobs: profile consolidation (LLM synthesis of high-confidence facts), expiry sweep, confidence decay, conflict resolution, and the async purge flows (scoped/product-wide memory and document deletion with KV-backed job status). Failed messages dead-letter to D1 after 3 retries. Internal-only: no public URL (`workers_dev: false`); queue and cron are the only routed entry points.

## Bindings

- **Downstream of:** the `deeprecall-consolidation-queue-<env>` queue (consumer; produced to by ingestion and memory-api) and two cron triggers: `0 3 * * *` (daily expiry/decay/cleanup) and `0 4 * * SUN` (weekly profile rebuild)
- **Upstream of:** `DATA` (RPC — all reads/writes/vector deletes)
- **Storage:** `CONFIG` (KV — per-product config, purge job status)

## Secrets

| Secret                                        | Notes                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | LLM jobs (profile consolidation, conflict resolution) via Bedrock (or `ANTHROPIC_API_KEY`) |
| `AXIOM_API_TOKEN`                             | Optional — log shipping                                                                    |

## Deploy

```bash
pnpm deploy:dev:consolidation    # or: wrangler deploy --env dev|production
```

The queue must exist before deploying (see [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)).
