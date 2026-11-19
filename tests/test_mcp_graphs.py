"""The graph tools: read, create, update, rename and delete the diagrams saved from the Graph tab."""
import json

from databricks_explore import dbx
from databricks_explore import graphs
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
        assert f"{ORDERS} [managed] focus" in text and f"{ORDERS} -> {CUSTOMERS}  fk (reference) derived (customer_id)" in text
    j = graph_json(agent, "Returns graph")
    assert j["focus_schema"] == "demo.sales" and j["lens"] == "all"
    assert j["nodes"][0] == {"table": ORDERS, "kind": "managed", "focus": True, "role": {"role": "fact", "reason": "references customers and nothing references it"}, "x": 0, "y": 0}
    assert j["edges"][0]["columns"] == ["customer_id"] and j["edges"][0]["family"] == "reference"
    assert "not found" in agent.fails("get_graph", name="nope")


def test_list_graphs_and_list_canvases_point_at_each_other_when_empty_or_missing(agent, connected):
    assert "list_canvases" in agent.ok("list_graphs")
    assert "list_graphs" in agent.ok("list_canvases")
    agent.ok("create_graph", name="g1", tables=[ORDERS, CUSTOMERS])
    assert "use get_graph" in agent.fails("get_canvas", name="g1")
    assert agent.fails("get_canvas", name="nothing") == "canvas not found: nothing"


def test_create_graph_makes_nodes_for_the_tables_and_the_edges_the_app_knows(agent):
    out = agent.ok("create_graph", name="Sales path", tables=[ITEMS, ORDERS, CUSTOMERS, VIEW], focus=ORDERS)
    assert out.startswith("created graph Sales_path: 4 tables, 3 edges (fk 2, view_dep 1). revision 1.")
    assert "lineage" not in out  # the pair is drawn once, as the view dependency (relations() keeps one edge per pair)
    j = graph_json(agent, "Sales path")
    assert {n["table"] for n in j["nodes"]} == {ORDERS, ITEMS, CUSTOMERS, VIEW}
    assert [n["table"] for n in j["nodes"] if n.get("focus")] == [ORDERS] and all(n["pinned"] for n in j["nodes"])
    assert {(e["kind"], e["source"], e["target"]) for e in j["edges"]} == {
        ("fk", ITEMS, ORDERS), ("fk", ORDERS, CUSTOMERS), ("view_dep", ORDERS, VIEW)}
    assert j["focus_schema"] == "demo.sales"
    saved = graphs.load_graph("Sales path")  # the file is what the Graph tab loads
    assert saved["nodes"][0]["data"].keys() >= {"id", "label", "kind", "external", "pinned"} and "position" in saved["nodes"][0]
    fk = next(e["data"] for e in saved["edges"] if e["data"]["id"] == f"fk:{ITEMS}->{ORDERS}")
    assert fk["child_columns"] == ["order_id"] and fk["parent_columns"] == ["order_id"] and fk["patch_ids"] == [fk["id"]]


def test_create_graph_lays_the_tables_out_left_to_right_without_overlaps(agent):
    agent.ok("create_graph", name="g", tables=[ORDERS, VIEW, CUSTOMERS, ITEMS, EMPLOYEES])
    j = graph_json(agent, "g")
    at = {n["table"]: (n["x"], n["y"]) for n in j["nodes"]}
    assert at[ORDERS][0] < at[VIEW][0]  # what is built from a table is to its right
    assert len(set(at.values())) == 5
    assert at[EMPLOYEES][1] != at[ORDERS][1]  # a table with no relationship is its own band


def test_create_graph_refuses_a_taken_name_either_way_and_bad_input(agent):
    agent.ok("create_graph", name="Returns graph", tables=[ORDERS])
    assert "already exists" in agent.fails("create_graph", name="Returns_graph", tables=[ORDERS])
    assert "already exists" in agent.fails("create_graph", name="Returns graph", tables=[ORDERS])
    assert "not one of the tables" in agent.fails("create_graph", name="x", tables=[ORDERS], focus=CUSTOMERS)
    assert "catalog.schema.table" in agent.fails("create_graph", name="x", tables=["orders"])
    assert "cannot read demo.sales.nope" in agent.fails("create_graph", name="x", tables=[ORDERS, "demo.sales.nope"])
    assert graphs.list_graphs() == ["Returns_graph"]


def test_create_graph_needs_a_connection(offline_agent):
    assert "Not connected" in offline_agent.fails("create_graph", name="x", tables=[ORDERS])
    assert offline_agent.ok("list_graphs").startswith("0 graph(s)")


def test_only_derived_and_accepted_edges_are_drawn(agent, connected):
    body = {"source": {"table": EMPLOYEES, "column": "emp_id"}, "target": {"table": CUSTOMERS, "column": "customer_id"}}
    rid = connected.post("/api/relationships", json=body).get_json()["id"]  # a manual edge is accepted
    for status, expect in (("accepted", 1), ("proposed", 0), ("rejected", 0)):
        assert connected.patch(f"/api/relationships/{rid}", json={"status": status}).status_code == 200
        agent.ok("create_graph", name=f"g_{status}", tables=[EMPLOYEES, CUSTOMERS])
        edges = graph_json(agent, f"g_{status}")["edges"]
        assert len(edges) == expect and all(e["kind"] == "manual" for e in edges), status


def test_update_graph_adds_and_removes_tables_keeps_positions_and_derives_edges_again(agent):
    agent.ok("create_graph", name="g", tables=[ORDERS, CUSTOMERS])
    before = {n["table"]: (n["x"], n["y"]) for n in graph_json(agent, "g")["nodes"]}
    out = agent.ok("update_graph", name="g", add=[ITEMS, EMPLOYEES])
    assert out.startswith("updated graph g: 4 tables, 2 edges (fk 2). revision 2. added 2.")
    assert "no known relationship" in out and EMPLOYEES in out
    after = {n["table"]: (n["x"], n["y"]) for n in graph_json(agent, "g")["nodes"]}
    assert all(after[t] == before[t] for t in before) and len(set(after.values())) == 4
    out = agent.ok("update_graph", name="g", remove=[CUSTOMERS])
    assert "3 tables, 1 edges (fk 1)" in out and "revision 3" in out
    assert {n["table"] for n in graph_json(agent, "g")["nodes"]} == {ORDERS, ITEMS, EMPLOYEES}
    agent.ok("update_graph", name="g", relayout=True)
    assert "revision 4" in agent.ok("get_graph", name="g")


def test_update_graph_errors(agent):
    agent.ok("create_graph", name="g", tables=[ORDERS, CUSTOMERS])
    assert "nothing to do" in agent.fails("update_graph", name="g")
    assert "not on the graph" in agent.fails("update_graph", name="g", remove=[ITEMS])
    assert "leave the graph empty" in agent.fails("update_graph", name="g", remove=[ORDERS, CUSTOMERS])
    assert "not found" in agent.fails("update_graph", name="zzz", add=[ITEMS])
    assert "revision 1" in agent.ok("get_graph", name="g")  # nothing was written
    assert "revision 1" not in agent.ok("update_graph", name="g", add=[CUSTOMERS, "demo.sales.orders"])  # already there: still a write, no change


def test_rename_graph_and_delete_graph_with_a_trash_copy(agent, tmp_path):
    agent.ok("create_graph", name="Returns graph", tables=[ORDERS, CUSTOMERS])
    assert agent.ok("rename_graph", name="Returns graph", new_name="Sales view") == "renamed graph Returns graph to Sales_view. revision 2."
    assert graphs.list_graphs() == ["Sales_view"] and graphs.load_graph("Sales_view")["name"] == "Sales view"
    assert "not found" in agent.fails("get_graph", name="Returns graph")
    agent.ok("create_graph", name="other", tables=[ORDERS])
    assert "already exists" in agent.fails("rename_graph", name="Sales view", new_name="other")
    out = agent.ok("delete_graph", name="Sales view")
    assert out.startswith("deleted graph Sales_view. A copy is in diagrams/.trash/Sales_view.")
    assert graphs.list_graphs() == ["other"]
    kept = list((tmp_path / "diagrams" / ".trash").glob("Sales_view.*.json"))
    assert len(kept) == 1 and json.loads(kept[0].read_text())["name"] == "Sales view"
    assert "not found" in agent.fails("delete_graph", name="Sales view")
    agent.ok("create_graph", name="Sales view", tables=[ORDERS])  # a name freed by a delete can be used, and its revision keeps counting
    assert "revision 3" in agent.ok("get_graph", name="Sales view")


def test_the_tools_are_listed_and_the_instructions_name_the_separate_store(agent):
    names = {t["name"] for t in agent.rpc("tools/list").get_json()["result"]["tools"]}
    assert {"list_graphs", "get_graph", "create_graph", "update_graph", "rename_graph", "delete_graph"} <= names
    by = {t["name"]: t for t in agent.rpc("tools/list").get_json()["result"]["tools"]}
    assert by["list_graphs"]["annotations"]["readOnlyHint"] and by["delete_graph"]["annotations"]["destructiveHint"]
    assert not by["create_graph"]["annotations"]["readOnlyHint"]


def test_get_graph_has_the_grain_and_the_cached_size_and_freshness_of_each_table(agent, connected):
    lake = ["demo_lake.silver.orders", "demo_lake.silver.shipments", "demo_lake.gold.revenue_metrics"]
    agent.ok("create_graph", name="lake", tables=lake)
    connected.post("/api/node-facts", json={"tables": lake})  # reads tables.get, so the grain is cached
    before = graph_json(agent, "lake")["nodes"]
    assert [n.get("rows") for n in before] == [None] * 3 and "late" not in before[0]  # nothing read yet
    connected.post("/api/warehouse", json={"id": "demo-wh-1"})
    assert connected.post("/api/table-stats/read", json={"tables": lake}).status_code == 200
    nodes = {n["table"]: n for n in graph_json(agent, "lake")["nodes"]}
    orders, shipments, metrics = (nodes[t] for t in lake)
    assert orders["grain"] == {"label": "per order_id", "basis": "primary_key", "columns": ["order_id"], "source": "declared primary key pk_orders"}
    assert orders["rows"] == 12_100_000 and orders["bytes"] > 0 and orders["late"] is False and orders["last_write"]["operation"]
    assert shipments["late"] is True
    assert "grain" not in metrics and "rows" not in metrics
    text = agent.ok("get_graph", name="lake")
    assert "per order_id, 12,100,000 rows" in text and "late)" in text


def test_get_graph_reports_the_crows_foot_ends_of_reference_edges_and_nothing_for_flow(agent):
    agent.ok("create_graph", name="Ends", tables=[ITEMS, ORDERS, CUSTOMERS, VIEW])
    j = graph_json(agent, "Ends")
    by = {(e["kind"], e["source"], e["target"]): e for e in j["edges"]}
    fk = by[("fk", ITEMS, ORDERS)]["cardinality"]
    assert fk["source"]["end"] == "zero_many" and fk["target"]["end"] in ("one", "zero_one") and "sentence" in fk
    assert "cardinality" not in by[("view_dep", ORDERS, VIEW)]  # only reference edges have ends
    text = agent.ok("get_graph", name="Ends")
    assert f"{ITEMS} -> {ORDERS}  fk (reference) derived (order_id) [order_items o<, orders " in text
