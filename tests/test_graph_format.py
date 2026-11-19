"""The saved-graph file: every field the Graph tab writes survives a save, an agent's change, a rename and a delete, and a graph saved by 0.9.0 still opens."""
import json

from databricks_explore import dbx, graphs
from mcp_helpers import agent, connected, env, offline_agent  # noqa: F401

ORDERS, CUSTOMERS, ITEMS = "demo.sales.orders", "demo.sales.customers", "demo.sales.order_items"
FIELDS = ("color_by", "grouping", "lens", "lens_positions")


def node(table, x, y, **data):
    return {"data": {"id": table, "label": table.rsplit(".", 1)[1], "kind": "managed", **data}, "position": {"x": x, "y": y}}


def full_body(name="Full graph"):
    return {"name": name, "focus_schema": "demo.sales", "color_by": "tag:domain",
            "grouping": {"by": "tag:domain", "collapsed": ["sales"], "expanded": ["hr"], "chains": False},
            "lens": "model", "lens_positions": {"all": {ORDERS: {"x": 10, "y": 20}, CUSTOMERS: {"x": 30.5, "y": 40}, ITEMS: {"x": 50, "y": 60}},
                                                "flow": {ORDERS: {"x": 1, "y": 2}}},
            "nodes": [node(ORDERS, 0, 0, focus=True, pinned=True), node(CUSTOMERS, 200, 0, pinned=True), node(ITEMS, 0, 200, pinned=True)],
            "edges": [{"data": {"id": f"fk:{ORDERS}->{CUSTOMERS}", "source": ORDERS, "target": CUSTOMERS, "kind": "fk", "status": "derived", "child_columns": ["customer_id"], "parent_columns": ["customer_id"], "label": "customer_id"}},
                      {"data": {"id": f"fk:{ITEMS}->{ORDERS}", "source": ITEMS, "target": ORDERS, "kind": "fk", "status": "derived", "child_columns": ["order_id"], "parent_columns": ["order_id"], "label": "order_id"}}]}


def kept(data):
    return {k: data[k] for k in FIELDS if k in data}


def test_every_new_field_survives_the_save_a_rename_through_the_page_and_a_rename_by_an_agent(agent, connected):
    body = full_body()
    assert connected.post("/api/diagrams", json=body).status_code == 200
    saved = connected.get("/api/diagrams/Full_graph").get_json()
    assert kept(saved) == kept(body)
    assert connected.post("/api/diagrams/Full_graph/rename", json={"new_name": "Renamed"}).status_code == 200
    assert kept(connected.get("/api/diagrams/Renamed").get_json()) == kept(body)
    agent.ok("rename_graph", name="Renamed", new_name="Again")
    again = connected.get("/api/diagrams/Again").get_json()
    assert kept(again) == kept(body) and again["nodes"] == body["nodes"] and again["edges"] == body["edges"]


def test_an_agent_reads_every_new_field_and_keeps_them_when_it_changes_the_tables(agent, connected):
    body = full_body()
    connected.post("/api/diagrams", json=body)
    j = json.loads(agent.ok("get_graph", name="Full graph", format="json"))
    assert (j["color_by"], j["lens"], j["lens_positions"]) == ("tag:domain", "model", body["lens_positions"])
    assert j["grouping"] == {"by": "tag:domain", "chains": False}
    agent.ok("update_graph", name="Full graph", remove=[ITEMS])
    after = graphs.load_graph("Full graph")
    assert after["color_by"] == "tag:domain" and after["lens"] == "model"
    assert after["grouping"] == body["grouping"]  # the whole choice, collapsed and expanded names included
    assert after["lens_positions"] == {"all": {ORDERS: {"x": 10, "y": 20}, CUSTOMERS: {"x": 30.5, "y": 40}}, "flow": {ORDERS: {"x": 1, "y": 2}}}  # the table that left is forgotten
    agent.ok("update_graph", name="Full graph", add=[ITEMS], lens="flow")  # a switch of lens takes that lens's positions back
    flow = graphs.load_graph("Full graph")
    assert flow["lens"] == "flow" and flow["grouping"] == body["grouping"] and flow["color_by"] == "tag:domain"
    assert flow["lens_positions"]["model"] and "flow" not in flow["lens_positions"]
    pos = {n["data"]["id"]: n["position"] for n in flow["nodes"]}
    assert pos[ORDERS] == {"x": 1, "y": 2}


def test_a_deleted_graph_leaves_every_field_in_the_trash_copy(agent, connected):
    body = full_body()
    connected.post("/api/diagrams", json=body)
    trash = connected.delete("/api/diagrams/Full_graph").get_json()["trash"]
    copy = json.loads((dbx.DIAGRAMS / ".trash" / trash).read_text(encoding="utf-8"))
    assert kept(copy) == kept(body) and copy["nodes"] == body["nodes"]
    assert graphs.list_graphs() == []


def test_a_graph_saved_by_0_9_0_still_opens_reads_and_takes_an_agents_change(agent, connected):
    old = {"name": "Old graph", "saved_at": "2026-11-10T09:00:00Z", "focus_schema": "demo.sales",
           "nodes": [{"data": {"id": ORDERS, "label": "orders", "kind": "managed", "focus": True, "external": False}, "position": {"x": 0, "y": 0}},
                     {"data": {"id": CUSTOMERS, "label": "customers", "kind": "managed", "external": False}, "position": {"x": 200, "y": 0}}],
           "edges": [{"data": {"id": f"fk:{ORDERS}->{CUSTOMERS}", "source": ORDERS, "target": CUSTOMERS, "kind": "fk", "status": "derived", "label": "customer_id", "child_columns": ["customer_id"]}}]}
    dbx.DIAGRAMS.mkdir(parents=True, exist_ok=True)
    (dbx.DIAGRAMS / "Old_graph.json").write_text(json.dumps(old), encoding="utf-8")
    assert connected.get("/api/diagrams").get_json() == ["Old_graph"]
    assert connected.get("/api/diagrams/Old_graph").get_json()["nodes"] == old["nodes"]
    j = json.loads(agent.ok("get_graph", name="Old graph", format="json"))
    assert (j["lens"], j["color_by"], j["grouping"]["by"]) == ("all", "type", "schema") and "lens_positions" not in j
    assert [n["table"] for n in j["nodes"]] == [ORDERS, CUSTOMERS]
    agent.ok("update_graph", name="Old graph", add=[ITEMS])
    new = graphs.load_graph("Old_graph")
    assert not set(FIELDS) & set(new)  # nothing is written that was not asked for
    assert {n["data"]["id"] for n in new["nodes"]} == {ORDERS, CUSTOMERS, ITEMS}
    assert next(n for n in new["nodes"] if n["data"]["id"] == ORDERS)["position"] == {"x": 0, "y": 0}  # the old positions stay
    assert "Old_graph" in agent.ok("list_graphs")
    assert connected.post("/api/diagrams", json=new).status_code == 200  # and the page can save it back
