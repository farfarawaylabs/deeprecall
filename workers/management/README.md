# management

Product lifecycle operations, isolated from the request hot path. Onboards products (provisions D1 + Vectorize with all six metadata indexes over the Cloudflare REST API, applies the canonical schema from `@deeprecall/db`, generates a show-once API key, registers everything in KV, emits the data-worker binding snippet), decommissions them, rotates keys, and runs fleet-wide schema migrations. Admin-only HTTP surface — every route requires `X-Admin-Key`.

## Bindings

- **Upstream of:** `DATA` (RPC), plus direct `api.cloudflare.com` REST calls for provisioning
- **Storage:** `CONFIG` (KV — product registry, key index)

## Secrets

| Secret                                           | Notes                                                           |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `ADMIN_KEY`                                      | Required; shared with memory-api (`scripts/setup-admin-key.sh`) |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Required; token needs **D1 edit + Vectorize edit** only         |
| `AXIOM_API_TOKEN`                                | Optional — log shipping                                         |

## Deploy

```bash
pnpm deploy:dev:management    # or: wrangler deploy --env dev|production
```

Deploys last (see [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)).

> ⚠️ `worker-configuration.d.ts` in this worker is **hand-maintained** — do not regenerate it with `wrangler types`.
