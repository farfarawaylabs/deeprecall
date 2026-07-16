# data

The data access layer — the **only** worker with storage bindings. Exposes `DataService` (a `WorkerEntrypoint`) over RPC: memory CRUD and scope queries, FTS search, vector upsert/query/delete, document records + R2 blobs, audit log, idempotency keys, dead letters, embeddings (`bge-m3`), and reranking (`bge-reranker-base`). The Database Router lives here: it resolves a product to its `DB_<slug>` / `VEC_<slug>` bindings by naming convention on its own `env` (no KV lookup on the hot path — the KV registry serves the workers upstream), so tenant isolation is structural. No public URL (`workers_dev: false`); consumed via RPC only (an unrouted health-check `fetch` exists but is unreachable).

## Bindings

- **Downstream of:** every other worker (RPC via the `DATA` service binding)
- **Storage:** `DB_<slug>` (one D1 per product), `VEC_<slug>` (one Vectorize index per product), `CONFIG` (KV — bound but currently unused by this worker), `DOCUMENTS_BUCKET` (R2), `AI` (Workers AI)

Onboarding a new product adds a `DB_<slug>` + `VEC_<slug>` binding pair here (the management API emits the snippet) followed by a redeploy of this worker.

## Secrets

None.

## Deploy

```bash
pnpm deploy:dev:data    # or: wrangler deploy --env dev|production
```

Deploys **first** — every other worker binds to it (see [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)). D1 migrations for the default product also run from here: `pnpm db:migrate:dev|prod|local`.
