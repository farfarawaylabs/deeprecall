# ---------------------------------------------------------------------------
# THIRD-PARTY / NON-COMMERCIAL NOTICE
#
# The official token-F1 functions below (normalize_answer, f1_score, f1,
# official_score) are ported verbatim from snap-research/locomo
# (task_eval/evaluation.py), which is licensed CC BY-NC 4.0. That code is NOT
# covered by this repository's Apache-2.0 license; it is included solely for
# non-commercial reproduction of the LoCoMo benchmark. See the root NOTICE file.
# ---------------------------------------------------------------------------
#
# Scores a predictions file with TWO metrics:
#
# 1. OFFICIAL LoCoMo token-F1 — ported verbatim from the official repo
#    (snap-research/locomo, task_eval/evaluation.py). Category semantics
#    (verified against the paper's Table 5 counts and the eval code):
#      1 = multi-hop    -> multi-answer F1 (split pred+gold on commas, each gold
#                          item takes its best-matching pred item, mean over gold)
#      2 = temporal     -> token F1 (normalize + Porter stem)
#      3 = open-domain  -> token F1; gold truncated at the first ';'
#      4 = single-hop   -> token F1
#      5 = adversarial  -> 1 iff prediction contains "no information available"
#                          or "not mentioned" (official substring check; designed
#                          for the official two-option MCQ answer format — free-form
#                          abstentions that phrase it differently score 0)
#    The paper's official Overall includes all 5 categories; the memory-systems
#    literature (Mem0/Zep) reports cats 1-4 only. Both aggregates are printed.
#
# 2. LLM-judge accuracy (cats 1-4 only) — the common substitute metric.
#    ANTI-CHEATING: the judge prompt and model are LOCKED — one prompt for all
#    categories, no per-category tuning, never loosened between runs.
#    Verdicts are cached in the scored file keyed by (sample_id, question,
#    predicted) so unchanged predictions are never re-judged (deterministic,
#    zero spend).

import json
import os
import string
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import regex
from nltk.stem import PorterStemmer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import config  # noqa: E402

ps = PorterStemmer()

JUDGE_MODEL = "claude-opus-4-8"

JUDGE_PROMPT = """You are grading a memory system's answer against the gold answer.
Mark CORRECT if the predicted answer conveys the same factual information as the
gold answer (allow paraphrase, extra detail, and formatting differences). Mark
INCORRECT if it contradicts, omits, or fabricates the key fact. For questions the
gold answer marks as not answerable, a predicted answer that declines / says it
has no information is CORRECT.

Question: {q}
Gold answer: {gold}
Predicted answer: {pred}

Respond with exactly one word: CORRECT or INCORRECT."""

CATEGORY_NAMES = {1: "multi-hop", 2: "temporal", 3: "open-domain",
                  4: "single-hop", 5: "adversarial"}


def dump_atomic(obj, path) -> None:
    """Write via tmp + rename so a crash mid-checkpoint can't truncate the
    scored file (it doubles as the judge-verdict cache)."""
    tmp = f"{path}.tmp"
    json.dump(obj, open(tmp, "w"), indent=2)
    os.replace(tmp, path)


# ---- official metric, ported verbatim from task_eval/evaluation.py ----------

def normalize_answer(s):
    s = s.replace(',', "")

    def remove_articles(text):
        return regex.sub(r'\b(a|an|the|and)\b', ' ', text)

    def white_space_fix(text):
        return ' '.join(text.split())

    def remove_punc(text):
        exclude = set(string.punctuation)
        return ''.join(ch for ch in text if ch not in exclude)

    def lower(text):
        return text.lower()

    return white_space_fix(remove_articles(remove_punc(lower(s))))


def f1_score(prediction, ground_truth):
    prediction_tokens = [ps.stem(w) for w in normalize_answer(prediction).split()]
    ground_truth_tokens = [ps.stem(w) for w in normalize_answer(ground_truth).split()]
    common = Counter(prediction_tokens) & Counter(ground_truth_tokens)
    num_same = sum(common.values())
    if num_same == 0:
        return 0
    precision = 1.0 * num_same / len(prediction_tokens)
    recall = 1.0 * num_same / len(ground_truth_tokens)
    return (2 * precision * recall) / (precision + recall)


def f1(prediction, ground_truth):
    predictions = [p.strip() for p in prediction.split(',')]
    ground_truths = [g.strip() for g in ground_truth.split(',')]
    return np.mean([max([f1_score(prediction, gt) for prediction in predictions])
                    for gt in ground_truths])


def official_score(category, prediction, gold) -> float:
    """One QA pair -> official score in [0, 1], per task_eval/evaluation.py."""
    if prediction is None:
        return 0.0
    gold = str(gold)
    if category == 3:
        gold = gold.split(';')[0].strip()
    if category in (2, 3, 4):
        return float(f1_score(prediction, gold))
    if category == 1:
        return float(f1(prediction, gold))
    if category == 5:
        low = prediction.lower()
        return 1.0 if ('no information available' in low or 'not mentioned' in low) else 0.0
    raise ValueError(f"unknown category: {category}")


# ---- locked LLM judge (cats 1-4), with verdict cache -------------------------

def load_judge_cache(path) -> dict:
    """Verdicts from a prior scoring run, keyed by (sample_id, question, predicted).
    Keying on the predicted text guarantees changed predictions are re-judged."""
    if not os.path.exists(path):
        return {}
    cache = {}
    for p in json.load(open(path)):
        verdict = p.get("judge_correct", p.get("correct"))  # old runs used "correct"
        if verdict is None or p.get("category") not in (1, 2, 3, 4):
            continue
        cache[(p["sample_id"], p["question"], p["predicted"])] = bool(verdict)
    return cache


_client = None


def judge(q, gold, pred) -> bool:
    global _client
    if _client is None:
        from anthropic import Anthropic
        _client = Anthropic()  # reads ANTHROPIC_API_KEY
    msg = _client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=16,
        messages=[{"role": "user",
                   "content": JUDGE_PROMPT.format(q=q, gold=gold, pred=pred)}],
    )
    verdict = "".join(b.text for b in msg.content if b.type == "text").strip().upper()
    return verdict.startswith("CORRECT")


# ---- scoring run --------------------------------------------------------------

if __name__ == "__main__":
    predictions_file = str(config.PREDICTIONS_FILE)
    scored_file = str(config.SCORED_FILE)
    preds = json.load(open(predictions_file))
    # Reuse verdicts from the default scored file AND any prior run of this
    # file; keys include the predicted text, so changed answers always re-judge.
    cache = {**load_judge_cache(config.RESULTS_DIR / "scored.json"),
             **load_judge_cache(scored_file)}
    reused = judged = 0

    f1_by_cat = defaultdict(list)       # category -> [official scores]
    judge_by_cat = defaultdict(list)    # category (1-4) -> [bool]

    for p in preds:
        cat = p["category"]
        p["f1_official"] = round(official_score(cat, p["predicted"], p["gold"]), 3)
        f1_by_cat[cat].append(p["f1_official"])

        if cat in (1, 2, 3, 4):
            key = (p["sample_id"], p["question"], p["predicted"])
            if key in cache:
                p["judge_correct"] = cache[key]
                reused += 1
            elif p["predicted"] is None:
                p["judge_correct"] = False
            else:
                p["judge_correct"] = judge(p["question"], p["gold"], p["predicted"])
                judged += 1
                # Checkpoint fresh verdicts so a crash/529 mid-run resumes
                # from the cache instead of re-judging (verdicts unchanged;
                # not-yet-judged items lack judge_correct and are skipped by
                # the cache loader).
                if judged % 25 == 0:
                    dump_atomic(preds, scored_file)
            judge_by_cat[cat].append(p["judge_correct"])
        else:
            p["judge_correct"] = None   # cat 5 has no judge metric (official substring only)

    dump_atomic(preds, scored_file)

    print(f"\n{len(preds)} predictions scored "
          f"(judge verdicts: {reused} cached, {judged} fresh)\n")

    print("OFFICIAL token-F1 (task_eval/evaluation.py port):")
    for cat in sorted(f1_by_cat):
        scores = f1_by_cat[cat]
        print(f"  cat {cat} {CATEGORY_NAMES[cat]:<12}: {np.mean(scores):6.1%}  (n={len(scores)})")
    cat14 = [s for c in (1, 2, 3, 4) for s in f1_by_cat[c]]
    all5 = [s for c in sorted(f1_by_cat) for s in f1_by_cat[c]]
    print(f"  aggregate cats 1-4 (memory-literature convention): {np.mean(cat14):6.1%}  (n={len(cat14)})")
    print(f"  aggregate all 5    (paper official):               {np.mean(all5):6.1%}  (n={len(all5)})")

    print("\nLLM-JUDGE accuracy (locked prompt, cats 1-4 only):")
    ok14 = n14 = 0
    for cat in sorted(judge_by_cat):
        v = judge_by_cat[cat]
        ok, n = sum(v), len(v)
        ok14 += ok
        n14 += n
        print(f"  cat {cat} {CATEGORY_NAMES[cat]:<12}: {ok}/{n} = {ok/n:6.1%}")
    print(f"  aggregate cats 1-4: {ok14}/{n14} = {ok14/n14:6.1%}")
