"""Table size and freshness from DESCRIBE DETAIL and DESCRIBE HISTORY: the statements, what counts as a write, cadence and lateness."""
import json
import statistics
from typing import Callable, Optional

from . import neighbors

HISTORY_LIMIT = 50
CADENCE_WRITES = 10  # the median gap is taken over this many of the latest writes
MIN_WRITES = 3  # fewer writes than this give no cadence
LATE_FACTOR = 2  # late: more than twice the cadence since the last write ...
LATE_MIN_SECONDS = 3600  # ... and more than an hour
STRIP_WRITES = 20  # rows written per write, as many as the Details bar strip shows
# Operations that change the table's data. OPTIMIZE, VACUUM and property or tag changes are not here: they add no data.
WRITE_OPS = frozenset({"WRITE", "MERGE", "UPDATE", "DELETE", "STREAMING UPDATE", "CREATE TABLE AS SELECT",
                       "CREATE OR REPLACE TABLE AS SELECT", "REPLACE TABLE AS SELECT", "COPY INTO", "TRUNCATE"})
_REPLACE_OPS = frozenset({"CREATE TABLE AS SELECT", "CREATE OR REPLACE TABLE AS SELECT", "REPLACE TABLE AS SELECT"})


def quoted(full_name: str) -> str:
    """A dotted full name with each part in backticks, for a statement."""
    return ".".join("`" + part.replace("`", "``") + "`" for part in full_name.split("."))


def statements(full_name: str) -> list[dict]:
    """The two statements read for one table: [{"name": "detail"|"history", "sql"}]."""
    q = quoted(full_name)
    return [{"name": "detail", "sql": f"DESCRIBE DETAIL {q}"}, {"name": "history", "sql": f"DESCRIBE HISTORY {q} LIMIT {HISTORY_LIMIT}"}]


def skip_reason(info: dict) -> Optional[str]:
    """Why a table (its `tables.get` data) has no size and history to read, or None when it does."""
    kind = str(info.get("table_type") or "").upper()
    if kind in ("VIEW", "METRIC_VIEW", "MATERIALIZED_VIEW"):  # DESCRIBE DETAIL answers EXPECT_TABLE_NOT_VIEW for all three
        return {"METRIC_VIEW": "a metric view has no history", "MATERIALIZED_VIEW": "a materialized view has no size to read"}.get(kind, "a view has no size")
    fmt = str(info.get("data_source_format") or "").upper()
    if fmt and fmt != "DELTA":
        return f"not a Delta table ({fmt.lower()})"
    return None


def _json(value) -> dict:
    if isinstance(value, dict):
        return value
    try:
        out = json.loads(value) if isinstance(value, str) and value else {}
    except ValueError:
        return {}
    return out if isinstance(out, dict) else {}


def _int(value) -> Optional[int]:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _is_replace(operation: str, params: dict) -> bool:
    """Whether the write replaced the whole table: a CTAS, an overwrite, or a complete-mode streaming update."""
    if operation in _REPLACE_OPS:
        return True
    mode = str(params.get("mode") or params.get("outputMode") or "").lower()
    return (operation == "WRITE" and mode == "overwrite") or (operation == "STREAMING UPDATE" and mode == "complete")


def data_writes(history: list[dict]) -> list[dict]:
    """The data writes in DESCRIBE HISTORY rows, newest first, each {"at", "operation", "rows", "replaces", "job", "job_id", "notebook", "user"}."""
    out = []
    for h in history:
        op = str(h.get("operation") or "").upper()
        at = neighbors.parse_ts(h.get("timestamp"))
        if op not in WRITE_OPS or at is None:
            continue
        job, notebook = _json(h.get("job")), _json(h.get("notebook"))
        out.append({"at": at.isoformat(timespec="seconds"), "operation": op,
                    "rows": _int(_json(h.get("operationMetrics")).get("numOutputRows")),
                    "replaces": _is_replace(op, _json(h.get("operationParameters"))),
                    "job": job.get("jobName") or job.get("jobId") or None, "job_id": job.get("jobId") or None,
                    "notebook": notebook.get("notebookId") or None, "user": h.get("userName") or None})
    out.sort(key=lambda w: w["at"], reverse=True)
    return out


def read(sql: Callable, full_name: str) -> dict:
    """Run both statements through `sql` (Explorer.sql) and keep what the card and Details need. Raises when DESCRIBE DETAIL does."""
    detail_sql, history_sql = (s["sql"] for s in statements(full_name))
    detail = (sql(detail_sql) or [{}])[0]
    try:
        writes, history_error = data_writes(sql(history_sql)), None
    except Exception as e:  # size is still worth keeping when the history cannot be read
        writes, history_error = [], str(e)[:300]
    return {"bytes": _int(detail.get("sizeInBytes")), "files": _int(detail.get("numFiles")),
            "clustering": _json_list(detail.get("clusteringColumns")), "partitioning": _json_list(detail.get("partitionColumns")),
            "writes": writes, "history_error": history_error}


def _json_list(value) -> list:
    if isinstance(value, list):
        return value
    try:
        out = json.loads(value) if isinstance(value, str) and value else []
    except ValueError:
        return []
    return out if isinstance(out, list) else []


def cadence_seconds(writes: list[dict]) -> Optional[float]:
    """The median gap in seconds between the latest writes, None with fewer than MIN_WRITES."""
    times = sorted(neighbors.parse_ts(w["at"]).timestamp() for w in writes[:CADENCE_WRITES])
    if len(times) < MIN_WRITES:
        return None
    return statistics.median(b - a for a, b in zip(times, times[1:]))


def is_late(since_seconds: float, cadence: Optional[float]) -> bool:
    """Late against the table's own rhythm: no write for more than twice its cadence and more than an hour."""
    return cadence is not None and since_seconds > LATE_FACTOR * cadence and since_seconds > LATE_MIN_SECONDS


def row_count(writes: list[dict]) -> Optional[int]:
    """The table's rows when the latest write replaced it and nothing has changed it since; otherwise unknown."""
    if writes and writes[0]["replaces"]:
        return writes[0]["rows"]
    return None


def summarize(cached: dict, now) -> dict:
    """What the page and the agent tools read, from a cache file ({"fetched_at", "data"}) and the current time (aware datetime)."""
    data, writes = cached["data"], cached["data"].get("writes") or []
    last = writes[0] if writes else None
    cadence = cadence_seconds(writes)
    since = (now - neighbors.parse_ts(last["at"])).total_seconds() if last else None
    return {"fetched_at": cached.get("fetched_at"), "bytes": data.get("bytes"), "files": data.get("files"),
            "rows": row_count(writes), "clustering": data.get("clustering") or [], "partitioning": data.get("partitioning") or [],
            "last_write": {k: last[k] for k in ("at", "operation", "rows", "job", "notebook", "user")} if last else None,
            "cadence_seconds": cadence, "late": since is not None and is_late(since, cadence),
            "writes": [{"at": w["at"], "rows": w["rows"]} for w in reversed(writes[:STRIP_WRITES])],
            "history_error": data.get("history_error")}
