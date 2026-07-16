# Security Policy

Deep Recall stores user memories — content that routinely includes personal information. Tenant isolation, scope authorization, and data-deletion guarantees are core security properties of this system, and we treat reports against them with priority.

## Reporting a vulnerability

**Please do not open a public issue or pull request for security problems.**

Report vulnerabilities privately via **GitHub's private vulnerability reporting** ("Security" tab → "Report a vulnerability" on this repository). You'll get an acknowledgment within a few days, and we'll keep you informed as we triage, fix, and disclose.

## Scope

Reports we especially want:

- **Tenant isolation breaks** — any way for one product's API key to read or write another product's memories, documents, or vectors.
- **Scope authorization bypasses** — accessing memories outside the caller's `(user_id, agent_id, session_id)` authority, e.g. via `/v1/inspect`, `/v1/correct`, or retrieval filters.
- **Auth weaknesses** — API-key or admin-key bypass, internal service-binding auth (`X-Internal-Key`) bypass, exposure of workers that should not be internet-reachable.
- **Data-deletion failures** — purge/correction flows that leave memories, vectors, audit rows, or R2 blobs behind when they claim to delete them.
- **Injection** — SQL/FTS5 injection through query text, prompt-injection paths that lead to unauthorized writes or exfiltration.
- **Sensitive-data leaks** — memory content or PII in error responses or logs.

Out of scope: vulnerabilities in Cloudflare's platform itself (report to Cloudflare), denial-of-service by volume alone, and issues requiring an already-compromised admin key.

## Supported versions

Security fixes land on `main`. There are no maintained release branches; deployments should track `main`.
