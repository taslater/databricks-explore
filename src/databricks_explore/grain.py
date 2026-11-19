"""The grain of a table: what one row stands for, from a declared primary key or a view's definition, with the basis."""
from typing import Optional

from . import sqltools

MAX_NAMED = 3  # more columns than this read as "per 5 columns", with the list in Details


def label(basis: str, columns: list[str]) -> str:
    """The line under a card: `per order_id × line_no`, `per 5 columns`, `per k (latest)` or `distinct rows`."""
    if basis == "distinct":
        return "distinct rows"
    text = " × ".join(columns) if len(columns) <= MAX_NAMED else f"{len(columns)} columns"
    return f"per {text}" + (" (latest)" if basis == "dedupe" else "")


def _fact(basis: str, columns: list[str], source: str) -> dict:
    return {"label": label(basis, columns), "columns": columns, "basis": basis, "source": source}


def table_grain(info: dict) -> Optional[dict]:
    """{"label", "columns", "basis", "source"} for a table's `tables.get` data, or None when nothing says what a row is.

    First match wins: a declared primary key, then a view or materialized view definition's GROUP BY, row_number() = 1
    dedupe or DISTINCT. A metric view has none (its rows exist only at query time), and SQL that cannot be read gives
    none, with no error."""
    kind = str(info.get("table_type") or "").upper()
    if kind == "METRIC_VIEW":
        return None
    for con in info.get("table_constraints") or []:
        pk = con.get("primary_key_constraint")
        if pk and pk.get("child_columns"):
            name = pk.get("name")
            return _fact("primary_key", list(pk["child_columns"]), f"declared primary key{f' {name}' if name else ''}")
    definition = info.get("view_definition")
    if kind in sqltools.VIEW_TYPES and definition:
        g = sqltools.view_grain(definition)
        if g:
            return _fact(g.basis, g.columns, {"group_by": "GROUP BY in the definition", "dedupe": "row_number() = 1 in the definition",
                                              "distinct": "SELECT DISTINCT in the definition"}[g.basis])
    return None
