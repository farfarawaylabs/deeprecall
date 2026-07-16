# Deep Recall Benchmarks

Reproducible benchmark harnesses for Deep Recall and — through a shared
adapter interface — other memory products under **identical** conditions
(same dataset rendering, same questioning protocol, same answer model, same
locked judge). Self-reported numbers across the memory-systems landscape are
produced on incompatible harnesses; anything published from here must be
reproducible from this directory alone.

| Benchmark                                | Status  | Where          |
| ---------------------------------------- | ------- | -------------- |
| LoCoMo (long-term conversational memory) | active  | `locomo/`      |
| LongMemEval                              | planned | `longmemeval/` |

## Setup

```bash
cd benchmarks
uv venv && uv pip install --python .venv/bin/python -r requirements.txt
python locomo/data/fetch_data.py                # dataset is NOT committed (license, below)
```

Required environment:

```bash
export API_URL=...            # Deep Recall memory-api base URL (dev)
export API_KEY=...            # Deep Recall PRODUCT key — determines the target product silently
export ANTHROPIC_API_KEY=...  # locked judge (+ adapter-mode answering)
export ADMIN_KEY=...          # dead-letter verification gate
export CLOUDFLARE_ACCOUNT_ID=...  # wrangler-based gates (workflows, vector sample)
```

## LoCoMo layout

```
locomo/
  data/fetch_data.py     downloads locomo10.json (gitignored)
  harness/
    config.py            every knob is an env var; headline config locked at TOP_K=10
    ingest.py            official session rendering (photo captions inline) + occurred_at
    answer.py            official questioning protocol; endpoint + adapter answer modes
    score.py             official token-F1 (verbatim port) + LOCKED LLM judge
  adapters/
    base.py              MemoryAdapter — the product-neutral interface
    deeprecall.py        /v1/ingest, /v1/query, purge (+ /v1/answer for headline runs)
  scripts/
    run_full.sh          purge -> ingest (batched) -> verify gates -> answer -> score
    purge.sh             purge conversations and wait for completion
    verify_store.py      post-ingest gates — MUST pass before the answer stage
    latency_probe.py     /v1/query p50/p95 probe
  results/
    RESULTS.md           published numbers + methodology notes per named run
    predictions_<run>.json / scored_<run>.json   raw artifacts per named run
```

## Protocol (official LoCoMo, verified against the paper + `snap-research/locomo` eval code)

- **Category mapping in the data**: 1=multi-hop, 2=temporal, 3=open-domain,
  4=single-hop, 5=adversarial. (The paper's prose numbers them differently —
  trust the data, verified against Table 5 counts.)
- **Ingest**: one submission per session, speaker-prefixed turns,
  shared-photo captions rendered inline (`[shares <blip_caption>]`) per the
  official protocol — many golds exist only in a caption. Session timestamps
  are passed as `occurred_at`.
- **Questioning** (`task_eval/gpt_utils.py`): short-phrase instruction on all
  non-adversarial questions; cat 2 additionally gets the verbatim DATE hint;
  cat 5 is rewritten as the official two-option MCQ where abstention
  ("Not mentioned in the conversation") is the correct option.
- **Metrics** (`harness/score.py`):
  - _Official token-F1_ — verbatim port of `task_eval/evaluation.py`
    (normalize + Porter stem; multi-answer F1 for cat 1; cat-3 gold truncated
    at `;`; cat 5 via the official abstention substring check). The paper's
    Overall includes all 5 categories.
  - _LLM-judge accuracy, cats 1–4_ — the memory-systems-literature
    convention (Mem0, Zep, etc.), for comparability. Judge model and prompt
    are locked (see guardrails).
    Both aggregates are always reported, clearly labeled.

## Anti-cheating guardrails (non-negotiable)

1. **No per-category or question-pattern logic** anywhere in product code.
2. **Benchmark-independent justification** written down for every product
   change before it ships.
3. **Scorer and judge locked**: one judge prompt for all categories, never
   loosened between runs; verdicts cached keyed on
   `(sample_id, question, predicted)` so unchanged predictions are never
   re-judged. The harness may only ever change to match the official
   protocol, never to favor Deep Recall.
4. **One measured change per run**; between runs change only the product.
5. **Headline config fixed**: `TOP_K=10`, `mode=recall`, answer model held
   fixed. Any other parameterization (e.g. the k=30 product-default row) is
   published as a clearly-labeled diagnostic, never as the headline.
6. **No benchmark-shaped prompt rules** (e.g. "never say not mentioned" —
   trades real-user abstention for benchmark points).
7. **Dev/held-out split reported**: `conv-26` is the dev conversation every
   improvement iterated on; the other 9 are held out. Run-to-run answer-LLM
   variance is ±2–3 questions — single-question deltas are noise.

## Reproducing the headline run

```bash
cd benchmarks/locomo
RUN_NAME=myrun bash scripts/run_full.sh all
```

Stages (`purge|ingest|verify|answer|score`) can be run individually — the
answer and score stages checkpoint after every item and resume safely.
`verify` is mandatory before `answer`: it gates on zero errored ingestion
workflows, zero dead letters, sane per-conv counts, previously-lost-fact
spot checks, and a Vectorize existence sample (a silently lossy import once
cost 15 points of held-out accuracy; never publish without these gates).

Cost/time on the full 10-conversation set: ingest ~1h (batched,
stability-gated), 1,986 answers ~2h, scoring ~30min of judge calls.

## Head-to-head runs (other products)

Implement `MemoryAdapter` (`adapters/base.py`) for the product: `purge`,
`ingest_session`, `wait_ready`, `query`. Then run with:

```bash
ADAPTER=<name> ANSWER_MODE=adapter bash scripts/run_full.sh all
```

In adapter mode the harness performs retrieval through the adapter and makes
the answer LLM call itself — model, prompt, and max_tokens identical for
every product (`harness/answer.py`, `ADAPTER_ANSWER_PROMPT` is frozen).
Deep Recall's own headline uses `ANSWER_MODE=endpoint` (`/v1/answer`, the
shipped pipeline); for head-to-head tables Deep Recall is run in adapter
mode too, so the answer stage is provably identical. Fairness rules: each
product on its default settings, same `top_k` where the concept maps, every
deviation documented in RESULTS.md.

## Dataset license

LoCoMo is **CC BY-NC 4.0** (Attribution-NonCommercial). The dataset is not
committed to this repository — `data/fetch_data.py` downloads it from the
official source at run time.
