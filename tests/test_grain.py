"""Grain: what one row stands for, from a primary key or a view's GROUP BY, row_number() = 1 dedupe or DISTINCT."""
import pytest

from databricks_explore import grain
from databricks_explore import sqltools


@pytest.mark.parametrize("sql, basis, columns", [
    ("SELECT customer_id, order_date, SUM(x) AS total FROM t GROUP BY customer_id, order_date", "group_by", ["customer_id", "order_date"]),
    # a grouping expression is named by its select alias
    ("SELECT date_trunc('month', ts) AS month, SUM(x) FROM t GROUP BY date_trunc('month', ts)", "group_by", ["month"]),
    ("SELECT c.id AS cid, count(*) FROM t c GROUP BY c.id", "group_by", ["cid"]),
    ("SELECT a, b, count(*) FROM t GROUP BY 1, 2", "group_by", ["a", "b"]),
    ("SELECT a, count(*) AS n FROM t GROUP BY ALL", "group_by", ["a"]),
    ("SELECT date_trunc('day', ts), count(*) FROM t GROUP BY 1", "group_by", ["DATE_TRUNC('DAY', ts)"]),  # no alias: the expression's SQL
    ("SELECT * FROM t QUALIFY row_number() OVER (PARTITION BY k ORDER BY ts DESC) = 1", "dedupe", ["k"]),
    ("SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY a, b ORDER BY ts DESC) AS rn FROM t) WHERE rn = 1", "dedupe", ["a", "b"]),
    ("WITH x AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY k ORDER BY ts) AS rn FROM t) SELECT * FROM x WHERE rn = 1", "dedupe", ["k"]),
    ("SELECT DISTINCT a, b FROM t", "distinct", []),
])
def test_view_grain_reads_each_source(sql, basis, columns):
    assert sqltools.view_grain(sql) == (basis, columns)


@pytest.mark.parametrize("sql", [
    "SELECT a FROM t",
    "SELECT a, count(*) FROM t GROUP BY ROLLUP(a)",
    "SELECT a FROM t UNION SELECT a FROM u",
    "SELECT count(*) FROM t",
    "SELECT * FROM t WHERE rn = 1",
    "SELECT * FROM (SELECT *, rank() OVER (PARTITION BY k ORDER BY ts) AS rn FROM t) WHERE rn = 1",
    "version: 1.1\nsource: demo.t\ndimensions:\n  - name: a",  # a metric view's YAML
    "SELEC oops (",
])
def test_view_grain_gives_nothing_it_cannot_say(sql):
    assert sqltools.view_grain(sql) is None


def test_the_group_by_wins_over_distinct_and_a_dedupe_in_a_group_by_view():
    assert sqltools.view_grain("SELECT DISTINCT a, count(*) FROM t GROUP BY a") == ("group_by", ["a"])


def test_labels():
    assert grain.label("primary_key", ["order_id", "line_no"]) == "per order_id × line_no"
    assert grain.label("group_by", ["a", "b", "c"]) == "per a × b × c"
    assert grain.label("group_by", list("abcde")) == "per 5 columns"
    assert grain.label("dedupe", ["k"]) == "per k (latest)"
    assert grain.label("dedupe", list("abcd")) == "per 4 columns (latest)"
    assert grain.label("distinct", []) == "distinct rows"


def pk(*cols, name="pk_t"):
    return [{"primary_key_constraint": {"name": name, "child_columns": list(cols)}}]


def test_a_declared_primary_key_comes_first_and_names_its_basis():
    g = grain.table_grain({"table_type": "MANAGED", "table_constraints": pk("order_id", "line_no")})
    assert g == {"label": "per order_id × line_no", "columns": ["order_id", "line_no"], "basis": "primary_key",
                 "source": "declared primary key pk_t"}


def test_a_view_takes_its_grain_from_its_definition_and_a_plain_table_has_none():
    view = {"table_type": "VIEW", "view_definition": "SELECT a, count(*) FROM t GROUP BY a"}
    assert grain.table_grain(view)["label"] == "per a" and grain.table_grain(view)["basis"] == "group_by"
    mv = {"table_type": "MATERIALIZED_VIEW", "view_definition": "SELECT DISTINCT a FROM t"}
    assert grain.table_grain(mv)["label"] == "distinct rows"
    assert grain.table_grain({"table_type": "MANAGED"}) is None
    assert grain.table_grain({"table_type": "MANAGED", "view_definition": "SELECT a FROM t GROUP BY a"}) is None  # only views have one


def test_a_metric_view_and_an_unparseable_definition_have_no_grain_and_no_error():
    assert grain.table_grain({"table_type": "METRIC_VIEW", "view_definition": "SELECT a FROM t GROUP BY a"}) is None
    assert grain.table_grain({"table_type": "VIEW", "view_definition": "SELEC ((("}) is None
    assert grain.table_grain({"table_type": "VIEW", "view_definition": "version: 1.1\nsource: x"}) is None
