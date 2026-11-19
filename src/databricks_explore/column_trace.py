"""Trace one column through column lineage, upstream or downstream, with what each hop does to it.

The walk is bounded like lineage.walk (depth, table cap). What a hop does comes from the SQL behind its target (a view's
definition, or a table's writing statement already read in the Graph), never from a new warehouse read."""
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import Callable, Optional

from . import dbx, lineage, sqltools, transforms

NODE_CAP = lineage.NODE_CAP  # the most tables a trace reaches (the start included)
MAX_DEPTH = lineage.MAX_DEPTH
HOP_CAP = 400  # the most column hops one trace returns
READER_TABLES = 10  # tables asked who reads them
_ERROR_LIMIT = 5
GLYPHS = {"same": "=", "rename": "→", "cast": "cast", "func": "ƒ", "agg": "Σ", "case": "case"}


def _key(table: str, column: str) -> tuple[str, str]:
    return table.lower(), column.lower()


def walk(rows_of: Callable[[str], list], table: str, column: str, direction: str = "both", depth: int = 3,
         node_cap: int = NODE_CAP) -> dict:
    """Follow one column through column lineage, breadth first, up to `depth` hops on each side.

    `rows_of(table)` is the column lineage rows touching a table (source and target table and column, last_seen).
    `direction` is upstream, downstream or both. Each (table, column) is expanded once per side, so a cycle ends the
    walk, and at most `node_cap` tables are reached (`truncated` says it stopped there, or at HOP_CAP hops). Returns
    {"table", "column", "direction", "depth", "nodes", "hops", "truncated", "errors"}: a node is {table, column, hop,
    side (start, up or down)}, a hop {id, source, target, hop, side, last_seen} with source and target {table, column},
    source to target as data flows. Hops are ordered by hop, nodes by hop and name."""
    if direction not in ("upstream", "downstream", "both"):
        raise ValueError("direction must be upstream, downstream or both")
    depth = max(1, min(int(depth), MAX_DEPTH))
    sides = {"upstream": ("up",), "downstream": ("down",), "both": ("up", "down")}[direction]
    start = _key(table, column)
    nodes: dict[tuple, dict] = {start: {"table": table, "column": column, "hop": 0, "side": "start"}}
    tables = {table.lower()}
    hops: dict[tuple, dict] = {}
    errors: list[str] = []
    memo: dict[str, list] = {}
    truncated = False

    def rows(t: str) -> list:
        if t.lower() not in memo:
            try:
                memo[t.lower()] = rows_of(t) or []
            except Exception as e:  # one unreadable table must not end the trace
                memo[t.lower()] = []
                errors.append(f"{t}: {dbx.clean_error(e)}")
        return memo[t.lower()]

    for side in sides:
        frontier, seen = [(table, column)], {start}
        for hop in range(1, depth + 1):
            reached: list[tuple[str, str]] = []
            for t, c in frontier:
                for r in rows(t):
                    src = (r.get("source_table_full_name"), r.get("source_column_name"))
                    tgt = (r.get("target_table_full_name"), r.get("target_column_name"))
                    if not all(src) or not all(tgt) or _key(*src) == _key(*tgt):
                        continue
                    here, other = (tgt, src) if side == "up" else (src, tgt)
                    if _key(*here) != _key(t, c):
                        continue
                    if _key(*other) not in nodes:
                        if other[0].lower() not in tables and len(tables) >= node_cap:
                            truncated = True
                            continue
                        tables.add(other[0].lower())
                        nodes[_key(*other)] = {"table": other[0], "column": other[1], "hop": hop, "side": side}
                    k = (_key(*src), _key(*tgt))
                    if k not in hops or hops[k]["hop"] > hop:  # a cycle reaches a hop again by the other side: keep the nearer
                        if k not in hops and len(hops) >= HOP_CAP:
                            truncated = True
                            continue
                        hops[k] = {"id": f"lineage:{src[0]}#{src[1]}->{tgt[0]}#{tgt[1]}",
                                   "source": {"table": src[0], "column": src[1]}, "target": {"table": tgt[0], "column": tgt[1]},
                                   "hop": hop, "side": side, "last_seen": r.get("last_seen")}
                    if _key(*other) not in seen:
                        seen.add(_key(*other))
                        reached.append(other)
            frontier = reached
            if not frontier:
                break
    if len(errors) > _ERROR_LIMIT:
        errors = errors[:_ERROR_LIMIT] + [f"... {len(errors) - _ERROR_LIMIT} more"]
    return {"table": table, "column": column, "direction": direction, "depth": depth,
            "nodes": sorted(nodes.values(), key=lambda n: (n["hop"], n["table"], n["column"])),
            "hops": sorted(hops.values(), key=lambda h: (h["hop"], h["source"]["table"], h["source"]["column"], h["target"]["table"], h["target"]["column"])),
            "truncated": truncated, "errors": errors}


@lru_cache(maxsize=256)
def _expressions(sql: str, catalog: str, schema: str, known: tuple) -> Optional[dict]:
    """sqltools.column_expressions, remembered by the SQL; None for SQL that does not parse."""
    try:
        return sqltools.column_expressions(sql, catalog or None, schema or None, known)
    except ValueError:
        return None


def classify(hop: dict, expressions: Optional[dict]) -> dict:
    """What one hop does with its source column, given the output columns of its target's SQL (None: it does not parse).

    Returns {"class", "label", "expr", "note"}. class is same (`=`), rename (`→`), cast, func (`ƒ`), agg (`Σ sum`) or case,
    or None with a note (unparsed, not_select) when the SQL does not say."""
    if expressions is None:
        return {"class": None, "label": None, "expr": None, "note": "unparsed"}
    found = expressions.get(hop["target"]["column"].lower())
    if found is None:
        return {"class": None, "label": None, "expr": None, "note": "not_select"}
    kind = found["class"]
    if kind == "ref":
        kind = "same" if hop["source"]["column"].lower() == hop["target"]["column"].lower() else "rename"
    label = f"{GLYPHS['agg']} {found['agg']}" if kind == "agg" else GLYPHS[kind]
    return {"class": kind, "label": label, "expr": None if kind in ("same", "rename") else found["sql"], "note": None}


def classify_hops(ex, hops: list[dict]) -> dict[str, dict]:
    """Adds class, label, expr and note to each hop, and returns the SQL's origin per target table (see transforms.origin_of).

    Reads tables.get for a target not cached (a REST call); a table's writing statement is only used when it was read before."""
    targets = list(dict.fromkeys(h["target"]["table"] for h in hops))
    with ThreadPoolExecutor(max_workers=6) as pool:
        origins = dict(pool.map(lambda t: transforms._origin(ex, t, True), targets))
    sources: dict[str, set] = {}
    for h in hops:
        sources.setdefault(h["target"]["table"], set()).add(h["source"]["table"].lower())
    done: dict[str, Optional[dict]] = {}
    for t in targets:
        sql = origins[t]["sql"]
        if sql:
            catalog, schema = (t.lower().split(".") + ["", ""])[:2]
            done[t] = _expressions(sql, catalog, schema, tuple(sorted(sources[t])))
    for h in hops:
        t = h["target"]["table"]
        h.update(classify(h, done[t]) if t in done else {"class": None, "label": None, "expr": None, "note": origins[t]["note"] or "no_sql"})
    return origins


def readers(ex, tables: list[str]) -> list[dict]:
    """Dashboards, notebooks, jobs, pipelines and queries that the lineage API says read these tables (cached, else one REST call each).

    Lineage names readers of a table, not of one column. A reader is {table, kind, id, url, last_seen}."""
    out, seen = [], set()
    for t in tables[:READER_TABLES]:
        try:
            items = ex.lineage(t)["data"].get("downstreams") or []
        except Exception:
            continue
        for item in items:
            if item.get("tableInfo"):  # a table built from it, not a reader
                continue
            for key, kind in dbx.ENTITY_KEYS.items():
                if kind == "file":
                    continue
                v = item.get(key)
                for info in (v if isinstance(v, list) else [v] if v else []):
                    try:
                        ent = ex._link(kind, info)
                    except Exception:
                        continue
                    if (t, kind, ent["id"]) not in seen:
                        seen.add((t, kind, ent["id"]))
                        out.append({"table": t, "kind": kind, "id": ent["id"], "url": ent["url"], "last_seen": ent["last_seen"]})
    return out


def trace(ex, table: str, column: str, direction: str = "both", depth: int = 3, node_cap: int = NODE_CAP) -> dict:
    """The trace of one column of a table: walk(), each hop classified, the readers at the downstream ends, and what is unread.

    Raises ValueError for a bad direction, or a column the table does not have. `unread` lists targets whose writing
    statement was never read (see /api/edge-transforms/read), so their hops have no class yet."""
    info = ex.object(table)["data"]
    named = {c["name"].lower(): c["name"] for c in info.get("columns") or [] if c.get("name")}
    if named and column.lower() not in named:
        raise ValueError(f"{table} has no column {column}")
    column = named.get(column.lower(), column)
    out = walk(lambda t: (ex.column_lineage(t) or {}).get("data"), table, column, direction, depth, node_cap)
    origins = classify_hops(ex, out["hops"])
    has_next = {_key(h["source"]["table"], h["source"]["column"]) for h in out["hops"] if h["side"] == "down"}
    down = [n for n in out["nodes"] if n["side"] in ("start", "down")] if direction != "upstream" else []
    ends = list(dict.fromkeys(n["table"] for n in down if _key(n["table"], n["column"]) not in has_next))
    return {**out, "tables": list(dict.fromkeys(n["table"] for n in out["nodes"])), "readers": readers(ex, ends),
            "unread": [t for t, o in origins.items() if o["note"] == "unread"],
            "origins": {t: {k: v for k, v in o.items() if k != "sql"} for t, o in origins.items()}}
