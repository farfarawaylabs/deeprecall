import os


def get_adapter():
    """Instantiate the adapter named by the ADAPTER env var (default deeprecall)."""
    name = os.environ.get("ADAPTER", "deeprecall")
    if name == "deeprecall":
        from harness import config

        config.require_api()
        from .deeprecall import DeepRecallAdapter

        return DeepRecallAdapter(config.API_URL, config.API_KEY)
    raise SystemExit(f"unknown adapter: {name}")
