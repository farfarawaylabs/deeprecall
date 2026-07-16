# retrieval

Hybrid memory search: D1 FTS5 (BM25) and Vectorize (cosine) fan out in parallel, merge via Reciprocal Rank Fusion (k=60), then a cross-encoder reranker (`bge-reranker-base`) orders the fused pool before the `top_k` cut. Serves `/v1/query` and the retrieval half of `/v1/answer`. Internal-only: `workers_dev: false`, callers must present `X-Internal-Key` (verified fail-closed).

## Bindings

- **Downstream of:** memory-api (service binding)
- **Upstream of:** `DATA` (RPC — FTS queries, vector search, embeddings, rerank, memory hydration)

## Secrets

| Secret                 | Notes                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| `INTERNAL_SERVICE_KEY` | Required; same value memory-api holds (and ingestion, for its own verification) |
| `AXIOM_API_TOKEN`      | Optional — log shipping                                                         |

No LLM credentials — the query path is LLM-free by design.

## Deploy

```bash
pnpm deploy:dev:retrieval    # or: wrangler deploy --env dev|production
```

Deploys **after** data, **before** ingestion and memory-api (see [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)).
