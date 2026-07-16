"""Timed /v1/query probe: p50/p95 over 20 recall queries against the dev-conv
store. Run twice back-to-back; the first pass is warm-up (isolates cold
starts) and the second pass is the reported number.

Usage: API_URL=... API_KEY=... python scripts/latency_probe.py
"""

import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters import get_adapter  # noqa: E402
from harness import config  # noqa: E402

USER_ID = "locomo-conv-26"
QUERIES = [
    "What pets does Melanie have?",
    "When did Caroline attend the pride parade?",
    "What career is Caroline considering?",
    "Where did Melanie go camping in June?",
    "What does Caroline plan to do about adoption?",
    "What did Melanie paint recently?",
    "How many kids does Melanie have?",
    "What is Caroline's art show about?",
    "What does Melanie find relaxing?",
    "Who supported Caroline during her transition?",
    "What happened at the talent show?",
    "What did Melanie do at the beach?",
    "When did Melanie sign up for the pottery class?",
    "What books is Caroline collecting?",
    "What was Melanie's most memorable camping trip?",
    "What did Caroline do after the road trip?",
    "What group does Caroline volunteer with?",
    "What is Melanie swamped with?",
    "What flowers did Melanie find?",
    "What shoes did Melanie buy?",
]


def probe(adapter) -> None:
    times = []
    for q in QUERIES:
        t0 = time.perf_counter()
        adapter.query(USER_ID, q, config.TOP_K)
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    print(
        f"n={len(times)} k={config.TOP_K} p50={statistics.median(times):.0f}ms "
        f"p95={times[int(len(times) * 0.95) - 1]:.0f}ms "
        f"min={times[0]:.0f} max={times[-1]:.0f}"
    )


if __name__ == "__main__":
    adapter = get_adapter()
    probe(adapter)  # warm-up pass
    probe(adapter)  # reported pass
