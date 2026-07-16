"""Env-driven configuration for the LoCoMo harness.

Every knob is an environment variable so runs are reproducible from a shell
one-liner and nothing product-specific (URLs, keys) is committed.

The HEADLINE configuration is locked: TOP_K=10, mode=recall, answer model
held fixed. Other values are allowed only for clearly-labeled diagnostic
rows (e.g. the k=30 product-default-config row) — see ../README.md.
"""

import os
from pathlib import Path

LOCOMO_DIR = Path(__file__).resolve().parents[1]

# Dataset (fetched by data/fetch_data.py; never committed — CC BY-NC 4.0).
DATA_FILE = Path(os.environ.get("DATA_FILE", LOCOMO_DIR / "data" / "locomo10.json"))

# Run artifacts.
RESULTS_DIR = Path(os.environ.get("RESULTS_DIR", LOCOMO_DIR / "results"))
PREDICTIONS_FILE = Path(
    os.environ.get("PREDICTIONS_FILE", RESULTS_DIR / "predictions.json")
)
SCORED_FILE = Path(os.environ.get("SCORED_FILE", RESULTS_DIR / "scored.json"))

# Product under test (consumed by the adapter).
API_URL = os.environ.get("API_URL", "").rstrip("/")
API_KEY = os.environ.get("API_KEY", "")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "")  # verification gates only

# Benchmark parameters.
TOP_K = int(os.environ.get("TOP_K", "10"))  # 10 = locked headline config
# Which samples to process: "all", or a "start:stop" slice of locomo10.json
# (e.g. "0:1" = conv-26 only). Ingest and answer must use matching subsets.
SAMPLES = os.environ.get("SAMPLES", "all")

# Answer stage.
#   endpoint — the product's own retrieve+answer path (Deep Recall /v1/answer).
#              Used for Deep Recall headline runs: it is the shipped pipeline.
#   adapter  — the harness retrieves top_k memories via the MemoryAdapter and
#              makes the answer LLM call itself: same model, same prompt, same
#              max_tokens for every product. The head-to-head mode.
ANSWER_MODE = os.environ.get("ANSWER_MODE", "endpoint")
ADAPTER = os.environ.get("ADAPTER", "deeprecall")
ANSWER_MODEL = os.environ.get("ANSWER_MODEL", "claude-sonnet-5")
# Sonnet 5 runs adaptive thinking by default and thinking tokens count against
# max_tokens; small caps can be consumed before any answer text is emitted.
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "4096"))


def require_api() -> None:
    missing = [n for n, v in (("API_URL", API_URL), ("API_KEY", API_KEY)) if not v]
    if missing:
        raise SystemExit(f"Missing required env: {', '.join(missing)}")


def load_samples():
    """Load the dataset and apply the SAMPLES slice."""
    import json

    if not DATA_FILE.exists():
        raise SystemExit(
            f"{DATA_FILE} not found — run `python data/fetch_data.py` first"
        )
    data = json.load(open(DATA_FILE))
    if SAMPLES == "all":
        return data
    start, _, stop = SAMPLES.partition(":")
    return data[int(start) : int(stop or int(start) + 1)]
