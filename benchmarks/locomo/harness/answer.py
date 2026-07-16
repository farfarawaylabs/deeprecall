# ---------------------------------------------------------------------------
# THIRD-PARTY / NON-COMMERCIAL NOTICE
#
# The questioning prompts reproduced in this file are taken verbatim from
# snap-research/locomo (task_eval/gpt_utils.py, claude_utils.py), which is
# licensed CC BY-NC 4.0. Those prompts are NOT covered by this repository's
# Apache-2.0 license; they are included solely for non-commercial reproduction
# of the LoCoMo benchmark. See the root NOTICE file.
# ---------------------------------------------------------------------------
"""Answer every LoCoMo question through the memory system under test, using
the OFFICIAL questioning protocol (snap-research/locomo, task_eval/gpt_utils.py
and claude_utils.py):

  - all non-adversarial questions ask for a short phrase in the words of the
    conversation (their QA_PROMPT wrapper)
  - cat 2 (temporal) additionally gets the DATE hint, verbatim
  - cat 5 (adversarial) is rewritten as a two-option MCQ where "Not mentioned
    in the conversation" is the correct option, order randomized (here:
    deterministic per question, stable across resume runs)

Two answer modes (ANSWER_MODE env, see config.py):

  endpoint — the product's own retrieve+answer path (Deep Recall /v1/answer).
             Used for Deep Recall headline runs: it is the shipped pipeline.
  adapter  — the harness retrieves top_k memories via the MemoryAdapter and
             makes the answer LLM call itself. Model, prompt, and max_tokens
             are identical for every product: the head-to-head mode.

Checkpoints after every question; safe to re-run — successful answers are
resumed from PREDICTIONS_FILE and only failures are retried.
"""

import json
import os
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters import get_adapter  # noqa: E402
from harness import config  # noqa: E402

MAX_RETRIES = 4  # transient (5xx / network / overloaded) failures only

SHORT_HINT = (
    " Answer in the form of a short phrase, with exact words from"
    " the conversation whenever possible."
)
DATE_HINT = " Use DATE of CONVERSATION to answer with an approximate date."
NOT_MENTIONED = "Not mentioned in the conversation"

# Adapter-mode answer prompt — FROZEN for head-to-head comparability. It is
# deliberately neutral: ground on the memories, abstain when they don't
# contain the answer. No product- or benchmark-shaped instructions.
ADAPTER_ANSWER_PROMPT = """You are answering a question using memories retrieved from past conversations.

Retrieved memories:
{memories}

Question: {question}

Answer based only on the retrieved memories. If they do not contain the information needed to answer, say you do not have that information."""


class AnswerFailed(Exception):
    """Raised after retries are exhausted, or on a non-retryable client error."""


def build_question(qa: dict, sample_id: str):
    """Return (question_to_send, cat5_answer_key or None), per official protocol."""
    q, cat = qa["question"], qa.get("category")
    if cat == 5:
        trap = qa.get("answer") or qa.get("adversarial_answer")
        # deterministic per-question option order, stable across resume runs
        rng = random.Random(f"{sample_id}|{q}")
        mcq = q + " Select the correct answer: (a) {} (b) {}. "
        if rng.random() < 0.5:
            return mcq.format(NOT_MENTIONED, trap), {"a": NOT_MENTIONED, "b": trap}
        return mcq.format(trap, NOT_MENTIONED), {"a": trap, "b": NOT_MENTIONED}
    if cat == 2:
        return q + DATE_HINT + SHORT_HINT, None
    return q + SHORT_HINT, None


def map_cat_5_answer(model_prediction: str, answer_key: dict) -> str:
    """Map an MCQ selection back to the option text (port of official
    get_cat_5_answer). Free-form answers pass through unchanged."""
    p = model_prediction.strip().lower()
    if len(p) == 1:
        return answer_key["a"] if "a" in p else answer_key["b"]
    if len(p) == 3:
        return answer_key["a"] if "(a)" in p else answer_key["b"]
    return model_prediction


def answer_via_endpoint(adapter, question: str, uid: str) -> dict:
    """Product answer path with retry on transient failures (5xx/429/network)."""
    last = None
    for attempt in range(MAX_RETRIES):
        try:
            r = adapter.answer_endpoint(uid, question, config.TOP_K, config.MAX_TOKENS)
        except Exception as e:  # requests network errors
            last = f"network: {e}"
        else:
            if r.status_code < 400:
                try:  # a truncated 200 body is transient — retry, don't crash
                    resp = r.json()
                    return {
                        "predicted": resp["answer"],
                        "based_on": resp["based_on"],
                        "n_retrieved": len(resp["memories"]),
                    }
                except (ValueError, KeyError) as e:
                    last = f"bad response body: {e}"
            elif 400 <= r.status_code < 500 and r.status_code != 429:
                raise AnswerFailed(f"{r.status_code}: {r.text[:300]}")
            else:
                last = f"{r.status_code}: {r.text[:300]}"  # 5xx/429 — retryable
        if attempt < MAX_RETRIES - 1:
            time.sleep(2**attempt)  # 1s, 2s, 4s backoff
    raise AnswerFailed(last or "unknown error")


_anthropic_client = None


def answer_via_adapter(adapter, question: str, uid: str) -> dict:
    """Head-to-head path: adapter retrieval + the harness's own LLM call."""
    global _anthropic_client
    if _anthropic_client is None:
        from anthropic import Anthropic

        _anthropic_client = Anthropic()  # reads ANTHROPIC_API_KEY

    memories = adapter.query(uid, question, config.TOP_K)
    rendered = "\n".join(f"- {m}" for m in memories) or "(none retrieved)"
    prompt = ADAPTER_ANSWER_PROMPT.format(memories=rendered, question=question)
    last = None
    for attempt in range(MAX_RETRIES):
        try:
            msg = _anthropic_client.messages.create(
                model=config.ANSWER_MODEL,
                max_tokens=config.MAX_TOKENS,
                messages=[{"role": "user", "content": prompt}],
            )
            text = "".join(b.text for b in msg.content if b.type == "text").strip()
            return {"predicted": text, "based_on": memories, "n_retrieved": len(memories)}
        except Exception as e:
            import anthropic

            if isinstance(e, anthropic.APIStatusError) and 400 <= e.status_code < 500 and e.status_code != 429:
                raise AnswerFailed(f"{e.status_code}: {e.message}")
            last = str(e)
        if attempt < MAX_RETRIES - 1:
            time.sleep(2**attempt)
    raise AnswerFailed(last or "unknown error")


def dump_atomic(obj, path: Path) -> None:
    """Checkpoint without a truncation window: a crash mid-write must never
    destroy the only copy of hours of answered questions."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    json.dump(obj, open(tmp, "w"), indent=2)
    os.replace(tmp, path)


def load_done(predictions_file: Path) -> dict:
    """Resume support: index prior *successful* predictions by
    (sample_id, qa_index). NOT by question text — locomo10.json contains 13
    duplicate (sample_id, question) pairs (one even spanning categories 4/5),
    which text keying would collapse on resume."""
    if not predictions_file.exists():
        return {}
    prev = json.load(open(predictions_file))
    return {
        (p["sample_id"], p["qa_index"]): p
        for p in prev
        if p.get("predicted") is not None and "qa_index" in p
    }


if __name__ == "__main__":
    data = config.load_samples()
    adapter = get_adapter()
    answer_fn = {
        "endpoint": answer_via_endpoint,
        "adapter": answer_via_adapter,
    }.get(config.ANSWER_MODE) or sys.exit(f"unknown ANSWER_MODE: {config.ANSWER_MODE}")
    if config.ANSWER_MODE == "endpoint" and not hasattr(adapter, "answer_endpoint"):
        sys.exit(f"adapter {adapter.name} has no product answer endpoint — use ANSWER_MODE=adapter")

    config.RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    done = load_done(config.PREDICTIONS_FILE)
    preds = list(done.values())  # carry successful answers forward
    ok = failed = skipped = 0
    for sample in data:
        uid = f"locomo-{sample['sample_id']}"
        for qa_index, qa in enumerate(sample["qa"]):
            key = (sample["sample_id"], qa_index)
            if key in done:  # already answered on a prior run
                skipped += 1
                continue
            question_sent, cat5_key = build_question(qa, sample["sample_id"])
            rec = {
                "sample_id": sample["sample_id"],
                "qa_index": qa_index,
                "question": qa["question"],
                "question_sent": question_sent,
                "gold": qa.get("answer") or qa.get("adversarial_answer"),
                "category": qa.get("category"),
            }
            try:
                result = answer_fn(adapter, question_sent, uid)
                predicted = result["predicted"]
                if cat5_key is not None:
                    mapped = map_cat_5_answer(predicted, cat5_key)
                    if mapped != predicted:
                        rec["predicted_raw"] = predicted
                    predicted = mapped
                rec.update(
                    predicted=predicted,
                    based_on=result["based_on"],
                    n_retrieved=result["n_retrieved"],
                )
                ok += 1
                print(f"[{sample['sample_id']}] OK   {qa['question'][:58]}")
            except AnswerFailed as e:
                rec.update(predicted=None, based_on=[], n_retrieved=0, error=str(e))
                failed += 1
                print(f"[{sample['sample_id']}] FAIL {qa['question'][:48]} -> {e}")
            preds.append(rec)
            # checkpoint every question
            dump_atomic(preds, config.PREDICTIONS_FILE)
            time.sleep(0.3)  # gentle pacing on the pipeline
    print(
        f"\n{ok} answered, {failed} failed, {skipped} resumed"
        f" -> {len(preds)} in {config.PREDICTIONS_FILE}"
    )
    if failed:
        print("Re-run this script to retry ONLY the failed ones (successes are cached).")
        # Non-zero so an orchestrator can never score a partial run as final.
        sys.exit(1)
