"""Expand a `*` or `alias.*` in a SELECT list into the columns it stands for, with sqlglot to read the statement.

The result is the replacement text and the exact range it replaces, so an editor can swap in just the star and
leave the rest of the user's formatting alone. Column lists come from a caller-supplied function, so the server
can use the object details it already caches.
"""
from __future__ import annotations

import re
from typing import Callable

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.scope import Scope, traverse_scope
from sqlglot.tokens import TokenType

from . import sqltools

_DIALECT = "databricks"
_PLAIN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Words that need backticks as a name. Kept in step with web/src/shared/scriptAs.ts.
_RESERVED = frozenset(
    ("all alter and anti any array as at between by case cast check column constraint create cross cube current "
     "current_date current_timestamp current_user default delete describe distinct drop else end escape except exists "
     "false fetch filter for foreign from full function grant group grouping having in inner insert intersect into "
     "is join lateral left like limit minus natural no not null of offset on only or order outer over partition "
     "primary range references revoke right rollup row rows select semi set show some table tablesample then to "
     "trailing true truncate union unique unknown update using values when where window with").split())


class StarError(ValueError):
    """A star that cannot be expanded, with a message fit to show the user."""


def quote_ident(name: str) -> str:
    """A name as written in SQL: bare when plain and not reserved, else in backticks."""
    if _PLAIN.match(name) and name.lower() not in _RESERVED:
        return name
    return "`" + name.replace("`", "``") + "`"


def _to_index(text: str, utf16: int) -> int:
    """The string index for an offset counted in UTF-16 code units, as a browser editor counts."""
    units = 0
    for i, ch in enumerate(text):
        if units >= utf16:
            return i
        units += 2 if ord(ch) > 0xFFFF else 1
    return len(text)


def _to_utf16(text: str, index: int) -> int:
    """The UTF-16 offset of a string index."""
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text[:index])


def _qualifier_start(tokens: list, star_at: int) -> int:
    """Where the `a.b.` before a star begins, or the star's own start when it is not qualified."""
    start = star_at
    i = next(k for k, t in enumerate(tokens) if t.start == star_at and t.token_type == TokenType.STAR)
    while i >= 2 and tokens[i - 1].token_type == TokenType.DOT and tokens[i - 2].token_type in (TokenType.VAR, TokenType.IDENTIFIER):
        start = tokens[i - 2].start
        i -= 2
    return start


def _except_end(tokens: list, star_at: int) -> int | None:
    """The end (exclusive) of `EXCEPT (...)` right after the star, or None when there is none."""
    i = next(k for k, t in enumerate(tokens) if t.start == star_at and t.token_type == TokenType.STAR)
    if i + 2 >= len(tokens) or tokens[i + 1].token_type != TokenType.EXCEPT or tokens[i + 2].token_type != TokenType.L_PAREN:
        return None
    depth = 0
    for t in tokens[i + 2:]:
        if t.token_type == TokenType.L_PAREN:
            depth += 1
        elif t.token_type == TokenType.R_PAREN:
            depth -= 1
            if depth == 0:
                return t.end + 1
    return None


def _is_star(node: exp.Expression) -> bool:
    return isinstance(node, exp.Star) or (isinstance(node, exp.Column) and isinstance(node.this, exp.Star))


def _star_of(node: exp.Expression) -> exp.Star:
    return node if isinstance(node, exp.Star) else node.this


def _excluded(star: exp.Star) -> set[str]:
    """Column names named by `* EXCEPT (...)`. Other star modifiers cannot be expanded."""
    for key in ("ilike", "replace", "rename"):
        if star.args.get(key):
            raise StarError(f"A * with {key.upper()} cannot be expanded here. Write the columns out instead.")
    names = star.args.get("except_") or star.args.get("except") or []
    return {c.name.lower() for c in names}


def _table_name(table: exp.Table, catalog: str | None, schema: str | None) -> str:
    parts = [p.name for p in table.parts]
    if len(parts) == 3:
        return ".".join(parts)
    if len(parts) == 2 and catalog:
        return f"{catalog}.{parts[0]}.{parts[1]}"
    if len(parts) == 1 and catalog and schema:
        return f"{catalog}.{schema}.{parts[0]}"
    raise StarError(f"Cannot tell which catalog and schema {'.'.join(parts)} is in. Write its full name, or set a default catalog.")


Columns = Callable[[str], "list[str]"]


def _source_columns(alias: str, node: exp.Expression, source, columns_of: Columns, catalog, schema, depth: int) -> list[str]:
    if isinstance(source, Scope):
        return _scope_columns(source, columns_of, catalog, schema, depth + 1)
    if isinstance(source, exp.Table) and isinstance(source.this, exp.Identifier):
        name = _table_name(source, catalog, schema)
        cols = columns_of(name)
        if not cols:
            raise StarError(f"{name} has no columns I can read.")
        return cols
    raise StarError(f"Cannot tell the columns of {alias}; it is not a table or a subquery.")


def _expand_in_scope(scope: Scope, qualifier: str | None, excluded: set[str], columns_of: Columns, catalog, schema,
                     depth: int) -> list[tuple[str, str]]:
    """The (source alias, column) pairs a star in this scope stands for."""
    if depth > 8:
        raise StarError("Subqueries nest too deeply to expand.")
    sources = list(scope.selected_sources.items())
    if qualifier is not None:
        sources = [(a, v) for a, v in sources if a.lower() == qualifier.lower()]
        if not sources:
            raise StarError(f"No table or alias named {qualifier} in this SELECT.")
    if not sources:
        raise StarError("This SELECT has no FROM to take columns from.")
    out = []
    for alias, (node, source) in sources:
        for col in _source_columns(alias, node, source, columns_of, catalog, schema, depth):
            if col.lower() not in excluded:
                out.append((alias, col))
    return out


def _scope_columns(scope: Scope, columns_of: Columns, catalog, schema, depth: int) -> list[str]:
    """The output column names of a subquery or CTE, expanding stars inside it the same way."""
    branches = getattr(scope, "set_operation_scopes", None) or getattr(scope, "union_scopes", None)  # name depends on sqlglot's version
    if branches:
        return _scope_columns(branches[0], columns_of, catalog, schema, depth)
    select = scope.expression
    if not isinstance(select, exp.Select):
        raise StarError("Cannot tell the columns of a subquery that is not a SELECT.")
    names: list[str] = []
    for item in select.expressions:
        if _is_star(item):
            q = item.table if isinstance(item, exp.Column) else None
            pairs = _expand_in_scope(scope, q or None, _excluded(_star_of(item)), columns_of, catalog, schema, depth)
            names.extend(col for _, col in pairs)
        else:
            if not item.alias_or_name:
                raise StarError("A subquery has a column without a name, so its columns cannot be listed.")
            names.append(item.alias_or_name)
    return names


def expand_star(sql: str, offset: int, columns_of: Columns, default_catalog: str | None = None,
                default_schema: str | None = None) -> dict:
    """Expand the `*` or `alias.*` at `offset` (UTF-16 units into `sql`) into column names.

    Returns {"text", "start", "end", "count"}: replace sql[start:end] (offsets in UTF-16 units) with text.
    `columns_of(full_name)` gives a table's column names. Raises StarError, with a message for the user, when
    the cursor is not on a select-list star or its columns cannot be found.
    """
    if sqltools.window_refs(sql):
        raise StarError("Expanding * does not work in a statement that uses {{window}} references yet.")
    pos = _to_index(sql, offset)
    try:
        tokens = sqlglot.tokenize(sql, read=_DIALECT)
        tree = sqlglot.parse_one(sql, read=_DIALECT)
    except sqlglot.errors.SqlglotError as e:
        raise StarError(f"Cannot read this statement, so the * cannot be expanded: {str(e).splitlines()[0]}") from e

    hit = None  # (range start, range end, star)
    for star in tree.find_all(exp.Star):
        at = star.meta.get("start")
        if at is None:
            continue
        lo, hi = _qualifier_start(tokens, at), star.meta["end"] + 1
        if lo <= pos <= hi and (hit is None or hi - lo < hit[1] - hit[0]):
            hit = (lo, hi, star)
    if hit is None:
        raise StarError("Put the cursor on a * (or alias.*) in a SELECT list.")
    lo, hi, star = hit
    parent = star.parent
    qualified = isinstance(parent, exp.Column)
    select = parent.parent if qualified else parent
    holder = parent if qualified else star
    if not isinstance(select, exp.Select) or holder not in select.expressions:
        raise StarError("That * is not in a SELECT list (a COUNT(*), for instance), so there are no columns to list.")
    excluded = _excluded(star)
    except_end = _except_end(tokens, star.meta["start"])
    if except_end is not None:
        hi = except_end

    scope = next((s for s in traverse_scope(tree) if s.expression is select), None)
    if scope is None:
        raise StarError("Cannot find the tables this SELECT reads from.")
    pairs = _expand_in_scope(scope, (parent.table or None) if qualified else None, excluded, columns_of,
                             default_catalog, default_schema, 0)
    if not pairs:
        raise StarError("Every column is excluded, so there is nothing to list.")

    if qualified:
        prefix = sql[lo:star.meta["start"]]  # the qualifier as the user wrote it, with its dot
        names = [prefix + quote_ident(col) for _, col in pairs]
    elif len({a for a, _ in pairs}) > 1:
        names = [f"{quote_ident(a)}.{quote_ident(col)}" for a, col in pairs]
    else:
        names = [quote_ident(col) for _, col in pairs]

    line_start = sql.rfind("\n", 0, lo) + 1
    indent = sql[line_start:lo]
    sep = ",\n" + indent if indent.strip() == "" and "\n" in sql[:lo] and len(names) > 1 else ", "
    return {"text": sep.join(names), "start": _to_utf16(sql, lo), "end": _to_utf16(sql, hi), "count": len(names)}
