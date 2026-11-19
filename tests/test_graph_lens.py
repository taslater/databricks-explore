"""Graph lenses: the roles read off key references, the Model lens's rows, per-lens positions in a saved graph, and the MCP tools."""
import json

from databricks_explore import demo_lake, graph_lens, graphs
from mcp_helpers import agent, connected, env, offline_agent  # noqa: F401

LAKE_TABLES = [t for t in demo_lake.TABLES if ".gold." in t or t.endswith("silver.orders") or "v_orders" in t]


def ref(a, b, kind="fk"):
    return {"id": f"{kind}:{a}->{b}", "kind": kind, "source": a, "target": b, "status": "derived"}


SIZES = {"f1": (100.0, 40.0), "f2": (100.0, 40.0), "d1": (80.0, 30.0), "d12": (80.0, 30.0), "d2": (80.0, 30.0), "dd": (80.0, 30.0), "solo": (60.0, 30.0)}
STAR = [ref("f1", "d1"), ref("f1", "d12"), ref("f2", "d12"), ref("f2", "d2"), ref("d1", "dd")]


def test_a_fact_references_others_and_nothing_references_it_and_a_dimension_is_referenced():
    found = graph_lens.roles(list(SIZES), STAR)
    assert {i: r["role"] for i, r in found.items()} == {"f1": "fact", "f2": "fact", "d1": "dimension", "d12": "dimension", "d2": "dimension", "dd": "dimension"}
    assert "solo" not in found  # no key reference: no role
    assert found["f1"]["reason"] == "references d1, d12 and nothing references it"
    assert found["d12"]["reason"] == "referenced by f1, f2"
    assert found["d1"]["reason"] == "referenced by f1, and references dd in turn (a dimension of a dimension)"
    assert [found[i]["depth"] for i in ("f1", "d1", "dd")] == [0, 1, 2]


def test_superseded_rejected_self_and_non_reference_edges_are_not_references():
    edges = [{**ref("a", "b"), "status": "rejected"}, {**ref("b", "c"), "status": "superseded"}, ref("c", "c"), ref("a", "c", "lineage"), ref("a", "d", "manual")]
    assert graph_lens.reference_pairs(edges) == [("a", "d")]


def test_a_cycle_starts_at_its_first_table_and_a_dimension_below_two_levels_is_further_out_than_both():
    assert graph_lens.depths(["a", "b", "c"], [("a", "b"), ("b", "c"), ("c", "a")]) == {"a": 0, "b": 1, "c": 2}
    assert graph_lens.depths(["f", "m", "d"], [("f", "m"), ("m", "d"), ("f", "d")])["d"] == 2  # the longest path wins


def test_the_model_layout_puts_facts_in_a_middle_row_and_dimensions_above_and_below():
    at = graph_lens.model_layout(SIZES, STAR)
    centre = {i: (at[i][0] + SIZES[i][0] / 2, at[i][1] + SIZES[i][1] / 2) for i in SIZES}
    assert centre["f1"][1] == centre["f2"][1] and centre["f1"][0] < centre["f2"][0]  # the facts share the middle row
    above, below = {i for i in ("d1", "d12", "d2") if centre[i][1] < centre["f1"][1]}, {i for i in ("d1", "d12", "d2") if centre[i][1] > centre["f1"][1]}
    assert above and below and above | below == {"d1", "d12", "d2"}  # both sides are used
    assert centre["f1"][0] < centre["d12"][0] < centre["f2"][0]  # a dimension of two facts sits between them
    assert abs(centre["dd"][1] - centre["f1"][1]) > abs(centre["d1"][1] - centre["f1"][1])  # a dimension of a dimension, one row further out...
    assert (centre["dd"][1] < centre["f1"][1]) == (centre["d1"][1] < centre["f1"][1])  # ...on the same side
    boxes = [(at[i][0], at[i][1], at[i][0] + SIZES[i][0], at[i][1] + SIZES[i][1]) for i in SIZES]
    assert not any(a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3] for n, a in enumerate(boxes) for b in boxes[n + 1:])
    assert at["solo"][1] > max(at[i][1] + SIZES[i][1] for i in SIZES if i != "solo") - 1  # a table with no reference is its own band, below
    assert graph_lens.model_layout(SIZES, STAR) == at  # deterministic


def test_a_graph_keeps_its_lens_and_each_lens_keeps_its_own_positions():
    nodes = [{"id": t, "kind": "managed"} for t in ("c.s.f", "c.s.d", "c.s.e")]
    edges = [ref("c.s.f", "c.s.d"), ref("c.s.f", "c.s.e")]
    flow = graphs.build_body("g", nodes, edges)
    assert "lens" not in flow and "lens_positions" not in flow
    at = lambda body: {n["data"]["id"]: (n["position"]["x"], n["position"]["y"]) for n in body["nodes"]}  # noqa: E731
    model = graphs.build_body("g", nodes, edges, previous=flow, lens="model")
    assert model["lens"] == "model" and model["lens_positions"] == {"all": {i: {"x": x, "y": y} for i, (x, y) in at(flow).items()}}
    assert at(model) != at(flow)
    back = graphs.build_body("g", nodes, edges, previous=model, lens="all")
    assert at(back) == at(flow) and "lens" not in back  # the first lens's positions come back as they were
    assert back["lens_positions"]["model"] == {i: {"x": x, "y": y} for i, (x, y) in at(model).items()}
    again = graphs.build_body("g", nodes[:2], edges[:1], previous=model)  # a change of tables keeps the lens, and drops the gone table's stash
    assert again["lens"] == "model" and set(again["lens_positions"]["all"]) == {"c.s.f", "c.s.d"}


def test_a_lens_and_its_positions_are_checked_when_a_graph_is_saved(env):
    ok = {"name": "g", "nodes": [], "edges": [], "lens": "model", "lens_positions": {"flow": {"a.b.c": {"x": 1, "y": 2.5}}}}
    assert graphs.write_graph(ok)[0] == "g"
    for bad in ({"lens": "wide"}, {"lens_positions": []}, {"lens_positions": {"wide": {}}}, {"lens_positions": {"flow": {"a.b.c": {"x": 1}}}}, {"lens_positions": {"flow": {"a.b.c": {"x": "1", "y": 2}}}}):
        try:
            graphs.write_graph({**ok, **bad})
        except graphs.GraphInvalid as e:
            assert "lens" in str(e)
        else:
            raise AssertionError(bad)


def test_create_graph_and_update_graph_take_a_lens_and_get_graph_reports_it_and_the_roles(agent):
    agent.ok("create_graph", name="lake", tables=LAKE_TABLES, lens="model")
    j = json.loads(agent.ok("get_graph", name="lake", format="json"))
    roles = {n["table"]: n["role"]["role"] for n in j["nodes"] if "role" in n}
    assert j["lens"] == "model" and "fact" in roles.values() and "dimension" in roles.values()
    returns, shipments, lines, customer = (f"demo_lake.gold.{t}" for t in ("fact_returns", "fact_shipments", "fact_order_lines", "dim_customer"))
    assert {t for t, r in roles.items() if r == "fact"} == {returns, shipments}  # nothing references them
    assert roles[lines] == "dimension" and roles[customer] == "dimension"  # a table another one references is a dimension, a fact or not
    assert "nothing references it" in next(n["role"]["reason"] for n in j["nodes"] if n["table"] == returns)
    assert "Lens: model." in agent.ok("get_graph", name="lake") and f"{returns} [managed] pinned fact" in agent.ok("get_graph", name="lake")
    ys = {n["table"]: n["y"] for n in j["nodes"]}
    assert ys[returns] == ys[shipments]  # the facts share the middle row
    assert ys[lines] != ys[returns] and abs(ys[customer] - ys[returns]) > abs(ys[lines] - ys[returns])  # a dimension of a dimension is one row further out
    out = agent.ok("update_graph", name="lake", lens="all")
    assert "lens all" in out
    j2 = json.loads(agent.ok("get_graph", name="lake", format="json"))
    assert j2["lens"] == "all"
    assert graphs.load_graph("lake")["lens_positions"]["model"]  # the model lens's positions wait for the next switch
    agent.ok("update_graph", name="lake", lens="model")
    assert {n["table"]: n["y"] for n in json.loads(agent.ok("get_graph", name="lake", format="json"))["nodes"]} == ys
    assert "lens" in agent.fails("create_graph", name="x", tables=LAKE_TABLES[:1], lens="wide")


def test_export_graph_follows_the_graphs_lens_unless_told_otherwise(agent):
    agent.ok("create_graph", name="lake", tables=LAKE_TABLES, lens="model")
    assert agent.ok("export_graph", name="lake").startswith("erDiagram")
    assert agent.ok("export_graph", name="lake", lens="flow").startswith("flowchart")
    agent.ok("create_graph", name="plain", tables=LAKE_TABLES)
    assert agent.ok("export_graph", name="plain").startswith("flowchart")
