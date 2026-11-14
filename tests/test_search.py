"""Table search without a warehouse: every cached table in every catalog, not only the schemas browsed last."""
import json
from types import SimpleNamespace

import pytest

import app as app_module
import dbx


def write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"fetched_at": "2026-11-13", "data": payload}), encoding="utf-8")


@pytest.fixture
def ex(tmp_path):
    for cat, schema, names in (("main", "sales", ["orders", "order_items"]), ("samples", "tpch", ["orders", "customer"]),
                               ("dev", "crm", ["dim_customer"])):
        write(tmp_path / cat / schema / "objects.json",
              [{"name": n, "full_name": f"{cat}.{schema}.{n}", "type": "MANAGED", "comment": None} for n in names])
    # a table whose schema was never listed, only the table itself was opened
    write(tmp_path / "lake" / "raw" / "obj" / "lake.raw.orders_raw.json",
          {"full_name": "lake.raw.orders_raw", "table_type": "EXTERNAL", "columns": []})
    return SimpleNamespace(root=tmp_path, warehouse_id=None, profile="dev")


def names(result):
    return [h["full_name"] for h in result["data"]]


def test_search_reads_every_catalog_in_the_cache(ex):
    assert set(names(dbx.cached_search(ex, "orders"))) == {
        "main.sales.orders", "samples.tpch.orders", "lake.raw.orders_raw"}
    assert names(dbx.cached_search(ex, "customer")) == ["samples.tpch.customer", "dev.crm.dim_customer"]


def test_name_matches_come_before_path_matches(ex):
    write(ex.root / "customer_mart" / "gold" / "objects.json",
          [{"name": "sales", "full_name": "customer_mart.gold.sales", "type": "MANAGED"}])
    got = names(dbx.cached_search(ex, "customer"))
    assert got == ["samples.tpch.customer", "dev.crm.dim_customer", "customer_mart.gold.sales"]
    assert names(dbx.cached_search(ex, "tpch")) == ["samples.tpch.customer", "samples.tpch.orders"]


def test_a_table_opened_but_never_listed_is_found_with_its_type(ex):
    (hit,) = dbx.cached_search(ex, "orders_raw")["data"]
    assert hit == {"full_name": "lake.raw.orders_raw", "name": "orders_raw", "type": "EXTERNAL"}


def test_the_full_name_and_any_case_match(ex):
    assert names(dbx.cached_search(ex, "SAMPLES.tpch.Orders")) == ["samples.tpch.orders"]


def test_an_empty_term_matches_nothing_and_the_result_is_capped(ex):
    assert dbx.cached_search(ex, "  ")["data"] == []
    assert len(dbx.cached_search(ex, "o", limit=2)["data"]) == 2


def test_the_route_searches_the_cache_without_a_warehouse_and_the_warehouse_otherwise(ex, monkeypatch):
    monkeypatch.setitem(app_module.STATE, "ex", ex)
    c = app_module.app.test_client()
    got = c.get("/api/search?q=orders").json
    assert "samples.tpch.orders" in names(got) and "tables already browsed" in got["source"]
    ex.warehouse_id = "wh"
    ex.search = lambda q: {"source": "information_schema", "data": [{"full_name": "x.y.z"}]}
    assert c.get("/api/search?q=orders").json["source"] == "information_schema"
