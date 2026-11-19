"""What the Graph's Color by needs besides a table's name: its owner and the Unity Catalog tags read before. Only the tag read runs a query."""
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from . import dbx, nodefacts, tablestats


def _literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def statement(full_name: str) -> str:
    """The SQL read for one table's tags: its table tags and its column tags, from its own catalog's information_schema."""
    catalog, schema, table = full_name.split(".", 2)
    sql = dbx.TABLE_TAGS_SQL.format(catalog=tablestats.quoted(catalog))
    return sql.replace(":sch", _literal(schema)).replace(":tbl", _literal(table))


def plan(ex, tables: list[str]) -> dict:
    """{"statements": [{"table", "sql"}], "warehouse_id"}: what reading the tags of these tables would run."""
    return {"statements": [{"table": t, "sql": statement(t)} for t in tables], "warehouse_id": ex.warehouse_id}


def meta(ex, tables: list[str], fetch: bool = True) -> dict[str, dict]:
    """{table: {"owner", "tags", "tags_fetched_at"}} from tables.get and the tags read before; never a warehouse.

    `tags` is {tag: value} for the table itself, or None when its tags were never read. A table with neither is left out.
    `fetch` reads a missing tables.get (a REST call); False uses only the cache."""
    names = [t for t in dict.fromkeys(tables) if nodefacts.table_name(t)][:nodefacts.MAX_TABLES]

    def one(t):
        try:
            info = ex.object(t)["data"] if fetch else (ex.cached_object(t) or {}).get("data")
        except Exception:
            info = None
        cached = ex.cached_tags(t)
        if info is None and cached is None:
            return t, None
        tags: Optional[dict] = (cached.get("data") or {}).get("table") or {} if cached else None
        return t, {"owner": (info or {}).get("owner"), "tags": tags, "tags_fetched_at": cached.get("fetched_at") if cached else None}
    with ThreadPoolExecutor(max_workers=6) as pool:
        return {t: m for t, m in pool.map(one, names) if m is not None}


def read(ex, tables: list[str]) -> tuple[dict[str, dict], dict[str, str]]:
    """Reads the tags of these tables on the warehouse (replacing what was cached): (meta of the tables read, {table: error})."""
    def one(t):
        try:
            ex.tags(t, True)
            return t, None
        except Exception as err:
            return t, dbx.clean_error(err)
    with ThreadPoolExecutor(max_workers=4) as pool:
        errors = {t: msg for t, msg in pool.map(one, tables) if msg}
    return meta(ex, [t for t in tables if t not in errors]), errors
