"""What happens to the data on a flow edge: the SQL behind it (a view's definition, or the statement that wrote the table) read for aggregate, join, union, dedupe and filter."""
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import Callable, Optional

from . import neighbors, nodefacts, sqltools

MAX_TARGETS = 100
SQL_CHARS = 20000  # a statement longer than this is cut when read, and then probably does not parse
REDACTED = "<REDACTED>"
FLOW_KINDS = ("view_dep", "lineage")

# The latest writes of a table, with the statement text when a SQL statement made them. The same shape in demo mode.
STATEMENT_SQL = (
    "SELECT l.statement_id, l.entity_type, l.entity_id, l.event_time, h.statement_type, h.executed_by,\n"
    f"       left(h.statement_text, {SQL_CHARS}) AS statement_text\n"
    "FROM system.access.table_lineage l\n"
    "LEFT JOIN system.query.history h ON h.statement_id = l.statement_id\n"
    "WHERE l.target_table_full_name = :t\n"
    "ORDER BY l.event_time DESC\nLIMIT 20"
)


def statement_plan(table: str) -> dict:
    """The statement read for one table, as {"sql", "params"}; "sql" shows the table name in place of the parameter."""
    return {"sql": STATEMENT_SQL.replace(":t", "'" + table.replace("'", "''") + "'"), "params": {"t": table}}


def is_metric_view(info: dict) -> bool:
    """Whether tables.get data is a metric view: its type says so, or its columns carry metric_view.type metadata (its definition is YAML)."""
    return str(info.get("table_type") or "").upper() == "METRIC_VIEW" or any(
        "metric_view.type" in (c.get("type_json") or "") for c in info.get("columns") or [])


def skip_reason(info: dict) -> Optional[str]:
    """Why no statement is read for a table (its tables.get data), or None when one is worth reading."""
    if is_metric_view(info):
        return "a metric view's definition is YAML"
    if str(info.get("table_type") or "").upper() in sqltools.VIEW_TYPES:
        return "its definition is the SQL"
    return None


def read_statement(sql: Callable, table: str) -> dict:
    """Read the latest write of a table through sql (Explorer.sql): {"statement": {...} or None, "writer": {...} or None}.

    The newest lineage row decides. With a statement id, the statement is its text, type, runner and time ("redacted" when
    the text is hidden from this reader); without one, the writer is the job, notebook or pipeline that wrote it, and
    there is no SQL to read."""
    rows = sql(STATEMENT_SQL, t=table)
    epoch = neighbors.parse_ts("1970-01-01T00:00:00Z")
    rows.sort(key=lambda r: neighbors.parse_ts(r.get("event_time")) or epoch, reverse=True)
    if not rows:
        return {"statement": None, "writer": None}
    r = rows[0]
    at = neighbors.parse_ts(r.get("event_time"))
    writer = {"type": str(r.get("entity_type") or "").lower() or None, "id": r.get("entity_id") or None}
    if not r.get("statement_id"):
        return {"statement": None, "writer": writer}
    text = r.get("statement_text") or ""
    hidden = text.strip() == REDACTED
    return {"statement": {"id": r["statement_id"], "type": r.get("statement_type"), "run_by": r.get("executed_by"),
                          "at": at.isoformat(timespec="seconds") if at else None, "sql": None if hidden else text,
                          "redacted": hidden}, "writer": writer}


@lru_cache(maxsize=256)
def _analysis(sql: str, catalog: str, schema: str, known: tuple) -> dict:
    """sqltools.transform_analysis, remembered by the SQL, with an "error" for SQL that does not parse."""
    try:
        return sqltools.transform_analysis(sql, catalog or None, schema or None, known)
    except ValueError as e:
        return {"error": str(e), "statement": "other", "target": None, "sources": {}}


def origin_of(info: Optional[dict], cached: Optional[dict]) -> dict:
    """The SQL behind a table: {"kind": "view"|"statement"|None, "sql", "note", ...}, from its tables.get data and its cached statement read.

    note is a plain reason when there is no SQL: "metric_view", "unread" (the statement was never read), "redacted",
    "no_sql" (a notebook, job or pipeline wrote it without a SQL statement), "unreadable" (tables.get failed)."""
    if info is None:
        return {"kind": None, "sql": None, "note": "unreadable"}
    if is_metric_view(info):
        return {"kind": None, "sql": None, "note": "metric_view"}
    if str(info.get("table_type") or "").upper() in sqltools.VIEW_TYPES and info.get("view_definition"):
        return {"kind": "view", "sql": info["view_definition"], "note": None}
    if cached is None:
        return {"kind": None, "sql": None, "note": "unread"}
    data = cached.get("data") or {}
    st = data.get("statement")
    meta = {k: v for k, v in (st or {}).items() if k != "sql"}
    if st and st.get("sql"):
        return {"kind": "statement", "sql": st["sql"], "note": None, "statement": meta, "read_at": cached.get("fetched_at")}
    if st:
        return {"kind": None, "sql": None, "note": "redacted", "statement": meta, "read_at": cached.get("fetched_at")}
    return {"kind": None, "sql": None, "note": "no_sql", "writer": data.get("writer"), "read_at": cached.get("fetched_at")}


def _origin(ex, table: str, fetch: bool) -> tuple[str, dict]:
    try:
        info = (ex.object(table) if fetch else ex.cached_object(table) or {}).get("data")
    except Exception:
        info = None
    return table, origin_of(info, ex.cached_write_statement(table))


def for_edges(ex, edges: list[dict], fetch: bool = True) -> dict:
    """{"edges": {edge id: {"transform", "note", "error"}}, "origins": {target: origin}} for flow edges ({"id", "source", "target"} each).

    transform is the facts for the edge's source in its target's SQL (see sqltools.edge_transform), or None with a note.
    fetch reads a view's tables.get data when it is not cached (a REST call, never a warehouse); False uses only the cache.
    A table's writing statement is only ever read from its cache here: reading it is the opt-in /api/edge-transforms/read."""
    targets = list(dict.fromkeys(e["target"] for e in edges))[:MAX_TARGETS]
    with ThreadPoolExecutor(max_workers=6) as pool:
        origins = dict(pool.map(lambda t: _origin(ex, t, fetch), targets))
    out = {}
    for e in edges:
        o = origins.get(e["target"])
        if o is None:
            continue
        if o["sql"] is None:
            out[e["id"]] = {"transform": None, "note": o["note"], "error": None}
            continue
        catalog, schema = (e["target"].lower().split(".") + ["", ""])[:2]
        known = tuple(sorted({x["source"].lower() for x in edges if x["target"] == e["target"]}))
        a = _analysis(o["sql"], catalog, schema, known)
        t = sqltools.edge_transform(a, e["source"]) if not a.get("error") else None
        out[e["id"]] = {"transform": t, "note": None if t else ("unparsed" if a.get("error") else "not_read"), "error": a.get("error")}
    return {"edges": out, "origins": origins}


def for_pairs(ex, edges: list[dict]) -> dict[tuple[str, str], dict]:
    """{(source, target): transform} for the table-level flow edges among edges (dicts with kind, source and target), from the cache only.

    Edges whose SQL was never read, whose SQL does not parse, or that are not flow edges are left out. Never queries the workspace."""
    flow = [{"id": f"{e['source']}|{e['target']}", "source": e["source"], "target": e["target"]} for e in edges
            if e.get("kind") in FLOW_KINDS and not e.get("bidir") and e.get("directed", True) is not False and not e.get("source_column")
            and nodefacts.table_name(e.get("source")) and nodefacts.table_name(e.get("target"))]
    out = for_edges(ex, flow, fetch=False)["edges"] if flow else {}
    return {tuple(k.split("|")): v["transform"] for k, v in out.items() if v["transform"]}  # type: ignore[misc]


def summary(t: dict) -> str:
    """One line of words for an agent: "aggregates by region (SUM), joined left on customer_id, filtered (2)"."""
    bits = []
    if t.get("aggregate"):
        a = t["aggregate"]
        bits.append("aggregates" + (f" by {', '.join(a['keys'])}" if a["keys"] else "") + (f" ({', '.join(a['functions'])})" if a["functions"] else ""))
    if t.get("joined"):
        j = t["joined"]
        keys = ", ".join(k["column"] for k in j["keys"])
        bits.append(f"joined {j['type']}" + (f" on {keys}" if keys else ""))
    if t.get("union"):
        bits.append(f"one of {t['union']['branches']} union branches")
    if t.get("dedupe"):
        bits.append("keeps one row per " + ", ".join(t["dedupe"]["keys"]))
    elif t.get("distinct"):
        bits.append("distinct")
    if t.get("filters"):
        bits.append(f"filtered ({len(t['filters'])})")
    if t.get("merge"):
        bits.append(("upsert on " + ", ".join(t["merge"]["keys"])) if t["merge"]["keys"] else "merge")
    return ", ".join(bits)
