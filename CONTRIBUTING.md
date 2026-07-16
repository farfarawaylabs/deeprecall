# Contributing to Deep Recall

## Setup

```bash
pnpm install          # Node 22+, pnpm 10 (corepack enable picks up the pinned version)
```

Everything needed for development runs locally — no Cloudflare account, no secrets, no `.dev.vars`:

```bash
npx turbo build typecheck lint test   # the full gate, same as CI
npx prettier --check .                # formatting (docs included)
```

CI runs exactly these two commands on every PR. Run them before pushing.

## Project rules

These are the invariants the codebase is built around. PRs that break them will be asked to change.

### Data-layer portability

D1 and Vectorize types, and raw SQL, live **only** in `@deeprecall/db`, `@deeprecall/vectorize`, and the data worker. Everything else imports repository/index interfaces. The data worker is the only worker with storage bindings; all other workers reach storage through its `DataService` RPC interface. This is what keeps "swap D1 for Postgres" a two-package change — see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

### Three-tier worker structure

Route handlers are thin: **validate → business logic → format**. Business logic lives in `src/` service modules (e.g. `workers/memory-api/src/documents/`, `workers/management/src/provisioning/`), not in route files. Typed request-error classes (e.g. `DocumentRequestError`, `ManagementRequestError`) carry status/code from the business layer to the route.

### Error envelopes

Every error response goes through `@deeprecall/http` — `apiError` (Hono) or `errorResponse` (raw fetch handlers). Don't hand-roll `{ error: { ... } }` literals. Public error messages must be generic: no stack traces, no internals, no memory content.

### Schema changes

`packages/db/src/migrations/` is the source of truth. The `INITIAL_SCHEMA_SQL` constant in `packages/db/src/schema.ts` must stay byte-identical to `0001_initial_schema.sql` (a test enforces this — it's what the management worker applies when onboarding). New migrations start at `0002` / schema_version 5 and need a matching entry in the `MIGRATION_STEPS` map.

### Deploy discipline

Always `wrangler deploy --env dev|production` (or the root `pnpm deploy:*` scripts) — a bare deploy creates a stray top-level worker. Deploy order follows the service-binding graph: `data → retrieval → ingestion → memory-api → consolidation → management`.

### Do not hand-edit or regenerate

`workers/management/worker-configuration.d.ts` is hand-maintained — do not regenerate it with `wrangler types`.

## Tests

- Vitest 4 with `@cloudflare/vitest-pool-workers` — tests run against real local D1/KV/R2 in workerd, entirely offline. Vectorize and Workers AI have no local simulator; those facades are covered with stub bindings.
- **Storage isolation is per test FILE, not per test.** Seed and clean accordingly (see `packages/db`'s setup for the wipe-tables pattern).
- Global vitest `setupFiles` break `vi.mock` under the workers pool — import migration/wipe helpers directly in the test files that need them.
- New behavior needs tests; bug fixes should pin the bug (a test that fails before the fix).
- Vitest configs pin empty cloud credentials so tests can never hit live Cloudflare or LLM APIs — keep it that way when adding suites.

## Pull requests

1. Branch from `main`, keep PRs focused on one concern.
2. Run the full gate (above) — CI is required.
3. Update docs that your change invalidates (`docs/API_GUIDE.md` and the Postman collection for API changes).
4. For security-sensitive findings, **do not open a PR or issue** — see [SECURITY.md](./SECURITY.md).
