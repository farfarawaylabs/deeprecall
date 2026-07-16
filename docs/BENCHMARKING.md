# Benchmarking Deep Recall

Step-by-step guide to running a long-term-memory benchmark (LoCoMo or LongMemEval) end-to-end against a deployed Deep Recall environment.

## Why this works — and what you're actually measuring

LoCoMo and LongMemEval are **question-answering** benchmarks: they grade a natural-language _answer_ against a gold answer, not raw retrieval hits. Deep Recall didn't answer questions until `POST /v1/answer` shipped — so that endpoint **is** the answerer this harness needs. The loop is:

```
ingest the benchmark's conversation history  →  /v1/ingest  (async pipeline: extract → policy → reconcile → persist)
for each question:                            →  /v1/answer  (retrieve, then one LLM call → grounded answer + citations)
score answer vs. gold                         →  LLM-as-judge
```

Because the harness **holds the answer model fixed**, the resulting score is effectively a measure of **retrieval quality**. That's the point: once you have a number, you can A/B a retrieval change (e.g. a reranker, or the future entity graph) by re-running with the _same_ answer model and comparing — proving each addition earns its place instead of asserting it.

### Read this before you start

- **Deep Recall's extraction is opinionated.** The policy engine drops agent-inferred facts below the 0.7 confidence threshold and filters PII; reconcile skips near-duplicates. Benchmark dialogue is mostly first-person user statements (extracted as `user_stated`, which clears the threshold), so most content lands — but some inferred facts will be dropped, and that legitimately affects recall. The `/v1/ingest/status` endpoint's `rejections` array shows you exactly what was dropped and why. Treat that as signal, not noise.
- **Start small.** A full LongMemEval run ingests ~500 haystacks (many sessions each) and makes ~500 answer calls — each ingest session and each answer is an LLM call. Validate the harness on **one conversation / a handful of questions** before committing to a full run. LoCoMo (10 conversations) is far more tractable than LongMemEval for a first pass.
- **Cost is real.** You pay for: LLM extraction per ingested session, Workers AI embeddings, the LLM answer per question, and the judge call per question. Ballpark a full LoCoMo run at low hundreds of LLM calls; LongMemEval full at thousands. Dev environment, so it's cheap infra — but not free model spend.

---

## Prerequisites

1. **A deployed environment.** These instructions target **dev**. All workers deployed (`pnpm deploy:dev`), migrations applied (`pnpm db:migrate:dev`).
   - Memory API: `https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev`
2. **A product with Vectorize metadata indexes.** The default product works. `/v1/query` (and therefore `/v1/answer`) silently returns nothing if the `user_id` metadata index is missing — verify:
   ```bash
   pnpx wrangler vectorize list-metadata-index deeprecall-vectors-default-dev
   ```
   You should see `user_id`, `agent_id`, `status`, `type`, `source_type`, `confidence`. If `user_id` is missing:
   ```bash
   pnpx wrangler vectorize create-metadata-index deeprecall-vectors-default-dev \
     --property-name user_id --type string
   ```
3. **A product API key** (from `scripts/seed-kv-dev.sh` output, or your KV). Export it:
   ```bash
   export API_KEY="your-dev-product-api-key"
   export API_URL="https://deeprecall-memory-api-dev.<your-subdomain>.workers.dev"
   ```
4. **The answer model is configured.** Default is `anthropic:claude-sonnet-5` via the `ANSWER_MODEL` var; the memory-api worker needs the matching provider secret (`ANTHROPIC_API_KEY`). Keep this **fixed** across benchmark runs so scores are comparable.
5. **A local Python env** for the harness + judge:
   ```bash
   python3 -m venv .venv && source .venv/bin/activate
   pip install requests anthropic
   export ANTHROPIC_API_KEY="sk-ant-..."   # for the LLM judge (separate from the answer model)
   ```

> **Isolation.** This guide ingests benchmark data into the **default** product, namespacing each conversation by `user_id` (e.g. `locomo-conv-0`). That keeps it simple and is cleaned up at the end via `/admin/memories/purge`. If you want hard isolation from other dev data, onboard a dedicated `bench` product instead (see `docs/ONBOARDING.md`) — it provisions its own D1 + Vectorize index — and point the harness at its API key. The onboarding step requires adding the returned bindings and redeploying, so only do it if you need the isolation.

---

## Part 1 — LoCoMo (recommended first benchmark)

LoCoMo is 10 long, multi-session conversations between two speakers, each with ~200 QA pairs spanning five categories (single-hop, multi-hop, temporal reasoning, open-domain/commonsense, and adversarial "not answerable" questions).

### Step 1 — Get the dataset

LoCoMo is published by Snap Research: <https://github.com/snap-research/locomo>. Download `locomo10.json` (10 samples) into a working directory. Check the repo's license and terms before use.

```bash
mkdir -p bench && cd bench
# Download locomo10.json from the LoCoMo repo into ./bench/
```

### Step 2 — Understand the shape

Each sample looks roughly like this (verify field names against the file you actually download — the schema has drifted across releases):

```jsonc
{
  "sample_id": "conv-0",
  "conversation": {
    "speaker_a": "Caroline",
    "speaker_b": "Melanie",
    "session_1_date_time": "1:56 pm on 8 May, 2023",
    "session_1": [
      { "speaker": "Caroline", "text": "Hey Mel! ...", "dia_id": "D1:1" },
      { "speaker": "Melanie", "text": "Oh no ...", "dia_id": "D1:2" },
    ],
    "session_2_date_time": "...",
    "session_2": [
      /* ... */
    ],
  },
  "qa": [
    {
      "question": "When did Caroline adopt a dog?",
      "answer": "May 2023",
      "evidence": ["D1:2"],
      "category": 3,
    },
  ],
}
```

Categories are integers; the exact mapping is documented in the LoCoMo repo. Adversarial questions expect a "not answerable / not mentioned" style answer — keep them, they test whether the system hallucinates.

### Step 3 — Ingest the conversation history

For each conversation, use a **unique `user_id`** so retrieval stays isolated per conversation. Format each session as a text block and submit it to `/v1/ingest`. Collect the returned `instance_id`s so you can poll for completion.

```python
# bench/ingest.py
import json, os, re, time, requests

API_URL = os.environ["API_URL"]
API_KEY = os.environ["API_KEY"]
H = {"x-api-key": API_KEY, "Content-Type": "application/json"}

def user_id_for(sample_id: str) -> str:
    return f"locomo-{sample_id}"

def sessions_in_order(conv: dict):
    # Discover session_1, session_2, ... in numeric order.
    keys = [k for k in conv if re.fullmatch(r"session_\d+", k)]
    return sorted(keys, key=lambda k: int(k.split("_")[1]))

def render_session(conv: dict, skey: str) -> str:
    when = conv.get(f"{skey}_date_time", "")
    lines = [f"[Conversation on {when}]"] if when else []
    for turn in conv[skey]:
        lines.append(f"{turn['speaker']}: {turn['text']}")
    return "\n".join(lines)

def ingest_sample(sample: dict) -> list[str]:
    conv = sample["conversation"]
    uid = user_id_for(sample["sample_id"])
    instance_ids = []
    for skey in sessions_in_order(conv):
        content = render_session(conv, skey)
        if not content.strip():
            continue
        r = requests.post(f"{API_URL}/v1/ingest", headers=H, json={
            "content": content,
            "scope": {"user_id": uid},
            "source_channel": "chat",
        })
        r.raise_for_status()
        instance_ids.append(r.json()["instance_id"])
        time.sleep(0.2)  # be gentle on the pipeline
    return instance_ids

if __name__ == "__main__":
    data = json.load(open("locomo10.json"))
    # SMOKE FIRST: start with one conversation.
    data = data[:1]
    all_instances = {}
    for sample in data:
        ids = ingest_sample(sample)
        all_instances[sample["sample_id"]] = ids
        print(f"{sample['sample_id']}: submitted {len(ids)} sessions")
    json.dump(all_instances, open("instances.json", "w"), indent=2)
```

Run it:

```bash
python ingest.py
```

### Step 4 — Wait for the pipeline, and inspect what landed

Ingestion is an async Cloudflare Workflow. Poll `/v1/ingest/status/:instance_id` until every instance reports `complete`, and surface rejections so you can see what the policy/reconcile steps dropped.

```python
# bench/wait.py
import json, os, time, requests

API_URL, API_KEY = os.environ["API_URL"], os.environ["API_KEY"]
H = {"x-api-key": API_KEY}

def poll(instance_id, timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        s = requests.get(f"{API_URL}/v1/ingest/status/{instance_id}", headers=H).json()
        if s["status"] in ("complete", "errored", "terminated"):
            return s
        time.sleep(5)
    return {"status": "timeout"}

if __name__ == "__main__":
    instances = json.load(open("instances.json"))
    persisted = dropped = 0
    for sample_id, ids in instances.items():
        for iid in ids:
            s = poll(iid)
            res = s.get("result") or {}
            persisted += res.get("candidates_persisted", 0)
            dropped   += len(res.get("rejections", []))
            if res.get("rejections"):
                for rej in res["rejections"]:
                    print(f"  DROP [{rej['step']}] {rej['reason']}")
        print(f"{sample_id}: done")
    print(f"\nTotal persisted={persisted}  dropped={dropped}")
```

```bash
python wait.py
```

> **Optional — let consolidation settle.** The consolidation worker builds `profile`-type rollups asynchronously (a fact seen 3+ times graduates to a profile). For `recall`-mode answering you don't need profiles, so you can proceed immediately. If you plan to answer in `full_briefing` mode, give the consolidation queue a minute, or trigger it via `/admin/consolidation/trigger` (see `docs/ADMIN_GUIDE.md`).

**Verify** a conversation actually has memories before spending money on answers (admin endpoints live under `/admin` on the same host, authenticated with the **admin** key — not the product key):

```bash
export ADMIN_KEY="your-dev-admin-key"   # from docs/ADMIN_GUIDE.md
curl -s "$API_URL/admin/memories/dump?user_id=locomo-conv-0&product_id=default" \
  -H "x-admin-key: $ADMIN_KEY" | jq '.total'
```

Expect a non-zero count.

### Step 5 — Answer every question (official questioning protocol)

For each QA pair, call `/v1/answer` with the question scoped to that conversation's `user_id`. Capture the answer, the `based_on` citations, and the retrieved memories (for later error analysis).

Questions must be sent in the **official LoCoMo format** (from
`task_eval/gpt_utils.py`) so token-F1 measures memory, not answer style:

```python
# bench/answer.py — core protocol pieces; see the harness dir for the full
# file (adds retry with backoff, per-question checkpointing, and resume).

SHORT_HINT = (" Answer in the form of a short phrase, with exact words from"
              " the conversation whenever possible.")
DATE_HINT = " Use DATE of CONVERSATION to answer with an approximate date."
NOT_MENTIONED = "Not mentioned in the conversation"

def build_question(qa, sample_id):
    """Return (question_to_send, cat5_answer_key or None), per official protocol."""
    q, cat = qa["question"], qa.get("category")
    if cat == 5:   # adversarial -> official two-option MCQ, order randomized
        trap = qa.get("answer") or qa.get("adversarial_answer")
        rng = random.Random(f"{sample_id}|{q}")   # deterministic across resumes
        mcq = q + " Select the correct answer: (a) {} (b) {}. "
        if rng.random() < 0.5:
            return mcq.format(NOT_MENTIONED, trap), {"a": NOT_MENTIONED, "b": trap}
        return mcq.format(trap, NOT_MENTIONED), {"a": trap, "b": NOT_MENTIONED}
    if cat == 2:   # temporal -> official date hint, verbatim
        return q + DATE_HINT + SHORT_HINT, None
    return q + SHORT_HINT, None

def map_cat_5_answer(model_prediction, answer_key):
    """Map a bare '(a)'/'(b)' MCQ selection back to the option text (port of
    official get_cat_5_answer). Free-form answers pass through unchanged."""
    p = model_prediction.strip().lower()
    if len(p) == 1:
        return answer_key["a"] if "a" in p else answer_key["b"]
    if len(p) == 3:
        return answer_key["a"] if "(a)" in p else answer_key["b"]
    return model_prediction
```

Each record stores the **original** question (stable resume key), the
`question_sent`, `gold`, `category`, `predicted` (MCQ-mapped for cat 5),
`based_on`, and `n_retrieved`. The runner checkpoints `predictions.json` after
every question; re-running retries only the failures.

```bash
python answer.py
```

### Step 6 — Score (official LoCoMo token-F1 + locked LLM judge)

**The official LoCoMo methodology** — verified 2026-07-08 against the paper PDF
and the official eval code (`snap-research/locomo`, `task_eval/`). Do not
re-derive it; do not "improve" the scorer between runs (anti-cheating rule:
between runs, change only Deep Recall — never the scorer).

The category **integers in the data** map as follows (verified: full-dataset
counts match the paper's Table 5 exactly; the paper's _prose_ numbers them
differently — trust this table):

| Cat | Type        | Official scoring rule (`task_eval/evaluation.py`)                                                                    |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | multi-hop   | multi-answer F1: split pred + gold on commas; each gold item takes its best-matching pred item; mean over gold items |
| 2   | temporal    | token F1 (normalize: lowercase, strip punctuation/commas, drop a/an/the/and; then Porter-stem)                       |
| 3   | open-domain | token F1; gold truncated at the first `;`                                                                            |
| 4   | single-hop  | token F1                                                                                                             |
| 5   | adversarial | 1 iff prediction contains "no information available" or "not mentioned" (abstention = correct)                       |

Two protocol details on the _questioning_ side (relevant when generating
predictions, not when scoring): official runs append
`" Use DATE of CONVERSATION to answer with an approximate date."` to cat-2
questions, and rewrite cat-5 questions as a two-option MCQ —
`(a) Not mentioned in the conversation (b) <trap>` — which is why the cat-5
check is a literal substring. Free-form abstentions phrased differently
("I don't have information about that") score 0 under the official check until
the answer contract is aligned.

**Two aggregates, both worth reporting, clearly labeled:**

- **Cats 1–4** — what the memory-systems literature (Mem0, Zep, …) reports;
  use this to compare against published numbers.
- **All 5** — the paper's own "Overall" (yes, the paper includes adversarial).

**The LLM judge is a secondary metric** (the common substitute in the memory
literature, since token-F1 punishes verbose answers). Judge rules: a strong,
separate model (`claude-opus-4-8`) distinct from the answer model; **one locked
prompt for all categories — never tuned per-category, never loosened between
runs**; cats 1–4 only. Verdicts are cached in `scored.json` keyed by
`(sample_id, question, predicted)`, so re-scoring unchanged predictions costs
nothing and changed predictions are automatically re-judged.

The full scorer lives at `bench/score.py` (the official-metric functions are
ported verbatim from `task_eval/evaluation.py`, Porter stemming included):

```python
# bench/score.py — see the harness dir for the full file. Core pieces:

def normalize_answer(s):                      # official normalization
    s = s.replace(',', "")
    ...  # lowercase, strip punctuation, drop a/an/the/and, collapse whitespace

def f1_score(prediction, ground_truth):       # cats 2/3/4 (Porter-stemmed tokens)
def f1(prediction, ground_truth):             # cat 1 multi-answer variant

def official_score(category, prediction, gold) -> float:
    if category == 3: gold = gold.split(';')[0].strip()
    if category in (2, 3, 4): return f1_score(prediction, gold)
    if category == 1:         return f1(prediction, gold)
    if category == 5:         # abstention = correct, official substring check
        low = prediction.lower()
        return 1.0 if ('no information available' in low
                       or 'not mentioned' in low) else 0.0

JUDGE_PROMPT = """You are grading a memory system's answer against the gold answer.
Mark CORRECT if the predicted answer conveys the same factual information as the
gold answer (allow paraphrase, extra detail, and formatting differences). Mark
INCORRECT if it contradicts, omits, or fabricates the key fact. For questions the
gold answer marks as not answerable, a predicted answer that declines / says it
has no information is CORRECT.

Question: {q}
Gold answer: {gold}
Predicted answer: {pred}

Respond with exactly one word: CORRECT or INCORRECT."""   # LOCKED — do not tune
```

```bash
python score.py
```

Output: per-category scores for both metrics, the cats-1–4 aggregate, and the
all-5 official aggregate; `scored.json` carries `f1_official` and
`judge_correct` per question for error analysis (inspect `based_on` and
`n_retrieved` on the wrong ones — most misses are retrieval misses, which is
exactly what you want to improve).

**Token-F1 is the primary tracked number** now that Step 5 sends questions in
the official format (verified 2026-07-08: aligning the answer contract roughly
doubled cats-1–4 F1 — 15.6% → 29.4% — while judge accuracy stayed flat at
52.0% → 53.3%, confirming the earlier gap was answer verbosity, not memory
quality). The judge stays as the secondary metric and as the comparison point
against published memory-system numbers, which are judge-based.

### Step 7 — Clean up

Remove the benchmark data from the default product when done (per conversation `user_id`):

```bash
for i in $(seq 0 9); do
  curl -s -X POST "$API_URL/admin/memories/purge" \
    -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
    -d "{\"user_id\": \"locomo-conv-$i\", \"product_id\": \"default\"}"
done
```

(Admin key/endpoint details: `docs/ADMIN_GUIDE.md`. Skip this if you used a dedicated `bench` product — just decommission it.)

---

## How to use the number

- **Baseline it once, then change one thing.** With the answer model, `mode`, and `top_k` held fixed, re-run after a retrieval change (a cross-encoder reranker, the entity graph, a different fusion weight) and compare per-category deltas. Temporal and multi-hop categories are where graph/rerank improvements should show up first.
- **Isolate retrieval from answering.** If a category is weak, check `scored.json`: if `based_on` is empty or the right memory wasn't in `n_retrieved`, it's a **retrieval** miss (fix retrieval); if the right memory was retrieved but the answer is still wrong, it's an **answering** miss (fix the answer prompt/model).
- **Watch the drop count from Step 4.** A high `dropped` number means extraction/policy is discarding facts the questions depend on — a real, measurable effect of Deep Recall's opinionated ingestion, and a candidate for a per-benchmark extraction template.

---

## Part 2 — LongMemEval (appendix)

LongMemEval is larger and harder: 500 questions, each with a "haystack" of many chat sessions (most irrelevant distractors), testing five memory abilities (info extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention). Repo: <https://github.com/xiaowu0162/LongMemEval>.

The harness is the **same shape** as LoCoMo — only the loader and scale change:

- **Variants.** Use **`longmemeval_oracle`** (only the evidence sessions, no distractors) to validate the harness and measure answering quality cheaply first. Then **`longmemeval_s`** (~115k-token haystacks) for a realistic retrieval test. `longmemeval_m` (much larger haystacks) is expensive — only run it once `_s` looks right.
- **Per-question isolation.** Each question has its **own** haystack, so give each question a distinct `user_id` (e.g. `lme-{question_id}`) and ingest that question's sessions under it. Do **not** pool questions — their haystacks are independent.
- **Format.** Each entry has `question_id`, `question_type`, `question`, `answer`, and `haystack_sessions` (a list of sessions, each a list of `{role, content}` turns), plus `answer_session_ids` marking the evidence sessions. Render each session to text and ingest as in LoCoMo Step 3.
- **Abstention questions** (`question_id` ending in `_abs`) expect the system to say it doesn't know — the judge rule in Step 6 already handles "declines → correct" for these.
- **Scoring.** LongMemEval ships an official eval script (LLM-as-judge). You can reuse the Step 6 judge for a quick number, or run their script against your `predictions.json` (map fields to their expected format) for the canonical metric.

Start with `longmemeval_oracle` on 10–20 questions before anything else.

---

## Files this guide references

| Thing                                                         | Where                          |
| ------------------------------------------------------------- | ------------------------------ |
| Public API (ingest, ingest status, query, answer)             | `docs/API_GUIDE.md`            |
| Admin endpoints (memories dump, purge, consolidation trigger) | `docs/ADMIN_GUIDE.md`          |
| Onboarding a dedicated `bench` product                        | `docs/ONBOARDING.md`           |
| Existing end-to-end script pattern                            | `scripts/smoke-agent-scope.sh` |
