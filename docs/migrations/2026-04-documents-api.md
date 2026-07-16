# Deep Recall — Documents API migration (April 2026)

You are integrating with Deep Recall. The `/v1/documents/*` surface changed in two ways that require client code updates:

1. Document records carry first-class scope columns (`user_id` / `agent_id` / `session_id`) instead of a single `uploaded_by` string.
2. `document_type` is now a free-form optional tag, and a new server-derived `file_type` enum governs what files can be ingested.

This document tells you exactly what to change. Everything else about the API (auth, memory endpoints, query endpoints) is unchanged.

---

## 1 · Breaking: `Document` response shape

Any response containing a `Document` object — `GET /v1/documents/:id`, each item in `GET /v1/documents`, plus anywhere else the Document shape is returned — has new fields in place of `uploaded_by`.

### Before

```json
{
  "id": "doc-abc123",
  "r2_key": "default/documents/doc-abc123/x.md",
  "filename": "research-notes.md",
  "mime_type": "text/markdown",
  "size_bytes": 4096,
  "document_type": "research_doc",
  "description": "Q1 research",
  "uploaded_by": "user-001",
  "uploaded_at": "2026-04-13T12:00:00Z",
  "metadata": {}
}
```

### After

```json
{
  "id": "doc-abc123",
  "r2_key": "default/documents/doc-abc123/x.md",
  "filename": "research-notes.md",
  "mime_type": "text/markdown",
  "size_bytes": 4096,
  "file_type": "markdown",
  "document_type": "knowledge_file",
  "description": "Q1 research",
  "user_id": "user-001",
  "agent_id": null,
  "session_id": null,
  "uploaded_at": "2026-04-13T12:00:00Z",
  "metadata": {}
}
```

### Required code edits

- **Remove every read of `document.uploaded_by`.** Replace with `document.user_id`, `document.agent_id`, or `document.session_id` depending on what you actually want.
- **Stop parsing the `agent:<id>` encoding.** The server no longer writes it. Agent-only docs now have `user_id = null` and `agent_id = "<id>"` as real fields.
- **Add `document.file_type` handling** (optional — it's new; safe to ignore if your UI doesn't care about file format).
- Update any TypeScript/schema definitions of `Document` accordingly.

### Client type update (TypeScript example)

```ts
// Before
type Document = {
  id: string;
  r2_key: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  document_type: 'research_doc' | 'transcript' | 'code_snippet' | 'image' | 'report' | 'raw_export';
  description: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  metadata: Record<string, unknown> | null;
};

// After
type Document = {
  id: string;
  r2_key: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  file_type: 'pdf' | 'markdown' | 'text' | 'json' | null; // new, server-derived
  document_type: string | null; // now free-form, any string
  description: string | null;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  uploaded_at: string;
  metadata: Record<string, unknown> | null;
};
```

---

## 2 · Breaking: `GET /v1/documents` filter semantics

The `user_id` and `agent_id` query params now use **relaxed match** (null on the row passes), mirroring `GET /v1/memories`. Previously they matched strictly against the encoded `uploaded_by` string.

This changes what the endpoint returns without changing the request shape. Practical impact:

- A query for `?user_id=u1` now also returns **agent-only documents** (those with `user_id = null`). Previously those required the literal `agent:<id>` string and wouldn't surface.
- You can combine `user_id` and `agent_id` (no longer mutually exclusive).
- A new `session_id` filter is supported.
- A new `file_type` filter is supported: `pdf | markdown | text | json`.

### Required code edits

- **Review any UI or business logic that assumed `?user_id=u1` only returned that user's own docs.** If you need strict match, post-filter the result set on `doc.user_id === expected`.
- **Stop encoding agent filters as `user_id=agent:${id}`.** Use `agent_id=<id>` directly.

### Query parameter table (after)

| Parameter       | Semantics                                                        |
| --------------- | ---------------------------------------------------------------- |
| `user_id`       | Relaxed match — `row.user_id = <value>` OR `row.user_id IS NULL` |
| `agent_id`      | Relaxed match — same rule on `agent_id` column                   |
| `session_id`    | Relaxed match — same rule on `session_id` column                 |
| `document_type` | Exact match on the free-form tag                                 |
| `file_type`     | Restrict to a file format: `pdf`, `markdown`, `text`, `json`     |
| `limit`         | 1–100, default 50                                                |
| `cursor`        | Opaque token from previous `next_cursor`                         |

Omit all scope filters to list every document in the product.

---

## 3 · Breaking: `POST /v1/documents/purge` scope semantics

The purge now uses strict match on the scope columns directly. A purge with `{scope: {agent_id: "a1"}}` matches documents where `agent_id = "a1"` — it no longer requires the `agent:a1` encoded uploader string.

Practical impact:

- Purges for pure-user or pure-agent scopes behave the same as before for most clients.
- Documents uploaded with combined `{user_id, agent_id}` scopes are now reachable by either purge dimension. Previously, only the `user_id` value was stored, so an `agent_id`-scoped purge wouldn't touch them.

### Required code edits

- **If you rely on the old "user_id wins" behavior to shield combined-scope docs from agent-scoped purges, re-test.** This is now a real strict match on the stored columns.

No request-body changes.

---

## 4 · Non-breaking (new behavior): upload preserves full scope

`POST /v1/documents` and `PUT /v1/documents/:id` request bodies are unchanged — they still take a `scope` object with `user_id` and/or `agent_id` (and optional `session_id`). What changed:

- **`session_id` is now persisted.** Previously it was silently dropped at the document layer (memories kept it). You can now query/filter by it.
- **Combined `{user_id, agent_id}` uploads keep both values independently.** Previously only `user_id` was stored as the `uploaded_by` string.
- **`PUT` scope replacement** atomically overwrites all three scope columns. Callers can reassign a doc from one user/agent/session to another in a single call.

### Recommended action

- **No client changes required.** Your existing uploads keep working.
- Consider surfacing `session_id` in your UI if it's meaningful to your product.

---

## 5 · Non-breaking (new behavior): `document_type` is free-form

`document_type` used to be an enum validated against a fixed set (`research_doc`, `transcript`, `code_snippet`, `image`, `report`, `raw_export`). Now it is a free-form optional string — any value is accepted, including empty (stored as NULL).

### Required code edits

- **If your client UI rendered a dropdown of the old enum values, you can keep it but remove enum-validation errors.** Any existing value (e.g. `research_doc`) keeps working.
- **You can now send any tag you want** (e.g. `"knowledge_file"`, `"meeting_notes"`, `"playbook"`).
- Any enum validation on your side should be removed — the server now rejects nothing on this field.

---

## 6 · Non-breaking (new behavior): `file_type` replaces the MIME allowlist message

Upload rejection for unsupported files now returns a clearer error message listing what IS supported:

### Before

```json
{
  "error": {
    "code": "UNSUPPORTED_CONTENT",
    "message": "Cannot extract text from MIME type 'application/zip'. Supported: text/*, application/pdf, application/json."
  }
}
```

### After

```json
{
  "error": {
    "code": "UNSUPPORTED_CONTENT",
    "message": "Unsupported file. MIME 'application/zip' (filename 'notes.zip') does not match any supported file type. Supported: pdf, markdown, text, json."
  }
}
```

### Supported file types (server-derived from MIME + filename)

| `file_type` | Accepted from                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pdf`       | MIME `application/pdf`                                                                                                                                        |
| `markdown`  | MIME `text/markdown` / `text/x-markdown`, OR filename `*.md` / `*.markdown` (helps when browsers send markdown as `text/plain` or `application/octet-stream`) |
| `text`      | MIME `text/*` (other than markdown), OR filename `*.txt` when MIME is missing                                                                                 |
| `json`      | MIME `application/json`, OR filename `*.json` when MIME is missing                                                                                            |

### Required code edits

- **If you parse the `UNSUPPORTED_CONTENT` error message**, update the regex / string match.
- **Markdown uploads now work reliably** even when the client sends `application/octet-stream` or omits the MIME — no need to force `text/markdown` yourself.

---

## 7 · Migration checklist

- [ ] Update the `Document` TypeScript / schema type: drop `uploaded_by`, add `user_id`, `agent_id`, `session_id`, `file_type`.
- [ ] Remove every read of `document.uploaded_by` from UI / logs / business logic.
- [ ] Remove any code that parses the `agent:<id>` encoding.
- [ ] Audit `GET /v1/documents` callsites — if you assumed strict match on `user_id`, add a client-side filter (`docs.filter(d => d.user_id === expected)`). Otherwise expect agent-only docs to surface.
- [ ] Stop sending `user_id=agent:${id}` when you meant an agent filter; use `agent_id=<id>` directly.
- [ ] If you render a dropdown of `document_type` values, you can keep it for UX but drop any client-side enum validation — the server now accepts any string.
- [ ] If you parse `UNSUPPORTED_CONTENT` error messages, update the expected format.
- [ ] Optional: adopt `session_id` in your UI / filters if sessions are meaningful to your product.
- [ ] Optional: adopt the new `file_type` filter on `GET /v1/documents`.

---

## 8 · Smoke tests after migration

Run these against your dev Deep Recall product. All three should pass.

1. **Upload + list round-trip**

   ```bash
   # Upload
   curl -X POST "$DR_URL/v1/documents" \
     -H "X-API-Key: $DR_KEY" \
     -F "file=@notes.md" \
     -F 'scope={"user_id":"u1","agent_id":"a1","session_id":"s1"}' \
     -F "document_type=knowledge_file"

   # List by each dimension — all three should return the doc
   curl "$DR_URL/v1/documents?user_id=u1"    -H "X-API-Key: $DR_KEY"
   curl "$DR_URL/v1/documents?agent_id=a1"   -H "X-API-Key: $DR_KEY"
   curl "$DR_URL/v1/documents?session_id=s1" -H "X-API-Key: $DR_KEY"
   ```

   Every response should contain the uploaded document, and each doc should have `user_id: "u1"`, `agent_id: "a1"`, `session_id: "s1"` (no `uploaded_by` field).

2. **Agent-only upload surfaces under a user query (relaxed match)**

   ```bash
   curl -X POST "$DR_URL/v1/documents" \
     -H "X-API-Key: $DR_KEY" \
     -F "file=@shared.md" \
     -F 'scope={"agent_id":"shared-agent"}'

   # A user-scoped query should return both the user-owned and agent-only docs
   curl "$DR_URL/v1/documents?user_id=u1" -H "X-API-Key: $DR_KEY"
   ```

   Expect the agent-only doc (`user_id: null, agent_id: "shared-agent"`) to appear in the list.

3. **Markdown upload without explicit MIME**

   ```bash
   curl -X POST "$DR_URL/v1/documents" \
     -H "X-API-Key: $DR_KEY" \
     -F "file=@notes.md;type=application/octet-stream" \
     -F 'scope={"user_id":"u1"}' \
     -F "document_type=knowledge_file"
   ```

   Expect `202 Accepted` (not `422 UNSUPPORTED_CONTENT`). The server should detect markdown from the `.md` extension and store `file_type: "markdown"` on the document row.
