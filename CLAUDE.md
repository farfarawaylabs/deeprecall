# Deep Recall — Agent Instructions

Cross-product agentic memory on Cloudflare Workers. pnpm + turbo monorepo: six workers in `workers/` (memory-api, ingestion, retrieval, data, consolidation, management) and seven shared packages in `packages/` (`@deeprecall/types|db|vectorize|ai|policy|http|logger`). Design rationale: `docs/ARCHITECTURE.md`. Contributor rules in full: `CONTRIBUTING.md`.

## Commands

```bash
pnpm install
npx turbo build typecheck lint test   # the full gate — run before finishing any task; CI runs exactly this
npx prettier --check .                # formatting gate (markdown/docs included)
```

Tests run fully offline (miniflare D1/KV/R2). Never add tests or configs that reach live Cloudflare or LLM APIs.

## Invariants — violating these will fail review

1. **Data-layer portability**: D1/Vectorize types and raw SQL exist ONLY in `@deeprecall/db`, `@deeprecall/vectorize`, and `workers/data`. Everything else uses repository interfaces and the data worker's `DataService` RPC. The data worker is the only worker with storage bindings.
2. **Three-tier workers**: routes are validate → business logic → format. Business logic lives in `src/` service modules, never in route files. Typed request-error classes carry status/code across the boundary.
3. **Error envelopes**: all error responses go through `@deeprecall/http` (`apiError` for Hono, `errorResponse` for raw fetch). Never hand-roll `{ error: { ... } }` literals. Public messages stay generic — no internals, no memory content.
4. **Schema**: `packages/db/src/migrations/` is the source of truth. `INITIAL_SCHEMA_SQL` in `packages/db/src/schema.ts` must stay byte-identical to `0001_initial_schema.sql` (a test enforces it). New migrations start at `0002` / schema_version 5 with a `MIGRATION_STEPS` entry.
5. **Deploy discipline**: always `--env dev|production` (bare `wrangler deploy` creates a stray top-level worker). Deploy order follows the binding graph: `data → retrieval → ingestion → memory-api → consolidation → management` — the root `pnpm deploy:*` scripts encode it.
6. **`workers/management/worker-configuration.d.ts` is hand-maintained** — never regenerate it with `wrangler types`.
7. **Vectorize null-omit rule**: absent scope keys are omitted from vector metadata, never written as `null` (filters can't match null). Verify D1 existence for ids returned by Vectorize before acting on them (ghost-vector defense).

## Test gotchas (vitest + @cloudflare/vitest-pool-workers)

- Storage isolation is per test FILE, not per test — seed/wipe accordingly.
- Global vitest `setupFiles` break `vi.mock` under the workers pool — import migration/wipe helpers directly in test files.
- Vectorize and Workers AI have no local simulator — cover those facades with stub bindings.
- Vitest configs pin empty cloud credentials (the pool loads `.dev.vars`); keep that when adding suites.

## Workflow

Branch from `main`; keep PRs single-concern; run the full gate before pushing; update `docs/API_GUIDE.md` and the `postman/` collection when changing any API endpoint.
