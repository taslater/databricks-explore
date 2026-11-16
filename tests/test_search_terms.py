"""Search terms: dotted paths, globs, escaped LIKE patterns, the warehouse query and the cache search."""
import json
from types import SimpleNamespace

import pytest

from databricks_explore import dbx
from databricks_explore.search_terms import like_matches, like_pattern, parse_term, split_segments


def test_segments_split_on_dots_outside_backticks():
    assert split_segments("dev.hr.emp") == ["dev", "hr", "emp"]
    assert split_segments("`my.cat`.sch.") == ["my.cat", "sch", ""]
    assert split_segments("abc") == ["abc"]


@pytest.mark.parametrize("text,expected", [
    ("cust", (None, None, "cust")),
    ("hr.emp", (None, "hr", "emp")),
    ("dev.", ("dev", None, "")),
    ("dev.hr.", ("dev", "hr", "")),
    ("dev.hr.emp", ("dev", "hr", "emp")),
    ("`a.b`.c.d", ("a.b", "c", "d")),
])
def test_parse_term_reads_the_path(text, expected):
    t = parse_term(text)
    assert (t.catalog, t.schema, t.name) == expected


def test_like_patterns_translate_globs_and_escape_underscores():
    assert like_pattern("cust", anchored=False) == "%cust%"
    assert like_pattern("dim_cust", anchored=False) == "%dim!_cust%"
    assert like_pattern("100%", anchored=False) == "%100!%%"
    assert like_pattern("cust*", anchored=False) == "cust%"  # a glob matches the whole name
    assert like_pattern("a?c", anchored=False) == "a_c"
    assert like_pattern("dev", anchored=True) == "dev"


def test_like_matches_is_the_python_twin():
    assert like_matches("%dim!_cust%", "x_dim_customer")
    assert not like_matches("%dim!_cust%", "dimXcustomer")  # the underscore is literal
    assert like_matches("cust%", "Customer") and not like_matches("cust%", "dim_customer")
    assert like_matches("a_c", "abc") and not like_matches("a_c", "abbc")


def test_a_term_matches_by_part():
    t = parse_term("dev.hr.emp")
    assert t.matches("DEV", "hr", "employees")
    assert not t.matches("devx", "hr", "employees")  # catalog and schema are exact
    assert not t.matches("dev", "hr", "dept")
    assert parse_term("*_raw").matches("lake", "raw", "orders_raw")
    assert not parse_term("*_raw").matches("lake", "raw", "orders_raw2")


def test_plain_text_is_simple_and_globs_and_paths_are_not():
    assert parse_term("cust").simple
    assert not parse_term("cust*").simple and not parse_term("a.b").simple


class FakeWarehouse(dbx.Explorer):
    """An Explorer whose SQL is recorded instead of sent."""

    def __init__(self, rows=()):
        self.warehouse_id = "wh"
        self.calls = []
        self.rows = list(rows)

    def sql(self, statement, **params):
        self.calls.append((" ".join(statement.split()), params))
        return self.rows


def test_the_warehouse_query_filters_each_part_and_keeps_the_underscore_filter():
    ex = FakeWarehouse([{"table_catalog": "dev", "table_schema": "hr", "table_name": "emp_x", "table_type": "MANAGED"}])
    got = ex.search("dev.hr.emp_x")
    statement, params = ex.calls[0]
    assert params == {"cat": "dev", "sch": "hr", "q": "%emp!_x%"}
    assert "left(table_name, 2) <> '__'" in statement
    assert "WHERE NOT startswith" not in statement
    for col in ("table_catalog", "table_schema", "table_name"):
        assert f"lower({col}) LIKE" in statement
    assert "ESCAPE '!'" in statement
    assert got["data"][0]["full_name"] == "dev.hr.emp_x"


def test_a_plain_term_sends_only_the_name_and_a_glob_sends_a_whole_name_pattern():
    ex = FakeWarehouse()
    ex.search("orders")
    ex.search("ord*")
    assert ex.calls[0][1] == {"q": "%orders%"}
    assert ex.calls[1][1] == {"q": "ord%"}
    assert "lower(table_catalog)" not in ex.calls[0][0]


def test_the_cache_search_honors_paths_and_globs(tmp_path):
    for cat, schema, names in (("main", "sales", ["orders", "order_items"]), ("dev", "crm", ["dim_customer"]),
                               ("dev", "hr", ["employees"])):
        p = tmp_path / cat / schema / "objects.json"
        p.parent.mkdir(parents=True)
        p.write_text(json.dumps({"fetched_at": "x", "data": [
            {"name": n, "full_name": f"{cat}.{schema}.{n}", "type": "MANAGED", "comment": None} for n in names]}),
            encoding="utf-8")
    ex = SimpleNamespace(root=tmp_path, warehouse_id=None, profile="dev")

    def names(q):
        return {h["full_name"] for h in dbx.cached_search(ex, q)["data"]}

    assert names("dev.crm.") == {"dev.crm.dim_customer"}
    assert names("dev.") == {"dev.crm.dim_customer", "dev.hr.employees"}
    assert names("hr.emp") == {"dev.hr.employees"}
    assert names("order*") == {"main.sales.orders", "main.sales.order_items"}
    assert names("o?ders") == {"main.sales.orders"}
