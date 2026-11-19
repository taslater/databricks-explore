"""SQL helpers built on sqlglot. No regex parsing of SQL.

Owners: wrap_limit -> task A1 ; expand_refs, tables_read -> task A3.
Each function is a stub until its owner implements it.
"""
from __future__ import annotations

import hashlib
from typing import Iterable, NamedTuple

import sqlglot
from sqlglot import exp
from sqlglot import lineage as sqlglot_lineage
from sqlglot.optimizer.scope import ScopeType, build_scope, traverse_scope
from sqlglot.tokens import TokenType


def wrap_limit(sql: str, max_rows: int) -> tuple[str, bool]:
    """Return (wrapped_sql, can_detect_truncation).

    Wraps as SELECT * FROM (<sql>) LIMIT max_rows+1 so truncation is detectable.
    If sqlglot cannot parse the statement, return (sql, False) unchanged.
    Statements that parse but are not queries (SHOW, DESCRIBE, DDL, multi-statement
    blocks) cannot be wrapped either, so they also pass through unchanged.
    """
    try:
        tree = sqlglot.parse_one(sql, read="databricks")
    except sqlglot.errors.SqlglotError:
        return sql, False
    if not isinstance(tree, exp.Query):
        return sql, False
    wrapped = exp.select("*").from_(exp.Subquery(this=tree)).limit(int(max_rows) + 1)
    return wrapped.sql(dialect="databricks"), True


_DIALECT = "databricks"
VIEW_TYPES = ("VIEW", "MATERIALIZED_VIEW")  # table types whose view_definition is a SELECT (a metric view's is YAML)


def _tokenize(sql: str) -> list:
    try:
        return sqlglot.tokenize(sql, read=_DIALECT)
    except sqlglot.errors.SqlglotError as e:
        raise ValueError(f"cannot tokenize SQL: {e}") from e


def _parse(sql: str) -> exp.Expression:
    try:
        return sqlglot.parse_one(sql, read=_DIALECT)
    except sqlglot.errors.SqlglotError as e:
        raise ValueError(f"cannot parse SQL: {e}") from e


def _find_refs(sql: str) -> list[tuple[int, int, str]]:
    """Locate each {{title}} as (start, end_exclusive, title), in source order.

    Works on sqlglot tokens, so braces inside string literals and comments are
    ignored. Titles are the raw text between the braces, stripped.
    """
    toks = _tokenize(sql)
    refs = []
    i = 0
    while i < len(toks) - 1:
        if toks[i].token_type == TokenType.L_BRACE and toks[i + 1].token_type == TokenType.L_BRACE:
            j = i + 2
            while j < len(toks) - 1 and not (
                toks[j].token_type == TokenType.R_BRACE and toks[j + 1].token_type == TokenType.R_BRACE
            ):
                j += 1
            if j >= len(toks) - 1:
                raise ValueError(f"unclosed {{{{ reference at offset {toks[i].start}")
            title = sql[toks[i + 1].end + 1 : toks[j].start].strip()
            if not title or "{" in title or "}" in title:
                raise ValueError(f"invalid window reference at offset {toks[i].start}: {title!r}")
            refs.append((toks[i].start, toks[j + 1].end + 1, title))
            i = j + 2
        else:
            i += 1
    return refs


def _splice(sql: str, refs: list[tuple[int, int, str]], texts: dict[str, str]) -> str:
    """Replace each located reference with texts[title]."""
    out = []
    pos = 0
    for start, end, title in refs:
        out.append(sql[pos:start])
        out.append(texts[title])
        pos = end
    out.append(sql[pos:])
    return "".join(out)


def _in_source_order(node: exp.Expression):
    """Depth-first walk that visits a WITH clause before the query body it precedes."""
    yield node
    for key in sorted(node.args, key=lambda k: k != "with_"):
        value = node.args[key]
        for child in value if isinstance(value, list) else [value]:
            if isinstance(child, exp.Expression):
                yield from _in_source_order(child)


def expand_refs(sql: str, windows_by_title: dict[str, str]) -> str:
    """Replace {{title}} with a CTE built from that window's SQL, recursively.

    Every referenced window becomes one CTE in a single WITH clause, placed before
    the statement's own CTEs. Windows come out dependencies-first. The CTE name is
    the sanitized title, made unique against identifiers already in the SQL.

    Raises ValueError naming the cycle if references form a loop, and ValueError
    naming the title if a reference is unknown.
    """
    outer_refs = _find_refs(sql)
    if not outer_refs:
        return sql

    # Depth-first post-order: each window is recorded after the windows it uses.
    order: list[str] = []
    done: set[str] = set()
    path: list[str] = []

    def visit(title: str) -> None:
        if title in path:
            cycle = path[path.index(title):] + [title]
            raise ValueError("cycle: " + " -> ".join(cycle))
        if title in done:
            return
        if title not in windows_by_title:
            raise ValueError(f"unknown window title: {title!r}")
        path.append(title)
        for _, _, dep in _find_refs(windows_by_title[title]):
            visit(dep)
        path.pop()
        done.add(title)
        order.append(title)

    for _, _, title in outer_refs:
        visit(title)

    # Identifiers already used anywhere in the statement, so a CTE name cannot
    # capture a real table or column reference.
    def without_refs(text: str) -> str:
        refs = _find_refs(text)
        return _splice(text, refs, dict.fromkeys((t for _, _, t in refs), " "))

    texts = [without_refs(sql), *(without_refs(windows_by_title[t]) for t in order)]
    taken = {tok.text.lower() for text in texts for tok in _tokenize(text)}
    names: dict[str, str] = {}
    for title in order:
        base = "".join(c if (c.isalnum() or c == "_") else "_" for c in title)
        name, k = base, 2
        while name.lower() in taken:
            name = f"{base}_{k}"
            k += 1
        taken.add(name.lower())
        names[title] = name

    quoted = {t: exp.to_identifier(names[t], quoted=True).sql(dialect=_DIALECT) for t in order}

    def replace_refs(text: str) -> str:
        refs = _find_refs(text)
        return _splice(text, refs, {t: quoted[t] for _, _, t in refs})

    # The user's SQL is kept as text and only the WITH clause is added. Rebuilding
    # from the sqlglot AST would hoist nested WITH clauses to the top level, which
    # can make two windows' private CTEs collide.
    ctes = []
    for title in order:
        body = replace_refs(windows_by_title[title])
        _parse(body)  # validate
        ctes.append(f"{quoted[title]} AS (\n{_strip_trailing_semicolons(body)}\n)")
    ctes_block = ",\n".join(ctes)

    outer = replace_refs(sql)
    _parse(outer)  # validate
    toks = _tokenize(outer)
    if toks and toks[0].token_type == TokenType.WITH:
        # Merge into the statement's own WITH clause, ahead of its CTEs.
        keyword_end = toks[0].end + 1
        if len(toks) > 1 and toks[1].text.upper() == "RECURSIVE":
            keyword_end = toks[1].end + 1
        return f"{outer[:keyword_end]}\n{ctes_block},{outer[keyword_end:]}"
    return f"WITH\n{ctes_block}\n{outer}"


def _strip_trailing_semicolons(text: str) -> str:
    toks = _tokenize(text)
    while toks and toks[-1].token_type == TokenType.SEMICOLON:
        text = text[: toks[-1].start]
        toks = toks[:-1]
    return text.rstrip()


def window_refs(sql: str) -> list[str]:
    """The titles `{{title}}` names in the SQL, in first-seen order without repeats. ValueError when a reference is malformed."""
    return list(dict.fromkeys(title for _, _, title in _find_refs(sql)))


def sql_hash(sql: str) -> str:
    """A short stable hash of the SQL that ran (after {{title}} expansion), for telling a saved result from a changed query.

    The text is trimmed and its trailing semicolons dropped first, so `SELECT 1;` and `SELECT 1` hash alike."""
    text = sql.strip()
    while text.endswith(";"):
        text = text[:-1].rstrip()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def tables_read(sql: str) -> list[str]:
    """Return the fully qualified table names (catalog.schema.table) the statement reads.

    Names are kept as written (identifier text, no quotes), joined with dots, and
    de-duplicated in first-seen order. CTE names defined in the statement are
    excluded, as are {{title}} window references and the target of INSERT, CREATE,
    and MERGE statements.
    """
    refs = _find_refs(sql)
    if refs:
        # A window reference is not a table. Swap each for a placeholder name so the
        # statement parses, then drop the placeholder below.
        placeholders: dict[str, str] = {}
        for _, _, title in refs:
            placeholders.setdefault(title, f"__window_ref_{len(placeholders)}")
        sql = _splice(sql, refs, placeholders)
        placeholder_names = set(placeholders.values())
    else:
        placeholder_names = set()

    tree = _parse(sql)
    if tree is None:
        return []

    cte_names = {cte.alias.lower() for cte in tree.find_all(exp.CTE)}
    write_targets = set()
    for stmt in tree.find_all(exp.Insert, exp.Create, exp.Merge):
        target = stmt.this
        if isinstance(target, exp.Schema):
            target = target.this
        if isinstance(target, exp.Table):
            write_targets.add(id(target))

    result: list[str] = []
    seen: set[str] = set()
    for node in _in_source_order(tree):
        if not isinstance(node, exp.Table) or id(node) in write_targets:
            continue
        if not isinstance(node.this, exp.Identifier):
            continue  # table-valued function, not a table name
        parts = [p.name for p in node.parts]
        if len(parts) == 1 and (parts[0] in placeholder_names or parts[0].lower() in cte_names):
            continue
        full = ".".join(parts)
        if full not in seen:
            seen.add(full)
            result.append(full)
    return result


# ---------- join extraction ----------

class JoinPair(NamedTuple):
    """Two columns a statement equates. The two ends are in sorted order, so a pair has one spelling."""
    left_table: str
    left_column: str
    right_table: str
    right_column: str
    join_type: str  # inner, left, right, full, semi, anti, implicit (comma or cross join plus WHERE), correlated


class _Names:
    """Qualifies table names to catalog.schema.table, in lowercase, from defaults and a set of known names."""

    def __init__(self, catalog, schema, known):
        self.catalog = (catalog or "").lower() or None
        self.schema = (schema or "").lower() or None
        self.conditions: list[list[JoinPair]] = []  # the pairs of each join condition read, for composite keys
        self.by_suffix: dict[str, set[str]] = {}
        for full in {k.lower() for k in known or ()}:
            parts = full.split(".")
            for i in range(1, len(parts)):
                self.by_suffix.setdefault(".".join(parts[i:]), set()).add(full)

    def qualify(self, table: exp.Table):
        if not isinstance(table.this, exp.Identifier):
            return None  # a table-valued function
        parts = [p.name.lower() for p in table.parts]
        if len(parts) > 3:
            return None
        if len(parts) == 3:
            return ".".join(parts)
        short = ".".join(parts)
        default = None
        if len(parts) == 2 and self.catalog:
            default = f"{self.catalog}.{short}"
        elif len(parts) == 1 and self.catalog and self.schema:
            default = f"{self.catalog}.{self.schema}.{short}"
        found = self.by_suffix.get(short, set())
        if default in found:
            return default
        if len(found) == 1:
            return next(iter(found))
        return default


class _FlatScope:
    """The few Scope attributes the resolver reads, for statements sqlglot builds no scope for (MERGE)."""

    def __init__(self, sources):
        self.sources = sources
        self.parent = None
        self.scope_type = ScopeType.ROOT


_MAX_DEPTH = 12


def _strip(node):
    """The expression under any parentheses and casts, which do not change which column is meant."""
    while isinstance(node, (exp.Paren, exp.Cast, exp.TryCast)):
        node = node.this
    return node


def _unwrap_query(node):
    while isinstance(node, exp.Subquery):
        node = node.this
    return node


def _is_column(node) -> bool:
    return isinstance(node, exp.Column) and not isinstance(node.this, exp.Star)


def _sources_of(scope) -> dict:
    """The tables and derived tables a scope's own FROM and JOINs name. sqlglot also lists the CTEs visible to it."""
    sources = {str(k).lower(): v for k, v in scope.sources.items()}
    query = getattr(scope, "expression", None)
    if not isinstance(query, exp.Select):
        return sources
    from_ = query.args.get("from_")
    named = {n.alias_or_name.lower() for n in ([from_.this] if from_ is not None else []) + (query.args.get("joins") or [])}
    return {k: v for k, v in sources.items() if k in named}


def _trace(source, name: str, names: _Names, depth: int = 0):
    """(base table, column) a column of one source comes from, looking through CTEs and subqueries. None if unclear."""
    if depth > _MAX_DEPTH:
        return None
    if isinstance(source, exp.Table):
        full = names.qualify(source)
        return (full, name) if full else None
    query = _unwrap_query(getattr(source, "expression", None))
    if not isinstance(query, exp.Select):
        return None  # a UNION, VALUES or function: the column has no single origin
    inner = _sources_of(source)
    stars = []
    for projection in query.expressions:
        value = projection.this if isinstance(projection, exp.Alias) else projection
        if projection.alias_or_name.lower() == name and not isinstance(value, exp.Star):
            value = _strip(value)
            if not _is_column(value):
                return None  # computed: not a plain column
            found = _resolve(value, source, names, depth + 1)
            return found[2:] if found else None
        if isinstance(value, exp.Star) or (isinstance(value, exp.Column) and isinstance(value.this, exp.Star)):
            stars.append(value)
    if len(stars) != 1:
        return None
    star = stars[0]
    if isinstance(star, exp.Column):  # alias.*
        target = inner.get(star.table.lower())
    else:
        target = next(iter(inner.values())) if len(inner) == 1 else None
    return _trace(target, name, names, depth + 1) if target is not None else None


def _resolve(col: exp.Column, scope, names: _Names, depth: int = 0):
    """(scope id, source key, base table, column) for a column reference, or None when it cannot be pinned down."""
    name = col.name.lower()
    qualifier = col.table.lower()
    current = scope
    key = None
    while current is not None:
        sources = _sources_of(current)
        if qualifier:
            if qualifier in sources:
                key = qualifier
                break
        elif len(sources) == 1:
            key = next(iter(sources))
            break
        else:
            return None  # an unqualified column with several candidate tables, and no schema to decide
        # A correlated subquery may name a table of the query around it.
        current = getattr(current, "parent", None) if current.scope_type == ScopeType.SUBQUERY else None
    if current is None or key is None:
        return None
    traced = _trace(sources[key], name, names, depth)
    return (id(current), key, *traced) if traced else None


def _conjuncts(cond):
    """The equalities that must all hold: the AND-ed parts of a condition. OR branches are left out."""
    if isinstance(cond, exp.Paren):
        yield from _conjuncts(cond.this)
    elif isinstance(cond, exp.And):
        yield from _conjuncts(cond.left)
        yield from _conjuncts(cond.right)
    elif isinstance(cond, (exp.EQ, exp.NullSafeEQ)):
        yield cond


def _equalities(cond, scope, names: _Names, join_type: str):
    got: list[JoinPair] = []
    for eq in _conjuncts(cond):
        left, right = _strip(eq.left), _strip(eq.right)
        if not (_is_column(left) and _is_column(right)):
            continue
        a, b = _resolve(left, scope, names), _resolve(right, scope, names)
        if a and b and a[:2] != b[:2] and a[2:] != b[2:]:
            got.append(_pair(a[2], a[3], b[2], b[3], join_type))
            yield got[-1]
    names.conditions.append(got)


def _pair(t1, c1, t2, c2, join_type) -> JoinPair:
    if (t2, c2) < (t1, c1):
        t1, c1, t2, c2 = t2, c2, t1, c1
    return JoinPair(t1, c1, t2, c2, join_type)


def _join_type(join: exp.Join) -> str:
    kind, side = (join.kind or "").lower(), (join.side or "").lower()
    if kind in ("semi", "anti"):
        return kind
    return side if side in ("left", "right", "full") else "inner"


def _select_pairs(scope, names: _Names):
    select = scope.expression
    if not isinstance(select, exp.Select):
        return
    sources = _sources_of(scope)
    from_ = select.args.get("from_")
    preceding = [from_.this.alias_or_name.lower()] if from_ is not None else []
    implicit = False
    for join in select.args.get("joins") or []:
        key = join.alias_or_name.lower()
        kind = _join_type(join)
        if join.args.get("on") is not None:
            yield from _equalities(join.args["on"], scope, names, kind)
        elif join.args.get("using"):
            got: list[JoinPair] = []
            for ident in join.args["using"]:
                name = ident.name.lower()
                one_left = len(preceding) == 1 and preceding[0] in sources
                left = _trace(sources[preceding[0]], name, names) if one_left else None
                right = _trace(sources[key], name, names) if key in sources else None
                if left and right and left != right:
                    got.append(_pair(*left, *right, kind))
                    yield got[-1]
            names.conditions.append(got)
        elif not join.args.get("method"):
            implicit = True  # a comma or CROSS JOIN: its condition, if any, is in WHERE
        preceding.append(key)
    where = select.args.get("where")
    if where is not None and implicit:
        yield from _equalities(where.this, scope, names, "implicit")
    elif where is not None and scope.scope_type == ScopeType.SUBQUERY:
        yield from _equalities(where.this, scope, names, "correlated")


def _merge_pairs(merge: exp.Merge, names: _Names):
    on = merge.args.get("on")
    if on is None:
        return
    sources = {}
    for node in (merge.this, merge.args.get("using")):
        if isinstance(node, exp.Table):
            sources[node.alias_or_name.lower()] = node
        elif isinstance(node, exp.Subquery):
            inner = build_scope(node.this)
            if inner is not None:
                sources[node.alias_or_name.lower()] = inner
                yield from (p for s in traverse_scope(node.this) for p in _select_pairs(s, names))
    yield from _equalities(on, _FlatScope(sources), names, "inner")


def join_pairs(sql: str, default_catalog: str | None = None, default_schema: str | None = None,
               known: Iterable[str] | None = None) -> list[JoinPair]:
    """Column pairs a statement joins on, resolved through aliases, CTEs and subqueries to base tables (see join_analysis)."""
    return join_analysis(sql, default_catalog, default_schema, known)[0]


def join_analysis(sql: str, default_catalog: str | None = None, default_schema: str | None = None,
                  known: Iterable[str] | None = None) -> tuple[list[JoinPair], list[tuple[tuple, ...]]]:
    """The join pairs of a statement and its composite keys: `(pairs, composites)`.

    A composite key is two or more different column pairs between the same two tables in one join condition
    (`ON a.x = b.x AND a.y = b.y`, or `USING (x, y)`). Each is a sorted tuple of pair keys `(table, column, table,
    column)`, and the same key found twice in a statement is listed once.

    The pairs are the column pairs a statement joins on, resolved through aliases, CTEs and subqueries to base tables.

    Reads ON equalities (composite AND keys too), USING, comma and CROSS joins whose WHERE equates columns,
    MERGE ... ON, and equalities that correlate a subquery with its outer query. Anything that cannot be
    pinned to one base column is dropped, never guessed: OR conditions, expressions, an unqualified column
    when several tables are in scope, UNION branches, a USING column when more than one table is on its left.
    Short table names are qualified from the defaults, or from `known` (full names the statement is known to
    read) when exactly one of them fits. Names and columns come back lowercase and each pair has one spelling,
    sorted, so the same join written either way round is equal. Raises ValueError when the SQL does not parse.
    """
    names = _Names(default_catalog, default_schema, known)
    try:
        trees = sqlglot.parse(sql, read=_DIALECT)
        found: dict[tuple, JoinPair] = {}
        for tree in trees:
            if tree is None:
                continue
            if isinstance(tree, exp.Merge):
                pairs = _merge_pairs(tree, names)
            else:
                pairs = (p for scope in traverse_scope(tree) for p in _select_pairs(scope, names))
            for p in pairs:
                found.setdefault(p[:4], p)
        return list(found.values()), _composites(names.conditions)
    except sqlglot.errors.SqlglotError as e:
        raise ValueError(f"cannot parse SQL: {e}") from e
    except RecursionError as e:
        raise ValueError("cannot parse SQL: nested too deeply") from e


def _composites(conditions) -> list[tuple[tuple, ...]]:
    """Sorted pair-key tuples for each set of 2+ different pairs between one two tables inside one condition."""
    out = set()
    for cond in conditions:
        by_tables: dict[tuple, set[tuple]] = {}
        for p in cond:
            if p.left_table != p.right_table:
                by_tables.setdefault((p.left_table, p.right_table), set()).add(tuple(p[:4]))
        out.update(tuple(sorted(keys)) for keys in by_tables.values() if len(keys) >= 2)
    return sorted(out)


# ---------- column lineage from a view's SQL ----------

def view_column_lineage(sql: str, columns: Iterable[str], default_catalog: str | None = None,
                        default_schema: str | None = None, known: Iterable[str] | None = None) -> list[tuple[str, str, str]]:
    """Where each output column of a view's SELECT comes from: [(source table, source column, view column)].

    Traces through aliases, CTEs, subqueries, expressions and aggregates to base tables, with no catalog calls.
    Table and source column names come back lowercase and qualified like `join_analysis`; the view column as given. A column sqlglot cannot trace (a `SELECT *`, a
    literal, SQL that does not parse) is left out, never guessed. Never raises.
    """
    names = _Names(default_catalog, default_schema, known)
    out: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for column in columns:
        try:
            tree = sqlglot_lineage.lineage(column, sql, schema=None, dialect=_DIALECT)
            leaves = [n for n in tree.walk() if not n.downstream]
        except Exception:  # sqlglot raises several kinds of error for SQL it cannot trace
            continue
        found = set()  # sqlglot walks a column's sources in no fixed order, so sort them
        for leaf in leaves:
            table = leaf.expression if isinstance(leaf.expression, exp.Table) else None
            source = names.qualify(table) if table is not None else None
            if source is not None and source.count(".") == 2:
                found.add((source, leaf.name.rsplit(".", 1)[-1].lower(), str(column)))
        for row in sorted(found):
            if row not in seen:
                seen.add(row)
                out.append(row)
    return out
