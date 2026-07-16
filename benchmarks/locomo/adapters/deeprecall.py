"""Deep Recall adapter — /v1/ingest, /v1/query, /v1/memories/purge.

Also exposes answer_endpoint() (/v1/answer), Deep Recall's shipped
retrieve+answer path, used for our own headline runs (ANSWER_MODE=endpoint).
Head-to-head runs use the MemoryAdapter interface only.
"""

import time

import requests

from .base import MemoryAdapter


class DeepRecallAdapter(MemoryAdapter):
    name = "deeprecall"

    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url.rstrip("/")
        self.h = {"x-api-key": api_key, "Content-Type": "application/json"}

    def _request(self, method: str, path: str, **kw) -> requests.Response:
        """Request with retry on transient failures (network, 5xx, 429).

        Ingest and polling calls run for hours across thousands of requests —
        one transient error must not kill a run whose only recovery is a full
        purge + re-ingest. 4xx (except 429) returns immediately for the caller
        to handle. NOT used for query/answer_endpoint: there the harness owns
        retry policy, and the latency probe must measure single calls.
        """
        last = None
        for attempt in range(5):
            try:
                r = requests.request(
                    method, f"{self.api_url}{path}", headers=self.h, **kw
                )
            except requests.RequestException as e:
                last = f"network: {e}"
            else:
                if r.status_code < 500 and r.status_code != 429:
                    return r
                last = f"{r.status_code}: {r.text[:200]}"
            if attempt < 4:
                time.sleep(min(2 * 2**attempt, 30))
        raise RuntimeError(f"{method} {path} failed after 5 attempts: {last}")

    # ---- MemoryAdapter interface -------------------------------------------

    def purge(self, user_id: str) -> None:
        r = self._request(
            "POST",
            "/v1/memories/purge",
            json={"scope": {"user_id": user_id}, "confirm": True},
            timeout=30,
        )
        r.raise_for_status()
        job = r.json()["job_id"]
        for _ in range(40):
            s = self._request(
                "GET", f"/v1/memories/purge/status/{job}", timeout=30
            ).json()
            if s["status"] == "completed":
                return
            if s["status"] == "failed":
                raise RuntimeError(f"purge failed for {user_id}: {s}")
            time.sleep(5)
        raise RuntimeError(f"purge timed out for {user_id}")

    def ingest_session(
        self, user_id: str, content: str, occurred_at: str | None = None
    ) -> str:
        payload = {
            "content": content,
            "scope": {"user_id": user_id},
            "source_channel": "chat",
        }
        if occurred_at:
            payload["occurred_at"] = occurred_at
        r = self._request("POST", "/v1/ingest", json=payload, timeout=30)
        r.raise_for_status()
        return r.json()["instance_id"]

    def wait_ready(
        self,
        user_id: str,
        poll_seconds: int = 30,
        stable_polls: int = 3,
        max_polls: int = 60,
    ) -> int:
        """Ingestion is async (Cloudflare Workflows). Ready = active-memory
        count stable and non-zero across stable_polls consecutive polls.
        For multi-user batches prefer harness/ingest.py's batch wait, which
        gates on the aggregate count."""
        prev, stable = -1, 0
        for _ in range(max_polls):
            n = self.count_active(user_id)
            if n == prev and n > 0:
                stable += 1
                if stable >= stable_polls:
                    return n
            else:
                stable = 0
            prev = n
            time.sleep(poll_seconds)
        raise RuntimeError(f"store for {user_id} never stabilized (last count {prev})")

    def query(self, user_id: str, question: str, top_k: int) -> list[str]:
        r = requests.post(
            f"{self.api_url}/v1/query",
            headers=self.h,
            json={
                "query": question,
                "scope": {"user_id": user_id},
                "mode": "recall",
                "top_k": top_k,
            },
            timeout=90,
        )
        r.raise_for_status()
        # /v1/query items are {memory: {...}, score}; /v1/memories items are
        # flat memory objects.
        return [m["memory"]["content"] for m in r.json()["memories"]]

    # ---- Deep Recall extras (not part of the head-to-head interface) -------

    def answer_endpoint(
        self, user_id: str, question: str, top_k: int, max_tokens: int
    ) -> requests.Response:
        """POST /v1/answer — the shipped retrieval+answer pipeline. Returns the
        raw Response; the caller owns retry/backoff policy."""
        return requests.post(
            f"{self.api_url}/v1/answer",
            headers=self.h,
            json={
                "question": question,
                "scope": {"user_id": user_id},
                "mode": "recall",  # hold fixed across runs
                "top_k": top_k,
                "max_tokens": max_tokens,
            },
            timeout=90,
        )

    def count_active(self, user_id: str) -> int:
        return sum(1 for _ in self.iter_active(user_id))

    def iter_active(self, user_id: str):
        """Yield every active memory for user_id (cursor-paginated)."""
        cursor = None
        while True:
            params = {"user_id": user_id, "status": "active", "limit": 100}
            if cursor:
                params["cursor"] = cursor
            r = self._request("GET", "/v1/memories", params=params, timeout=30)
            r.raise_for_status()
            d = r.json()
            batch = d.get("memories", [])
            yield from batch
            cursor = d.get("cursor")
            if not cursor or not batch:
                return
