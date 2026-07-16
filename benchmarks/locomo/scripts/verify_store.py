"""Post-ingest verification gates — run BEFORE answering, so a silently lossy
import can never produce a published number (the failure mode that originally
cost ~43% of held-out sessions to Vectorize rate limiting).

Usage (from benchmarks/locomo/):
    python scripts/verify_store.py count conv-26 conv-30 ...   # per-conv counts
    python scripts/verify_store.py count --expect-zero conv-26 ...  # exits 1 unless all 0
    python scripts/verify_store.py gates conv-26 conv-30 ...   # all gates

Gates (each prints PASS/FAIL; any FAIL exits non-zero):
  1. counts        — every conv non-empty; total >= MIN_TOTAL (env, default 2400)
  2. workflows     — 0 errored ingestion workflow instances since RUN_STARTED_AT
                     (wrangler; Deep-Recall-specific, SKIP_WRANGLER=1 to skip)
  3. dead-letters  — 0 ingestion dead letters (GET /admin/dead-letters, ADMIN_KEY)
  4. needles       — previously-lost facts present (proper-noun + caption cases)
  5. vectors       — sampled memory ids exist in Vectorize (no D1-only ghosts)

Env: API_URL, API_KEY (always); ADMIN_KEY (gate 3); CLOUDFLARE_ACCOUNT_ID +
repo checkout (gates 2/5); RUN_STARTED_AT (ISO, filters historical noise);
WORKFLOW_NAME, VECTORIZE_INDEX, WRANGLER overrides.
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters import get_adapter  # noqa: E402
from harness import config  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
WRANGLER = os.environ.get("WRANGLER", "pnpx wrangler")
WRANGLER_ENV = os.environ.get("WRANGLER_ENV", "dev")
WORKFLOW_NAME = os.environ.get("WORKFLOW_NAME", "deeprecall-ingestion-workflow-dev")
VECTORIZE_INDEX = os.environ.get("VECTORIZE_INDEX", "deeprecall-vectors-default-dev")
MIN_TOTAL = int(os.environ.get("MIN_TOTAL", "2400"))
RUN_STARTED_AT = os.environ.get("RUN_STARTED_AT", "")

# Previously-lost facts, verified live when the fixes shipped: the proper-noun
# extraction rule (conv-43 s26) and caption rendering (conv-26 s8).
NEEDLES = [
    ("conv-43", "wheel of time", "proper-noun rule: 'that show' -> named series"),
    ("conv-26", "dog face", "caption rendering: fact exists only in a photo caption"),
]


def parse_ts(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def run_wrangler(args: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        f"{WRANGLER} {args}", shell=True, cwd=cwd, capture_output=True, text=True
    )


def gate_counts(adapter, sample_ids: list[str]) -> tuple[bool, dict]:
    counts = {sid: adapter.count_active(f"locomo-{sid}") for sid in sample_ids}
    total = sum(counts.values())
    empty = [sid for sid, n in counts.items() if n == 0]
    print("  " + " ".join(f"{sid}={n}" for sid, n in counts.items()) + f" total={total}")
    ok = not empty and total >= MIN_TOTAL
    if empty:
        print(f"  EMPTY convs: {empty}")
    if total < MIN_TOTAL:
        print(f"  total {total} < MIN_TOTAL {MIN_TOTAL}")
    return ok, counts


def row_timestamp(row: str) -> datetime | None:
    """Extract a timestamp from a wrangler table row. Wrangler prints
    toLocaleString() dates in the LOCAL timezone; ISO strings are also
    handled. None = unparseable."""
    m = re.search(r"\d{1,2}/\d{1,2}/\d{4},? \d{1,2}:\d{2}:\d{2}\s?(?:AM|PM)?", row)
    if m:
        for fmt in ("%m/%d/%Y, %I:%M:%S %p", "%m/%d/%Y %I:%M:%S %p",
                    "%m/%d/%Y, %H:%M:%S", "%m/%d/%Y %H:%M:%S"):
            try:
                local_tz = datetime.now().astimezone().tzinfo
                return datetime.strptime(m.group(0), fmt).replace(tzinfo=local_tz)
            except ValueError:
                continue
    m = re.search(r"\d{4}-\d{2}-\d{2}T[\d:.]+Z?", row)
    if m:
        return parse_ts(m.group(0))
    return None


def gate_workflows() -> bool:
    if os.environ.get("SKIP_WRANGLER") == "1":
        print("  SKIPPED (SKIP_WRANGLER=1)")
        return True
    cwd = REPO_ROOT / "workers" / "ingestion"
    r = run_wrangler(
        f"workflows instances list {WORKFLOW_NAME} --env {WRANGLER_ENV} --status errored",
        cwd,
    )
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0:
        print(f"  wrangler failed: {out.strip()[:300]}")
        return False
    if re.search(r"no instances|there are no", out, re.I):
        print("  0 errored instances")
        return True
    # Wrangler has no JSON output for this command — parse table rows. A row
    # is an errored instance if it carries the status; instances outside the
    # RUN_STARTED_AT window are excluded ONLY when their timestamp parses.
    # Unparseable timestamps are KEPT (fail-strict): a false FAIL costs an
    # inspection, a false PASS costs a published number on a lossy import.
    rows = [ln for ln in out.splitlines() if "errored" in ln.lower()]
    since = parse_ts(RUN_STARTED_AT)
    if since:
        rows = [ln for ln in rows if (t := row_timestamp(ln)) is None or t >= since]
    print(f"  {len(rows)} errored instances"
          + (f" since {RUN_STARTED_AT}" if since
             else " (all time — set RUN_STARTED_AT to scope)"))
    for ln in rows[:10]:
        print(f"    {ln.strip()[:160]}")
    return len(rows) == 0


def gate_dead_letters() -> bool:
    if not config.ADMIN_KEY:
        print("  FAIL: ADMIN_KEY not set (required for /admin/dead-letters)")
        return False
    import requests

    r = requests.get(
        f"{config.API_URL}/admin/dead-letters",
        headers={"x-admin-key": config.ADMIN_KEY},
        params={"limit": 200},
        timeout=30,
    )
    if r.status_code != 200:
        print(f"  FAIL: {r.status_code}: {r.text[:200]}")
        return False
    entries = r.json().get("entries", [])
    since = parse_ts(RUN_STARTED_AT)
    if since:
        # Entries carry first_failed_at/last_failed_at; unparseable stays in
        # (fail-strict).
        entries = [
            e
            for e in entries
            if (c := parse_ts(str(e.get("last_failed_at")
                                  or e.get("first_failed_at") or ""))) is None
            or c >= since
        ]
    print(f"  {len(entries)} dead letters" + (f" since {RUN_STARTED_AT}" if since else ""))
    for e in entries[:5]:
        print(f"    {json.dumps(e)[:200]}")
    return len(entries) == 0


def gate_needles(adapter) -> bool:
    ok = True
    for sid, needle, why in NEEDLES:
        memories = list(adapter.iter_active(f"locomo-{sid}"))
        hits = [m["content"] for m in memories if needle in m["content"].lower()]
        if hits:
            print(f"  PASS [{sid}] '{needle}': {hits[0][:100]}")
        else:
            ok = False
            print(f"  FAIL [{sid}] '{needle}' missing ({why}); {len(memories)} memories searched")
    return ok


def gate_vectors(adapter, sample_ids: list[str]) -> bool:
    if os.environ.get("SKIP_WRANGLER") == "1":
        print("  SKIPPED (SKIP_WRANGLER=1)")
        return True
    # Sample from the first and last convs of the set; 20 ids = the
    # get-vectors per-call maximum.
    ids = []
    for sid in dict.fromkeys([sample_ids[0], sample_ids[-1]]):
        conv_ids = [m["id"] for m in adapter.iter_active(f"locomo-{sid}")]
        ids.extend(conv_ids[:10])
    ids = ids[:20]
    if not ids:
        print("  FAIL: no memory ids to sample")
        return False
    env_note = "" if os.environ.get("CLOUDFLARE_ACCOUNT_ID") else " (CLOUDFLARE_ACCOUNT_ID not set — may fail)"

    def check(id_list):
        r = run_wrangler(
            f"vectorize get-vectors {VECTORIZE_INDEX} --ids {' '.join(id_list)}",
            REPO_ROOT,
        )
        if r.returncode != 0:
            raise RuntimeError(f"wrangler failed{env_note}: {r.stderr.strip()[:300]}")
        return [i for i in id_list if i not in r.stdout]

    try:
        missing = check(ids)
        if missing:
            # Vectorize indexing is asynchronous — vectors upserted minutes ago
            # may not be readable yet. One re-check separates indexing lag from
            # genuine D1-only ghosts (lost writes).
            wait = int(os.environ.get("VECTOR_RECHECK_SECONDS", "300"))
            print(f"  {len(missing)}/{len(ids)} not yet visible — re-checking in {wait}s (async indexing)")
            import time

            time.sleep(wait)
            missing = check(missing)
    except RuntimeError as e:
        print(f"  {e}")
        return False
    print(f"  {len(ids) - len(missing)}/{len(ids)} sampled vectors present")
    for i in missing:
        print(f"    MISSING (D1-only ghost): {i}")
    return not missing


def main() -> None:
    args = sys.argv[1:]
    expect_zero = "--expect-zero" in args
    args = [a for a in args if a != "--expect-zero"]
    if len(args) < 2 or args[0] not in ("count", "gates"):
        raise SystemExit(__doc__)
    cmd, sample_ids = args[0], args[1:]
    adapter = get_adapter()

    if cmd == "count":
        counts = {sid: adapter.count_active(f"locomo-{sid}") for sid in sample_ids}
        total = sum(counts.values())
        print(" ".join(f"{sid}={n}" for sid, n in counts.items()) + f" total={total}")
        if expect_zero and total > 0:
            raise SystemExit("expected all counts to be 0 — purge incomplete")
        return

    results = {}
    print("[1/5] per-conv counts")
    results["counts"], _ = gate_counts(adapter, sample_ids)
    print("[2/5] errored ingestion workflows")
    results["workflows"] = gate_workflows()
    print("[3/5] ingestion dead letters")
    results["dead_letters"] = gate_dead_letters()
    print("[4/5] previously-lost fact needles")
    results["needles"] = gate_needles(adapter)
    print("[5/5] vector existence sample")
    results["vectors"] = gate_vectors(adapter, sample_ids)

    print()
    for name, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not all(results.values()):
        raise SystemExit("VERIFICATION GATES FAILED — do not run the answer stage")
    print("ALL GATES PASS")


if __name__ == "__main__":
    main()
