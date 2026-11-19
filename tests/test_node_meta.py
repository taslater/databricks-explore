"""Color by: owners and tags for the Graph, the saved color_by of a graph, and the MCP graph tools that take it."""
import json

import pytest

from databricks_explore import app as app_module
from databricks_explore import dbx
from databricks_explore import demo
from databricks_explore import graphs
from mcp_helpers import agent, connected, env  # noqa: F401

LAKE = "demo_lake"
ORDERS, DIM = f"{LAKE}.silver.orders", f"{LAKE}.gold.dim_customer"
MCP_ORDERS, MCP_CUSTOMERS = "demo.sales.orders", "demo.sales.customers"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)
    monkeypatch.setattr(demo, "NORMAL_DELAY", 0)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    c = app_module.app.test_client()
    assert c.post("/api/connect", json={"profile": "demo"}).status_code == 200
    return c


def meta(client, *tables):
    return client.post("/api/node-meta", json={"tables": list(tables)}).get_json()["meta"]


def test_owners_come_from_tables_get_without_a_warehouse_and_tags_are_not_read_yet(client):
    out = meta(client, ORDERS, DIM, "ph:new", "not.enough")
    assert set(out) == {ORDERS, DIM}
    assert out[ORDERS]["owner"] == "data-engineering" and out[DIM]["owner"] == "analytics"
    assert out[ORDERS]["tags"] is None and out[ORDERS]["tags_fetched_at"] is None
    assert client.post("/api/node-meta", json={"tables": "x"}).status_code == 400


def test_the_tag_plan_shows_the_sql_for_each_table_and_reading_needs_a_warehouse(client):
    plan = client.post("/api/node-tags/plan", json={"tables": [DIM, "ph:new"]}).get_json()
    assert [s["table"] for s in plan["statements"]] == [DIM]
    sql = plan["statements"][0]["sql"]
    assert "`demo_lake`.information_schema.table_tags" in sql and "schema_name = 'gold' AND table_name = 'dim_customer'" in sql and ":sch" not in sql
    assert client.post("/api/node-tags/read", json={"tables": [DIM]}).status_code == 400
    assert meta(client, DIM)[DIM]["tags"] is None  # nothing ran


def test_reading_tags_caches_the_table_tags_and_a_second_meta_call_never_queries(client):
    client.post("/api/warehouse", json={"id": "demo-wh-1"})
    out = client.post("/api/node-tags/read", json={"tables": [DIM, ORDERS]}).get_json()
    assert out["errors"] == {} and out["meta"][DIM]["tags"] == {"domain": "sales"}
    assert out["meta"][ORDERS]["tags"] == {} and out["meta"][ORDERS]["tags_fetched_at"]  # read, and it has none: not the same as unread
    client.post("/api/warehouse", json={"id": None})
    again = meta(client, DIM, ORDERS)
    assert again[DIM]["tags"] == {"domain": "sales"} and again[ORDERS]["tags"] == {}


def test_color_by_is_validated_and_saved_unless_it_is_the_default():
    for good in ("schema", "catalog", "owner", "certification", "freshness", "tag:domain", "type"):
        assert graphs.check_color_by(good) == good
    for bad in ("", "colour", "tag:", "tag:   ", None, 3, "tag:" + "x" * 201):
        with pytest.raises(graphs.GraphInvalid):
            graphs.check_color_by(bad)
    nodes = [{"id": "a.b.c", "kind": "table"}]
    assert "color_by" not in graphs.build_body("g", nodes, [])
    assert "color_by" not in graphs.build_body("g", nodes, [], color_by="type")
    assert graphs.build_body("g", nodes, [], color_by="tag:pii")["color_by"] == "tag:pii"
    with pytest.raises(graphs.GraphInvalid):
        graphs.write_graph({"name": "g", "color_by": "nope"})


def test_a_saved_graph_keeps_its_color_by_through_the_routes(client):
    body = {"name": "colored", "color_by": "owner", "nodes": [], "edges": []}
    assert client.post("/api/diagrams", json=body).status_code == 200
    assert client.get("/api/diagrams/colored").get_json()["color_by"] == "owner"
    assert client.post("/api/diagrams", json={**body, "color_by": "nope"}).status_code == 400


def test_create_graph_and_update_graph_take_color_by_and_get_graph_reports_it(agent):
    agent.ok("create_graph", name="c", tables=[MCP_ORDERS, MCP_CUSTOMERS], color_by="schema")
    assert graphs.load_graph("c")["color_by"] == "schema"
    assert json.loads(agent.ok("get_graph", name="c", format="json"))["color_by"] == "schema"
    assert "Color by: schema." in agent.ok("get_graph", name="c")
    agent.ok("update_graph", name="c", remove=[MCP_CUSTOMERS], add=["demo.sales.order_items"])
    assert graphs.load_graph("c")["color_by"] == "schema"  # kept when the tables change
    assert "colored by tag:domain" in agent.ok("update_graph", name="c", color_by="tag:domain")
    assert graphs.load_graph("c")["color_by"] == "tag:domain"
    agent.ok("update_graph", name="c", color_by="type")
    assert "color_by" not in graphs.load_graph("c") and json.loads(agent.ok("get_graph", name="c", format="json"))["color_by"] == "type"
    assert "color_by" in agent.fails("create_graph", name="d", tables=[MCP_ORDERS], color_by="bogus")
    assert not graphs.exists("d")
