"""Download locomo10.json from the official LoCoMo repository.

The dataset is licensed CC BY-NC 4.0 (Attribution-NonCommercial) —
see https://github.com/snap-research/locomo/blob/main/LICENSE.txt — so it is
NOT committed to this repository. Run this script once; the file lands next
to this script and is gitignored.
"""

import json
import urllib.request
from pathlib import Path

URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
DEST = Path(__file__).resolve().parent / "locomo10.json"

if __name__ == "__main__":
    if DEST.exists():
        print(f"{DEST} already exists — delete it first to re-download")
        raise SystemExit(0)
    print(f"downloading {URL} ...")
    with urllib.request.urlopen(URL, timeout=60) as r:
        raw = r.read()
    data = json.loads(raw)
    sample_ids = [s.get("sample_id") for s in data]
    if len(data) != 10 or "conv-26" not in sample_ids:
        raise SystemExit(f"unexpected dataset shape: {len(data)} samples, ids {sample_ids}")
    DEST.write_bytes(raw)
    print(f"wrote {DEST} ({len(raw):,} bytes, {len(data)} conversations: {' '.join(sample_ids)})")
