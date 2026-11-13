"""SQL helpers built on sqlglot. No regex parsing of SQL.

Owners: wrap_limit -> task A1 ; expand_refs, tables_read -> task A3.
Each function is a stub until its owner implements it.
"""
from __future__ import annotations

import sqlglot
from sqlglot import exp
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
