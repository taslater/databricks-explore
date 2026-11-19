"""What the Graph shows on a card besides its name: the grain, and the size and freshness read before. Never runs a query."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Optional

from . import grain, tablestats

MAX_TABLES = 100


def table_name(name) -> Optional[str]:
    """The name when it is a catalog.schema.table (not a placeholder), else None."""
    return name if isinstance(name, str) and name.count(".") == 2 and not name.startswith("ph:") else None


def facts(ex, tables: list[str], fetch: bool = True, now: Optional[datetime] = None) -> dict[str, dict]:
    """{table: {"grain": {...} or None, "stats": {...} or None}} for tables the Explorer can read; unreadable tables are left out.

    `fetch` reads a table's `tables.get` data when it is not cached (a REST call, never a warehouse); False uses only the cache."""
    now = now or datetime.now(timezone.utc)
    names = [t for t in dict.fromkeys(tables) if table_name(t)][:MAX_TABLES]

    def one(t):
        try:
            info = ex.object(t)["data"] if fetch else (ex.cached_object(t) or {}).get("data")
        except Exception:
            info = None
        cached = ex.cached_table_stats(t)
        if info is None and cached is None:
            return t, None
        return t, {"grain": grain.table_grain(info) if info else None, "stats": tablestats.summarize(cached, now) if cached else None}
    with ThreadPoolExecutor(max_workers=6) as pool:
        return {t: f for t, f in pool.map(one, names) if f is not None}
