"""MemoryAdapter — the product-neutral interface every benchmarked memory
system implements.

The harness talks to products ONLY through this interface, so the dataset
rendering, questioning protocol, answer LLM call (in adapter mode), and
scoring are provably identical across products in a head-to-head run.
"""


class MemoryAdapter:
    name = "base"

    def purge(self, user_id: str) -> None:
        """Delete every memory for user_id and block until the deletion is
        complete (the next ingest must start from a verifiably empty store)."""
        raise NotImplementedError

    def ingest_session(
        self, user_id: str, content: str, occurred_at: str | None = None
    ) -> str:
        """Submit one conversation session for ingestion.

        content is the rendered session text (speaker-prefixed turns, photo
        captions inline); occurred_at is the session timestamp as an ISO-8601
        string with timezone, when the product supports one. Returns a
        submission id for logging.
        """
        raise NotImplementedError

    def wait_ready(self, user_id: str) -> int:
        """Block until asynchronous ingestion for user_id has settled.
        Returns the number of stored memories."""
        raise NotImplementedError

    def query(self, user_id: str, question: str, top_k: int) -> list[str]:
        """Retrieve the top_k memory contents relevant to the question,
        best-first. These strings are the answer model's only grounding in
        adapter mode."""
        raise NotImplementedError
