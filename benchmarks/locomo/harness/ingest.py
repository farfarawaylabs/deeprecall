"""Ingest LoCoMo conversations into the memory system under test.

Session rendering follows the OFFICIAL LoCoMo protocol: speaker-prefixed
turns with shared-photo captions inline — many QA golds exist only in a
caption. The session timestamp is passed to the adapter as occurred_at so
products that support temporal anchoring can resolve relative dates.

Usage (from benchmarks/locomo/):
    SAMPLES=0:1 python harness/ingest.py          # submit conv-26 only
    SAMPLES=1:4 INGEST_WAIT=1 python harness/ingest.py   # submit + wait stable

INGEST_WAIT=1 polls the aggregate active-memory count for the batch until it
is stable (ingestion is asynchronous) — required between batches in a full
run so concurrent imports don't trample rate limits.
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters import get_adapter  # noqa: E402
from harness import config  # noqa: E402

# Batch-wait tuning (INGEST_WAIT=1). Defaults match the run that produced a
# clean 2,547-memory import: 60s polls, no stability verdict before poll 15,
# 3 consecutive stable polls to pass.
POLL_SECONDS = int(os.environ.get("INGEST_POLL_SECONDS", "60"))
MIN_POLLS = int(os.environ.get("INGEST_MIN_POLLS", "15"))
STABLE_POLLS = int(os.environ.get("INGEST_STABLE_POLLS", "3"))
MAX_POLLS = int(os.environ.get("INGEST_MAX_POLLS", "90"))


def user_id_for(sample_id: str) -> str:
    return f"locomo-{sample_id}"


def sessions_in_order(conv: dict) -> list[str]:
    """Discover session_1, session_2, ... in numeric order."""
    keys = [k for k in conv if re.fullmatch(r"session_\d+", k)]
    return sorted(keys, key=lambda k: int(k.split("_")[1]))


def render_session(conv: dict, skey: str) -> str:
    when = conv.get(f"{skey}_date_time", "")
    lines = [f"[Conversation on {when}]"] if when else []
    for turn in conv[skey]:
        # Official protocol includes shared-photo captions in the conversation
        # text. Captions already read "a photo of ..." so render as
        # [shares <caption>].
        photo = f" [shares {turn['blip_caption']}]" if turn.get("blip_caption") else ""
        lines.append(f"{turn['speaker']}: {turn['text']}{photo}")
    return "\n".join(lines)


def occurred_at_for(conv: dict, skey: str) -> str | None:
    """LoCoMo session headers look like '1:56 pm on 8 May, 2023' -> ISO UTC."""
    when = conv.get(f"{skey}_date_time", "")
    try:
        dt = datetime.strptime(when, "%I:%M %p on %d %B, %Y")
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def ingest_sample(adapter, sample: dict) -> list[str]:
    conv = sample["conversation"]
    uid = user_id_for(sample["sample_id"])
    instance_ids = []
    for skey in sessions_in_order(conv):
        content = render_session(conv, skey)
        if not content.strip():
            continue
        instance_ids.append(
            adapter.ingest_session(uid, content, occurred_at_for(conv, skey))
        )
        time.sleep(0.2)  # be gentle on the pipeline
    return instance_ids


def wait_batch_stable(adapter, uids: list[str]) -> None:
    """Poll the batch's aggregate active count until it is stable non-zero."""
    prev, stable = None, 0
    for i in range(1, MAX_POLLS + 1):
        counts = {u: adapter.count_active(u) for u in uids}
        total = sum(counts.values())
        pretty = " ".join(f"{u.removeprefix('locomo-')}={n}" for u, n in counts.items())
        print(f"{time.strftime('%H:%M:%S')} {pretty} total={total}")
        if total == prev and total > 0 and i >= MIN_POLLS:
            stable += 1
            if stable >= STABLE_POLLS:
                print(f"batch STABLE at {total} memories")
                return
        else:
            stable = 0
        prev = total
        time.sleep(POLL_SECONDS)
    raise SystemExit(f"batch never stabilized after {MAX_POLLS} polls (last {prev})")


if __name__ == "__main__":
    data = config.load_samples()
    adapter = get_adapter()
    all_instances = {}
    for sample in data:
        ids = ingest_sample(adapter, sample)
        all_instances[sample["sample_id"]] = ids
        print(f"{sample['sample_id']}: submitted {len(ids)} sessions")
    config.RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    instances_file = config.RESULTS_DIR / "instances.json"
    json.dump(all_instances, open(instances_file, "w"), indent=2)
    print(f"submission ids -> {instances_file}")
    if os.environ.get("INGEST_WAIT") == "1":
        wait_batch_stable(adapter, [user_id_for(s["sample_id"]) for s in data])
