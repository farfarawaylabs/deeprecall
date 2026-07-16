# LoCoMo Results

Published numbers for runs executed on this harness. Methodology, protocol,
and guardrails: `../../README.md`. Raw per-run artifacts
(`predictions_<run>.json` / `scored_<run>.json`) embed the dataset's questions
and gold answers verbatim, so — like the dataset itself (CC BY-NC 4.0) — they
are kept local and never committed. Re-generate them with the harness.

## Run `captions_noun_bedrock` — 2026-07-10 (current headline)

**Headline: LLM-judge cats 1–4 = 72.8% · official all-5 token-F1 = 49.8%**
(1,986 questions, all 10 conversations, 0 answer failures)

Configuration: `TOP_K=10`, `mode=recall`, answer via `/v1/answer` (the
shipped pipeline), answer model `claude-sonnet-5` served via **AWS Bedrock
geo inference profiles** (`us.anthropic.*`) — same weights as the Anthropic
API used in earlier runs, different serving stack. Judge `claude-opus-4-8`
(locked prompt), 1,540 fresh verdicts, 0 cached.

Measured change vs the previous full run (72.5% / 47.7%, pre-migration
harness): one bundle — official caption rendering in the harness
(`[shares <blip_caption>]`), the proper-noun extraction rule, and the Bedrock
runtime switch. Deltas attribute to the bundle.
Store after purge + full re-ingest: 2,962 active memories (+8.6% vs the
caption-less store), verified by all five gates (0 errored workflows,
0 dead letters, lost-fact needles present, 20/20 vector sample).

| Metric            | cat 1 multi-hop | cat 2 temporal | cat 3 open-domain | cat 4 single-hop | cat 5 adversarial | cats 1–4  | all 5     |
| ----------------- | --------------- | -------------- | ----------------- | ---------------- | ----------------- | --------- | --------- |
| LLM judge         | 53.5%           | 79.8%          | 41.7%             | 80.1%            | —                 | **72.8%** | —         |
| Official token-F1 | 26.2%           | 37.1%          | 10.8%             | 45.2%            | 90.8%             | 37.9%     | **49.8%** |

Movement vs previous run (judge: +0.3 overall — within the ±2–3-question
variance band; F1: +2.1 all-5): cat-4 F1 43.1→45.2 and judge 79.3→80.1
(caption facts are mostly single-hop details), cat-5 F1 87.0→90.8 (the
best-abstention result at this store size), cat-2 F1 34.7→37.1. Cat 3
open-domain dipped 45.8→41.7 (4 questions; tracks the answer LLM more than
the memory system). Judge and F1 moved together.

### Dev vs held-out

conv-26 is the dev conversation (every improvement iterated on it); the
other 9 are held out. **Gap: 2.4 points.**

| Split            | Judge cats 1–4      |
| ---------------- | ------------------- |
| dev conv-26      | 75.0% (114/152)     |
| held-out 9 convs | 72.6% (1,007/1,388) |

Per held-out conversation: conv-30 63.0, conv-41 79.6, conv-42 69.3,
conv-43 67.4, conv-44 75.6, conv-47 74.0, conv-48 76.4, conv-49 69.9,
conv-50 74.7. Note the caption change re-ingests every conversation, so the
dev baseline reset too (75.0 vs 77.0 on the old store — inside variance).

### Reference points (official all-5 token-F1)

LoCoMo paper: best RAG setup ≈ 43, gpt-4-turbo long-context 51.6, human
87.9. This run: **49.8**.

### Labeled secondary row — k=30 (shipped product-default config)

`/v1/query` and `/v1/answer` both default to `top_k=30` in the product
(argued from latency/cost, not benchmark score). Same store, same protocol,
same judge; only TOP_K differs. NOT the headline.

| Metric            | cat 1 | cat 2 | cat 3 | cat 4 | cat 5 | cats 1–4  | all 5 |
| ----------------- | ----- | ----- | ----- | ----- | ----- | --------- | ----- |
| LLM judge         | 69.5% | 81.3% | 49.0% | 83.7% | —     | **78.4%** | —     |
| Official token-F1 | 30.6% | 32.7% | 10.3% | 43.2% | 87.7% | 36.6%     | 48.1% |

Dev conv-26 = 81.6%, held-out = 78.1% (gap 3.5). Width helps multi-hop most
(cat 1 53.5 → 69.5) at the known honest cost of slightly more trap exposure
(cat-5 F1 90.8 → 87.7). Artifacts:
`predictions_captions_noun_bedrock_k30.json` / `scored_..._k30.json`.

### Latency

Warm `/v1/query` probe (20 recall queries against the conv-26 store,
`scripts/latency_probe.py`, second pass reported):

| Config                 | p50   | p95   |
| ---------------------- | ----- | ----- |
| k=10 (headline)        | 669ms | 800ms |
| k=30 (product default) | 612ms | 798ms |

Retrieval latency is flat in top_k — the funnel (embed → Vectorize+FTS →
rerank) does the same work regardless of how many results are returned.

## Prior runs (pre-migration harness, same protocol & locked judge)

| Run                       | Judge cats 1–4                   | All-5 F1 | Note                                                                                                          |
| ------------------------- | -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-07-09 full re-run    | 72.5% (dev 77.0 / held-out 72.0) | 47.7%    | post ingestion-reliability fix; Anthropic API serving                                                         |
| 2026-07-09 first full run | 59.0% (dev 75.0 / held-out 57.2) | 42.8%    | ~43% of held-out sessions silently lost to Vectorize 429s — the bug the verification gates now exist to catch |

Artifacts for these are retained outside the repo; numbers published from
this directory supersede them.

## Reporting conventions

- Headline: `TOP_K=10`, `mode=recall`, answer model fixed, full 10
  conversations, both metrics, per-category breakdown, dev/held-out split.
- Clearly-labeled secondary rows allowed (e.g. k=30 product default);
  never presented as the headline.
- Run-to-run answer-LLM variance is ±2–3 questions; single-question deltas
  are noise.
- Note the answer-model serving stack per run (Anthropic API vs AWS
  Bedrock inference profiles).
