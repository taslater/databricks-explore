"""The read-only gate for run_sql: exactly one SELECT, DESCRIBE, SHOW or EXPLAIN statement, checked with sqlglot."""
import logging

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError

logging.getLogger("sqlglot").setLevel(logging.ERROR)  # the Command fallback logs a warning for SHOW and EXPLAIN

QUERY_ROOTS = (exp.Select, exp.SetOperation)  # WITH ... SELECT is a Select that carries a `with`
COMMAND_WORDS = ("SHOW", "EXPLAIN", "DESCRIBE", "DESC")  # sqlglot reads these as a Command when it cannot model them
# Anything of these kinds anywhere in the tree is refused, so DML or DDL cannot hide in a CTE or a subquery.
_FORBIDDEN_NAMES = ("Insert", "Update", "Delete", "Merge", "Create", "Drop", "Alter", "AlterTable", "TruncateTable", "Copy",
                    "Command", "Use", "Set", "SetItem", "Into", "Grant", "Revoke", "Analyze", "Attach", "Detach", "Refresh",
                    "Cache", "Uncache", "LoadData", "Kill", "Transaction", "Commit", "Rollback", "Pragma")
FORBIDDEN = tuple(getattr(exp, n) for n in _FORBIDDEN_NAMES if hasattr(exp, n))
# Functions that run code or call out of the warehouse, so a SELECT is not enough to be read-only.
FORBIDDEN_FUNCTIONS = {"reflect", "java_method", "try_reflect", "http_request"}


class NotReadOnly(ValueError):
    """The statement is not one run_sql accepts. str(e) says why."""


def check_read_only(sql: str) -> str:
    """Return the one statement to run (as the caller wrote it, without a trailing `;`), or raise NotReadOnly."""
    if not isinstance(sql, str) or not sql.strip():
        raise NotReadOnly("statement is empty")
    try:
        parsed = sqlglot.parse(sql, read="databricks")
    except SqlglotError as e:
        raise NotReadOnly(f"could not parse the statement ({_first_line(e)}); only a plain SELECT, DESCRIBE, SHOW or EXPLAIN is accepted") from e
    statements = [s for s in parsed if s is not None]
    if not statements:
        raise NotReadOnly("statement is empty")
    if len(statements) > 1:
        raise NotReadOnly(f"{len(statements)} statements found; send exactly one")
    root = statements[0]
    while isinstance(root, (exp.Subquery, exp.Paren)) and root.this is not None:
        root = root.this  # (SELECT 1) is still a query
    if isinstance(root, exp.Command):
        word = str(root.this).upper()
        if word not in COMMAND_WORDS:
            raise NotReadOnly(f"{word} is not allowed; run_sql accepts SELECT, DESCRIBE, SHOW and EXPLAIN")
        return sql.strip().rstrip(";").rstrip()
    if not isinstance(root, QUERY_ROOTS + (exp.Describe,)):
        raise NotReadOnly(f"{type(root).__name__.upper()} statements are not allowed; run_sql accepts SELECT, DESCRIBE, SHOW and EXPLAIN")
    for node in root.walk():
        if isinstance(node, FORBIDDEN):
            raise NotReadOnly(f"{type(node).__name__.upper()} is not allowed inside a query; run_sql is read-only")
        if isinstance(node, (exp.Anonymous, exp.Func)):
            name = node.name.lower() if isinstance(node, exp.Anonymous) else type(node).__name__.lower()
            if name in FORBIDDEN_FUNCTIONS:
                raise NotReadOnly(f"{name}() is not allowed; it can run code or call outside the warehouse")
    return sql.strip().rstrip(";").rstrip()


def _first_line(e: Exception) -> str:
    return str(e).strip().splitlines()[0][:120] if str(e).strip() else type(e).__name__
