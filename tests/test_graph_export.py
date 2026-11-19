"""Graph export: Mermaid for both lenses (golden files), the legend, the PNG, the route and the MCP tool."""
import base64
import os
from io import BytesIO
from pathlib import Path

from PIL import Image

from databricks_explore import demo_lake, graph_export
from mcp_helpers import agent, connected, env, offline_agent  # noqa: F401

GOLDEN = Path(__file__).parent / "golden" / "graph_export"
LAKE_TABLES = [t for t in demo_lake.TABLES if ".gold." in t or t.endswith("silver.orders") or "v_orders" in t]


def golden(name, text):
    """Compares with tests/golden/graph_export/<name>; UPDATE_GOLDEN=1 rewrites the file."""
    path = GOLDEN / name
    if os.environ.get("UPDATE_GOLDEN"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    assert text == path.read_text(encoding="utf-8")


def lake_graph(agent):
    agent.ok("create_graph", name="lake", tables=LAKE_TABLES)


def edge(id, kind, source, target, **more):
    return {"id": id, "kind": kind, "source": source, "target": target, **more}


NODES = [{"id": "c.s.orders", "kind": "managed"}, {"id": "c.s.v_orders", "kind": "view"}, {"id": "c.s.customers", "kind": "managed"}, {"id": "c.t.orders", "kind": "managed"}]
EDGES = [edge("l1", "lineage", "c.s.orders", "c.s.v_orders", status="derived"),
         edge("f1", "fk", "c.s.orders", "c.s.customers", status="derived", label='cust "id"'),
         edge("j1", "join_mined", "c.t.orders", "c.s.orders", status="proposed", label="order_id"),
         edge("x1", "fk", "c.s.orders", "c.s.customers", status="rejected"),
         edge("m1", "concept_link", "c.s.orders", "c.s.customers"),
         edge("s1", "lineage", "c.s.orders", "c.s.orders")]


def test_the_demo_lakes_model_lens_is_an_er_diagram_with_crows_feet_and_key_columns(agent):
    lake_graph(agent)
    golden("lake_model.mmd", agent.ok("export_graph", name="lake", lens="model"))


def test_the_demo_lakes_flow_lens_is_a_left_to_right_flowchart(agent):
    lake_graph(agent)
    golden("lake_flow.mmd", agent.ok("export_graph", name="lake"))


def test_the_flowchart_labels_flow_edges_with_glyphs_and_dashes_inferred_ones():
    text = graph_export.flowchart(NODES, EDGES, {"l1": ["join", "aggregate", "nope"]})
    assert text.splitlines()[:5] == ["flowchart LR", '  n1["s.customers"]', '  n2["s.orders"]', '  n3(["s.v_orders"])', '  n4["t.orders"]']  # tables with the same name are told apart by schema
    assert text.splitlines()[5:] == ['  n2 ---|"cust #quot;id#quot;"| n1', '  n2 -->|"⋈ Σ"| n3', '  n4 -.-|"order_id"| n2']  # rejected, meaning and self edges are left out; a quote cannot end a label


def test_a_bidirectional_lineage_edge_points_both_ways():
    assert "n1 <--> n2" in graph_export.flowchart(NODES[:2], [edge("b", "lineage", "c.s.orders", "c.s.v_orders", bidir=True)])


def test_the_er_diagram_writes_the_referenced_table_first_and_says_which_ends_are_unknown():
    keys = {"c.s.customers": [{"name": "id", "type": "decimal(10,2)", "pk": True, "fk": False}], "c.s.orders": [{"name": "cust id", "type": "", "pk": True, "fk": True}]}
    cards = {"f1": {"source": {"end": "zero_many"}, "target": {"end": "one"}}, "j1": {"source": {"end": "one"}, "target": None}}
    lines = graph_export.er_diagram(NODES, EDGES, keys, cards).splitlines()
    assert lines[:2] == ["erDiagram", "  %% ends not known (drawn as zero or more): t.orders -> s.orders"]
    assert "    decimal id PK" in lines and "    string cust_id PK, FK" in lines
    assert lines[-2:] == ['  s_customers ||--o{ s_orders : "cust #quot;id#quot;"', '  t_orders ||..o{ s_orders : "order_id"']  # the proposed join is dotted


def test_the_legend_lists_only_what_is_drawn():
    cards = {"f1": {"source": {"end": "zero_many"}, "target": {"end": "one"}}}
    keys = {"c.s.orders": [{"name": "id", "type": "int", "pk": True, "fk": False}]}
    assert graph_export.legend("model", EDGES, cards, keys) == ["key reference", "dashed: inferred or proposed", graph_export._END_TEXT, "PK primary key, FK foreign key"]
    assert graph_export.legend("flow", EDGES, {}, {}) == ["data flows", "key reference", "dashed: inferred or proposed"]
    assert graph_export.legend("flow", EDGES[:1], {}, {}) == ["data flows"]
    assert graph_export.legend("model", EDGES[:1], {}, keys) == ["PK primary key, FK foreign key"]
    assert graph_export.legend("model", [], {}, {}) == []


def test_the_demo_lakes_model_legend_has_only_references_ends_and_keys(agent):
    lake_graph(agent)
    data = agent.ok("get_graph", name="lake", format="json")
    import json
    edges = json.loads(data)["edges"]
    out = graph_export.legend("model", edges, {e["id"]: e["cardinality"] for e in edges if e.get("cardinality")}, {"t": [{"name": "k", "type": "int", "pk": True, "fk": False}]})
    assert out == ["key reference", graph_export._END_TEXT, "PK primary key, FK foreign key"]


def test_the_png_legend_gives_a_long_line_a_row_of_its_own():
    rows = graph_export._legend_rows(["data flows", "key reference", graph_export._END_TEXT, "PK primary key, FK foreign key", "dashed: inferred or proposed"])
    assert [len(r) for r in rows] == [2, 1, 2]
    assert graph_export._legend_rows([]) == []


def test_the_date_is_the_oldest_read_among_the_evidence():
    edges = [{"provenance": {"fetched_at": "2026-11-18T10:00:00+00:00"}}, {"provenance": {"fetched_at": "2026-11-12T09:00:00+00:00"}}, {}]
    assert graph_export.facts_read(edges, ["2026-11-15T00:00:00+00:00", None]) == "2026-11-12"
    assert graph_export.facts_read([{}]) is None


def test_export_graph_returns_a_png_with_the_title_legend_and_date(agent):
    lake_graph(agent)
    r = agent.rpc("tools/call", {"name": "export_graph", "arguments": {"name": "lake", "lens": "model", "format": "png", "title": "Order model", "caption": "One order line per row", "width": 900}})
    content = r.get_json()["result"]["content"]
    png = Image.open(BytesIO(base64.b64decode(content[0]["data"])))
    assert content[0]["mimeType"] == "image/png" and png.width <= 900 and png.height > 300
    assert "lens model" in content[1]["text"] and "Facts read" in content[1]["text"]


def test_the_png_is_the_same_every_time_it_is_drawn():
    nodes = [{"id": "c.s.customers", "kind": "managed", "x": 0, "y": 0}, {"id": "c.s.orders", "kind": "managed", "x": 240, "y": 90}]
    edges = [edge("f1", "fk", "c.s.orders", "c.s.customers", status="derived")]
    cards = {"f1": {"source": {"end": "zero_many"}, "target": {"end": "one"}}}
    keys = {"c.s.orders": [{"name": "customer_id", "type": "bigint", "pk": False, "fk": True}]}
    a = graph_export.render_png("model", nodes, edges, keys, cards, "T", "", "2026-11-18")
    assert a == graph_export.render_png("model", nodes, edges, keys, cards, "T", "", "2026-11-18")
    assert a != graph_export.render_png("model", nodes, edges, keys, cards, "T", "caption", "2026-11-18")
    assert graph_export.render_png("flow", [], [], {}, {}, "", "", None)[:4] == b"\x89PNG"  # an empty graph still draws


def test_export_graph_needs_a_saved_graph_and_a_known_lens_and_format(agent):
    assert "not found" in agent.fails("export_graph", name="nope")
    lake_graph(agent)
    assert "lens" in agent.fails("export_graph", name="lake", lens="sideways")
    assert "format" in agent.fails("export_graph", name="lake", format="svg")


def test_a_saved_graph_exports_without_a_connection(connected):
    from mcp_helpers import Agent
    body = {"name": "g", "nodes": [{"data": {"id": "c.s.a", "kind": "managed"}, "position": {"x": 0, "y": 0}}, {"data": {"id": "c.s.b", "kind": "view"}, "position": {"x": 200, "y": 0}}],
            "edges": [{"data": edge("l", "lineage", "c.s.a", "c.s.b", status="derived")}]}
    assert connected.post("/api/diagrams", json=body).status_code == 200
    from databricks_explore import app as app_module
    app_module.STATE["ex"] = None
    a = Agent(connected)
    assert a.initialize().status_code == 200
    assert a.ok("export_graph", name="g").splitlines()[-1] == "  n1 --> n2"


def test_the_mermaid_route_exports_what_the_page_shows(connected):
    fk = "demo_lake.gold.fact_order_lines"
    e = edge("fk1", "fk", fk, "demo_lake.gold.dim_product", status="derived", label="sku", child_columns=["sku"], parent_columns=["sku"])
    body = {"lens": "model", "nodes": [{"id": t, "kind": "managed"} for t in LAKE_TABLES], "edges": [e]}
    out = connected.post("/api/graph/mermaid", json=body).get_json()["mermaid"]
    assert out.startswith("erDiagram\n") and 'dim_product ||--o{ fact_order_lines : "sku"' in out and "string sku PK" in out
    flow = connected.post("/api/graph/mermaid", json={**body, "lens": "flow", "glyphs": {"fk1": ["filter"]}}).get_json()["mermaid"]
    assert flow.startswith("flowchart LR\n")
    for bad in ({**body, "lens": "wide"}, {**body, "nodes": "x"}, {**body, "edges": [{"id": 1}]}):
        r = connected.post("/api/graph/mermaid", json=bad)
        assert r.status_code == 400 and r.get_json()["error"]
