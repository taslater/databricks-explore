"""The graph tools: read, create, update, rename and delete the diagrams saved from the Graph tab."""
import json

from mcp_helpers import agent, connected, env, offline_agent  # noqa: F401

ORDERS, CUSTOMERS, ITEMS = "demo.sales.orders", "demo.sales.customers", "demo.sales.order_items"
VIEW, EMPLOYEES = "demo.sales.v_daily_revenue", "demo.hr.employees"


def graph_json(agent, name):
    return json.loads(agent.ok("get_graph", name=name, format="json"))


def test_a_graph_saved_from_the_ui_is_found_by_list_graphs_and_read_by_get_graph_under_either_name(agent, connected):
    body = {"name": "Returns graph", "focus_schema": "demo.sales", "nodes": [
        {"data": {"id": ORDERS, "label": "orders", "kind": "managed", "focus": True}, "position": {"x": 0, "y": 0}},
        {"data": {"id": CUSTOMERS, "label": "customers", "kind": "managed"}, "position": {"x": 200, "y": 0}}],
        "edges": [{"data": {"id": f"fk:{ORDERS}->{CUSTOMERS}", "source": ORDERS, "target": CUSTOMERS, "kind": "fk", "status": "derived",
                            "child_columns": ["customer_id"], "parent_columns": ["customer_id"], "label": "customer_id"}}]}
    assert connected.post("/api/diagrams", json=body).get_json()["saved"] == "Returns_graph"
    out = agent.ok("list_graphs").splitlines()
    assert out[0] == "1 graph(s)" and out[1].startswith("Returns_graph: 2 tables, 1 edges, revision 1 (ui), saved ")
    assert "named 'Returns graph'" in out[1]
    for name in ("Returns graph", "Returns_graph"):
        text = agent.ok("get_graph", name=name)
        assert f"{ORDERS} [managed] focus" in text and f"{ORDERS} -> {CUSTOMERS}  fk derived (customer_id)" in text
    j = graph_json(agent, "Returns graph")
    assert j["focus_schema"] == "demo.sales" and j["nodes"][0] == {"table": ORDERS, "kind": "managed", "focus": True, "x": 0, "y": 0}
    assert j["edges"][0]["columns"] == ["customer_id"]
    assert "not found" in agent.fails("get_graph", name="nope")


def test_list_graphs_and_list_canvases_point_at_each_other_when_empty_or_missing(agent, connected):
    assert "list_canvases" in agent.ok("list_graphs")
    assert "list_graphs" in agent.ok("list_canvases")
    connected.post("/api/diagrams", json={"name": "g1", "nodes": [], "edges": []})
    assert "use get_graph" in agent.fails("get_canvas", name="g1")
    assert agent.fails("get_canvas", name="nothing") == "canvas not found: nothing"


def test_graph_tools_need_no_connection(offline_agent, env):
    assert offline_agent.ok("list_graphs").startswith("0 graph(s)")
    env.post("/api/diagrams", json={"name": "g1", "nodes": [], "edges": []})
    assert "g1: 0 tables, 0 edges, revision 1 (ui)" in offline_agent.ok("list_graphs")


def test_the_read_tools_are_listed_and_read_only(agent):
    by = {t["name"]: t for t in agent.rpc("tools/list").get_json()["result"]["tools"]}
    assert by["list_graphs"]["annotations"]["readOnlyHint"] and by["get_graph"]["annotations"]["readOnlyHint"]
