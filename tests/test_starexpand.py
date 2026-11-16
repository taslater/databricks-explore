"""Expanding * into columns: the sqlglot logic with a fake column lookup, then the route in demo mode."""
import pytest

from databricks_explore import app as app_module  # noqa: E402
from databricks_explore import dbx, demo  # noqa: E402
from databricks_explore import starexpand  # noqa: E402
from databricks_explore.starexpand import StarError, expand_star  # noqa: E402

COLUMNS = {
    "dev.crm.customers": ["id", "name", "group"],
    "dev.crm.orders": ["order_id", "customer_id", "total"],
}


def lookup(name):
    if name not in COLUMNS:
        raise StarError(f"Could not read the columns of {name}: not found")
    return COLUMNS[name]


def expand(sql, marker="*", **kw):
    """Expands the first `marker` in sql and returns the statement as the editor would leave it."""
    out = expand_star(sql, sql.index(marker) + kw.pop("shift", 0), lookup, "dev", "crm", **kw)
    return sql[:out["start"]] + out["text"] + sql[out["end"]:], out


def test_one_table_lists_plain_columns_on_one_line():
    sql, out = expand("SELECT * FROM customers LIMIT 5")
    assert sql == "SELECT id, name, `group` FROM customers LIMIT 5"
    assert out["count"] == 3


def test_a_star_on_its_own_line_gets_one_column_per_line_and_keeps_the_rest():
    sql, _ = expand("SELECT\n  *\nFROM dev.crm.customers  -- keep me\nWHERE id > 1")
    assert sql == "SELECT\n  id,\n  name,\n  `group`\nFROM dev.crm.customers  -- keep me\nWHERE id > 1"


def test_several_tables_are_qualified_by_alias():
    sql, _ = expand("SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id")
    assert sql.startswith("SELECT c.id, c.name, c.`group`, o.order_id, o.customer_id, o.total FROM")


def test_a_qualified_star_expands_only_that_table_and_keeps_the_qualifier():
    sql, _ = expand("SELECT o.*, c.name FROM customers c JOIN orders o ON o.customer_id = c.id")
    assert sql.startswith("SELECT o.order_id, o.customer_id, o.total, c.name FROM")


def test_the_cursor_may_be_on_the_alias_part_or_just_after_the_star():
    on_alias, _ = expand("SELECT o.*, 1 FROM orders o", marker="o.*")
    after_star, _ = expand("SELECT o.*, 1 FROM orders o", marker="*", shift=1)
    assert on_alias == after_star == "SELECT o.order_id, o.customer_id, o.total, 1 FROM orders o"


def test_a_backquoted_qualifier_is_replaced_whole():
    sql, _ = expand("SELECT `my o`.* FROM orders `my o`", marker="*")
    assert sql == "SELECT `my o`.order_id, `my o`.customer_id, `my o`.total FROM orders `my o`"


def test_except_is_honored_and_replaced_with_the_star():
    sql, _ = expand("SELECT * EXCEPT (name, `group`) FROM customers")
    assert sql == "SELECT id FROM customers"


def test_a_subquery_source_is_resolved_through_its_own_select_list():
    sql, _ = expand("SELECT * FROM (SELECT id, upper(name) AS shout FROM customers) t")
    assert sql == "SELECT id, shout FROM (SELECT id, upper(name) AS shout FROM customers) t"


def test_a_cte_with_a_star_is_expanded_through_the_table():
    sql, _ = expand("WITH c AS (SELECT id, name FROM customers) SELECT * FROM c", marker="* FROM c")
    assert sql.endswith("SELECT id, name FROM c")


def test_the_star_inside_a_subquery_is_the_one_expanded():
    sql, _ = expand("SELECT total FROM (SELECT * FROM orders) x")
    assert sql == "SELECT total FROM (SELECT order_id, customer_id, total FROM orders) x"


def test_offsets_count_utf16_units():
    text = "SELECT '😀', * FROM orders"
    star_utf16 = len("SELECT '😀', ".encode("utf-16-le")) // 2
    out = expand_star(text, star_utf16, lookup, "dev", "crm")
    assert (out["start"], out["end"]) == (star_utf16, star_utf16 + 1)
    assert out["text"] == "order_id, customer_id, total"


@pytest.mark.parametrize("sql, marker, message", [
    ("SELECT COUNT(*) FROM customers", "*", "not in a SELECT list"),
    ("SELECT 1 FROM customers", "SELECT", "Put the cursor on a *"),
    ("SELECT * FROM missing", "*", "Could not read the columns of dev.crm.missing"),
    ("SELECT * FROM TABLE(range(3))", "*", "not a table or a subquery"),
    ("SELECT x.* FROM customers", "*", "No table or alias named x"),
    ("SELECT * REPLACE (1 AS id) FROM customers", "*", "REPLACE"),
    ("SELECT * FROM (SELECT * FROM nope) t", "* FROM (", "Could not read the columns"),
    ("SELECT * FROM {{other}}", "*", "{{window}}"),
    ("SELECT * FROM", "*", "Cannot read this statement"),
])
def test_stars_that_cannot_be_expanded_say_why(sql, marker, message):
    with pytest.raises(StarError, match=message.replace("*", r"\*").replace("{", r"\{").replace("}", r"\}")):
        expand_star(sql, sql.index(marker), lookup, "dev", "crm")


def test_an_unqualified_name_needs_a_default_catalog():
    with pytest.raises(StarError, match="Cannot tell which catalog"):
        expand_star("SELECT * FROM customers", 7, lookup)


def test_quote_ident_quotes_reserved_words_and_odd_names():
    assert [starexpand.quote_ident(n) for n in ("a", "order", "a b", "1x", "x`y")] == ["a", "`order`", "`a b`", "`1x`", "`x``y`"]


# ---- the route, in demo mode --------------------------------------------------------------------------

@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    c = app_module.app.test_client()
    assert c.post("/api/connect", json={"profile": "demo"}).status_code == 200
    return c


def test_route_expands_a_join_in_demo_mode(client):
    sql = "SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c ON c.customer_id = o.customer_id"
    r = client.post("/api/sql/expand-star", json={"sql": sql, "offset": 7})
    assert r.status_code == 200
    assert (r.json["start"], r.json["end"]) == (7, 8)
    assert r.json["text"].startswith("o.order_id, o.customer_id")
    assert "c.customer_id" in r.json["text"]
    assert r.json["count"] == len(r.json["text"].split(", "))


def test_route_uses_the_default_catalog_and_schema(client):
    r = client.post("/api/sql/expand-star", json={"sql": "SELECT * FROM orders", "offset": 7, "catalog": "demo", "schema": "sales"})
    assert r.status_code == 200 and r.json["text"].startswith("order_id, customer_id")


def test_route_reports_an_unknown_table_as_a_400_with_a_message(client):
    r = client.post("/api/sql/expand-star", json={"sql": "SELECT * FROM demo.sales.nope", "offset": 7})
    assert r.status_code == 400
    assert "Could not read the columns of demo.sales.nope" in r.json["error"]


def test_route_reports_a_star_that_is_not_in_a_select_list(client):
    r = client.post("/api/sql/expand-star", json={"sql": "SELECT count(*) FROM demo.sales.orders", "offset": 14})
    assert r.status_code == 400 and "not in a SELECT list" in r.json["error"]
