"""Tests for sqltools.expand_refs and sqltools.tables_read (task A3)."""
import pytest
import sqlglot
from sqlglot import exp

from sqltools import expand_refs, tables_read


def cte_names(sql: str) -> list[str]:
    """Names of the statement's top-level CTEs (not CTEs nested inside a CTE body)."""
    tree = sqlglot.parse_one(sql, read="databricks")
    with_clause = tree.args.get("with_")
    return [cte.alias for cte in with_clause.expressions] if with_clause else []


def cte_body(sql: str, name: str) -> str:
    tree = sqlglot.parse_one(sql, read="databricks")
    for cte in tree.find_all(exp.CTE):
        if cte.alias == name:
            return cte.this.sql(dialect="databricks")
    raise AssertionError(f"no CTE {name!r} in {sql!r}")


# ---------- expand_refs: nesting, dedupe, no-op ----------

def test_no_references_returns_sql_unchanged():
    sql = "SELECT 1 AS x"
    assert expand_refs(sql, {"a": "SELECT 2"}) == sql


def test_nested_references_chain_a_b_c():
    windows = {
        "a": "SELECT * FROM {{b}}",
        "b": "SELECT * FROM {{c}}",
        "c": "SELECT 1 AS x",
    }
    out = expand_refs("SELECT * FROM {{a}}", windows)
    # Dependencies come first, and the outer query reads the top window.
    assert cte_names(out) == ["c", "b", "a"]
    assert cte_body(out, "b") == "SELECT * FROM `c`"
    assert cte_body(out, "a") == "SELECT * FROM `b`"
    assert sqlglot.parse_one(out, read="databricks").args["from_"].this.name == "a"


def test_window_with_its_own_with_clause_stays_nested_and_private():
    # Two windows each define a private CTE called q. Both must stay scoped to
    # their own window, so the outer statement does not see a duplicate q.
    windows = {
        "a": "WITH q AS (SELECT 1 AS x) SELECT * FROM q",
        "b": "WITH q AS (SELECT 2 AS y) SELECT * FROM q",
    }
    out = expand_refs("SELECT * FROM {{a}} JOIN {{b}} ON 1 = 1", windows)
    assert "`a` AS (\nWITH q AS (SELECT 1 AS x) SELECT * FROM q\n)" in out
    assert "`b` AS (\nWITH q AS (SELECT 2 AS y) SELECT * FROM q\n)" in out
    assert cte_names(out) == ["a", "b"]


def test_window_trailing_semicolon_is_stripped_from_cte_body():
    out = expand_refs("SELECT * FROM {{a}}", {"a": "SELECT 1 AS x;\n"})
    assert "`a` AS (\nSELECT 1 AS x\n)" in out


def test_outer_own_ctes_follow_window_ctes():
    windows = {"a": "SELECT 1 AS x"}
    out = expand_refs("WITH own AS (SELECT 2 AS y) SELECT * FROM own JOIN {{a}} ON 1 = 1", windows)
    assert cte_names(out) == ["a", "own"]


def test_repeated_references_produce_one_cte():
    windows = {"a": "SELECT 1 AS x", "b": "SELECT * FROM {{a}}"}
    out = expand_refs("SELECT * FROM {{a}} JOIN {{a}} AS y ON 1 = 1 JOIN {{b}} ON 1 = 1", windows)
    assert cte_names(out) == ["a", "b"]


def test_placeholder_inside_string_literal_and_comment_is_left_alone():
    windows = {"a": "SELECT 1 AS x"}
    out = expand_refs("SELECT '{{a}}' AS s FROM {{a}}", windows)
    assert cte_names(out) == ["a"]
    assert "'{{a}}'" in out


# ---------- expand_refs: errors ----------

def test_cycle_error_names_the_cycle():
    windows = {"a": "SELECT * FROM {{b}}", "b": "SELECT * FROM {{a}}"}
    with pytest.raises(ValueError, match="cycle: a -> b -> a"):
        expand_refs("SELECT * FROM {{a}}", windows)


def test_longer_cycle_names_only_the_loop():
    windows = {
        "x": "SELECT * FROM {{a}}",
        "a": "SELECT * FROM {{b}}",
        "b": "SELECT * FROM {{c}}",
        "c": "SELECT * FROM {{b}}",
    }
    with pytest.raises(ValueError, match="cycle: b -> c -> b"):
        expand_refs("SELECT * FROM {{x}}", windows)


def test_self_reference_is_a_cycle():
    with pytest.raises(ValueError, match="cycle: a -> a"):
        expand_refs("SELECT * FROM {{a}}", {"a": "SELECT * FROM {{a}}"})


def test_unknown_title_names_the_missing_title():
    with pytest.raises(ValueError, match="'zz'"):
        expand_refs("SELECT * FROM {{zz}}", {"a": "SELECT 1"})


def test_unknown_title_inside_a_window_names_the_missing_title():
    with pytest.raises(ValueError, match="'missing'"):
        expand_refs("SELECT * FROM {{a}}", {"a": "SELECT * FROM {{missing}}"})


def test_unclosed_reference_raises():
    with pytest.raises(ValueError):
        expand_refs("SELECT * FROM {{a", {"a": "SELECT 1"})


# ---------- expand_refs: quoted identifiers and titles ----------

def test_title_with_spaces_and_dash_becomes_quoted_safe_cte():
    windows = {"daily hours": "SELECT 2 AS y", "daily-hours": "SELECT 3 AS z"}
    out = expand_refs("SELECT * FROM {{daily hours}} JOIN {{daily-hours}} ON 1 = 1", windows)
    names = cte_names(out)
    assert names == ["daily_hours", "daily_hours_2"]
    # The CTE names are quoted identifiers, not bare words.
    assert "`daily_hours`" in out
    assert "`daily_hours_2`" in out
    assert cte_body(out, "daily_hours") == "SELECT 2 AS y"


def test_title_starting_with_digit_is_quoted():
    out = expand_refs("SELECT * FROM {{2024 sales}}", {"2024 sales": "SELECT 1 AS x"})
    assert cte_names(out) == ["2024_sales"]
    assert "`2024_sales`" in out


def test_cte_name_does_not_capture_a_real_table_in_another_window():
    # Window "orders" is a real table reference inside window "c". The CTE for
    # the window titled "orders" must not shadow that table.
    windows = {"c": "SELECT * FROM orders", "orders": "SELECT 1 AS k"}
    out = expand_refs("SELECT * FROM {{c}} JOIN {{orders}} o ON 1 = 1", windows)
    assert cte_names(out) == ["c", "orders_2"]
    assert cte_body(out, "c") == "SELECT * FROM orders"


def test_quoted_table_in_window_body_survives():
    windows = {"a": "SELECT * FROM `my-cat`.`my sch`.`my-tbl`"}
    out = expand_refs("SELECT * FROM {{a}}", windows)
    assert "`my-cat`.`my sch`.`my-tbl`" in out


# ---------- tables_read ----------

def test_tables_read_joins():
    sql = "SELECT * FROM cat.sch.a AS a JOIN cat.sch.b AS b ON a.id = b.id LEFT JOIN cat.sch.c ON 1 = 1"
    assert tables_read(sql) == ["cat.sch.a", "cat.sch.b", "cat.sch.c"]


def test_tables_read_subqueries():
    sql = (
        "SELECT (SELECT max(x) FROM cat.sch.lookup) AS m "
        "FROM cat.sch.main WHERE id IN (SELECT id FROM cat.sch.keys)"
    )
    assert tables_read(sql) == ["cat.sch.lookup", "cat.sch.main", "cat.sch.keys"]


def test_tables_read_excludes_cte_names_and_reads_cte_bodies():
    sql = (
        "WITH x AS (SELECT * FROM cat.s.t1), "
        "y AS (SELECT * FROM x JOIN t2 ON 1 = 1) "
        "SELECT * FROM y JOIN x ON 1 = 1"
    )
    assert tables_read(sql) == ["cat.s.t1", "t2"]


def test_tables_read_dedupes_in_first_seen_order():
    sql = "SELECT * FROM cat.s.b JOIN cat.s.a ON 1 = 1 JOIN cat.s.b AS b2 ON 1 = 1"
    assert tables_read(sql) == ["cat.s.b", "cat.s.a"]


def test_tables_read_keeps_short_names_as_written():
    assert tables_read("SELECT * FROM sales.orders") == ["sales.orders"]
    assert tables_read("SELECT * FROM orders") == ["orders"]


def test_tables_read_strips_quotes_but_keeps_text():
    sql = "SELECT * FROM `my-cat`.`s p`.t"
    assert tables_read(sql) == ["my-cat.s p.t"]


def test_tables_read_ignores_window_references():
    sql = "SELECT * FROM {{daily hours}} JOIN cat.s.t ON 1 = 1"
    assert tables_read(sql) == ["cat.s.t"]


def test_tables_read_excludes_insert_target():
    assert tables_read("INSERT INTO cat.s.dst SELECT * FROM cat.s.src") == ["cat.s.src"]


def test_tables_read_empty_for_no_tables():
    assert tables_read("SELECT 1 AS x") == []
