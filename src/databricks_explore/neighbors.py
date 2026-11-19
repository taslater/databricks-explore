"""What the Graph knows about the objects next to the one it reads: their real kind, whether they exist, and whether a lineage edge still holds."""
import re
from datetime import datetime, timezone
from typing import Optional

try:
    from databricks.sdk.errors import NotFound
except ImportError:  # an SDK without the class: the message decides
    NotFound = ()

# The lineage API's table types (lowercased) to the kinds the Graph colors; the tables API's are used as they are.
_KINDS = {"persisted_view": "view", "view": "view", "materialized_view": "materialized_view", "metric_view": "metric_view",
          "streaming_table": "streaming_table", "table": "table", "managed": "table", "external": "table",
          "foreign": "table", "managed_shallow_clone": "table", "external_shallow_clone": "table"}
CREATED_SLACK = 60  # seconds an event may precede the target's created_at and still belong to it (live: a CTAS's event was 0.3 s before it)
_NOT_FOUND = re.compile(r"does not exist|not[ _]found|no such", re.I)


def normalize_kind(table_type: Optional[str]) -> str:
    """The Graph's kind for a table type from either API: PERSISTED_VIEW is a view, MANAGED and EXTERNAL are tables.

    An unknown type is returned lowercased, and a missing one is "table"."""
    t = (table_type or "table").lower()
    return _KINDS.get(t, t)


def kind_of(table_type: Optional[str], guess: Optional[str] = None) -> str:
    """The kind to draw: the object's own table type (tables API, lowercased as the picker shows it), else the
    normalized lineage-API type `guess`."""
    if table_type:
        return normalize_kind(table_type) if table_type.lower() == "persisted_view" else table_type.lower()
    return normalize_kind(guess)


def parse_ts(value) -> Optional[datetime]:
    """A lineage timestamp ("2026-10-26 14:02:52.0", UTC, or ISO) or an epoch in milliseconds, as an aware datetime; None when unreadable."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
    if not isinstance(value, str) or not value:
        return None
    s = value.strip().replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def view_sources(info: Optional[dict]) -> set:
    """The lowercased names a view's current definition reads (tables.get `view_dependencies`); empty when it lists none.

    A materialized view lists only its internal backing table (`__materialization_...`), which says nothing about its
    sources, so internal names are left out."""
    deps = ((info or {}).get("view_dependencies") or {}).get("dependencies") or []
    return {t.lower() for d in deps if (t := (d.get("table") or {}).get("table_full_name")) and not t.split(".")[-1].startswith("__")}


def is_superseded(source: str, ts, target_info: Optional[dict]) -> bool:
    """Whether the lineage edge source -> target, last seen at `ts`, no longer holds.

    A target that lists view dependencies is judged by them: a source it does not name is superseded. Any other target
    is judged by its creation time: an event from before the object was (re)created describes an earlier one.
    The comparison allows `CREATED_SLACK` seconds: lineage times are whole seconds, and a CTAS's event can come before its table is committed.
    Without `target_info`, or a time to compare, the edge is kept. Age alone never makes an edge superseded."""
    if not target_info:
        return False
    deps = view_sources(target_info)
    if deps:
        return source.lower() not in deps
    created, seen = parse_ts(target_info.get("created_at")), parse_ts(ts)
    return bool(created and seen and (created - seen).total_seconds() > CREATED_SLACK)


def is_not_found(exc: Exception) -> bool:
    """Whether a tables.get failure means the object (or its schema or catalog) does not exist, not that it is unreadable."""
    return (bool(NotFound) and isinstance(exc, NotFound)) or bool(_NOT_FOUND.search(str(exc)))


def missing_reason(name: str, message: str, catalogs=None, schemas=None) -> str:
    """Why `name` is not there: its catalog, its schema or the table. `catalogs` and `schemas` are the cached lists, when known."""
    cat, sch, _ = name.split(".", 2)
    said = lambda word: re.search(rf"{word}[ _].{{0,60}}?(does not exist|not[ _]found)", message, re.I)  # noqa: E731
    if said("catalog") or (catalogs is not None and cat.lower() not in catalogs):
        return f"catalog `{cat}` does not exist"
    if said("schema") or (schemas is not None and sch.lower() not in schemas):
        return f"schema `{cat}.{sch}` does not exist"
    return f"table `{name}` does not exist"
