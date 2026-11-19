"""Collapsed groups and elided chains of a saved graph: the rules, the saved `grouping`, and what get_graph and update_graph say about them."""
import json

import pytest

from databricks_explore import graph_collapse, graphs
from mcp_helpers import agent, connected, env  # noqa: F401


def node(i, kind="table", **kw):
    return {"id": i, "kind": kind, **kw}


def edge(s, t, kind="lineage", **kw):
    return {"id": f"{kind}:{s}>{t}", "source": s, "target": t, "kind": kind, **kw}


def lake():
    bronze = [node(f"lake.bronze.t{i}") for i in range(10)]
    silver = [node("lake.silver.a"), node("lake.silver.b")]
    edges = [edge(b["id"], "lake.silver.a") for b in bronze[:5]] + [edge(b["id"], "lake.silver.b") for b in bronze[5:]]
    return bronze + silver, edges


def by_key(p):
    return {g["key"]: g for g in p["groups"]}


def test_a_group_of_more_than_eight_starts_collapsed_and_a_small_one_open():
    nodes, edges = lake()
    g = by_key(graph_collapse.plan(nodes, edges))
    assert g["lake.bronze"]["collapsed"] and g["lake.bronze"]["count"] == 10 and g["lake.bronze"]["label"] == "bronze"
    assert not g["lake.silver"]["collapsed"]


def test_the_focus_or_a_pinned_table_keeps_its_group_open_and_a_choice_wins():
    nodes, edges = lake()
    nodes[3]["focus"] = True
    assert not by_key(graph_collapse.plan(nodes, edges))["lake.bronze"]["collapsed"]
    nodes, edges = lake()
    nodes[3]["pinned"] = True
    assert not by_key(graph_collapse.plan(nodes, edges))["lake.bronze"]["collapsed"]
    nodes, edges = lake()
    p = graph_collapse.plan(nodes, edges, {"expanded": ["lake.bronze"], "collapsed": ["lake.silver"]})
    assert not by_key(p)["lake.bronze"]["collapsed"] and by_key(p)["lake.silver"]["collapsed"]
    assert by_key(p)["lake.silver"]["default_collapsed"] is False


def test_one_schema_or_grouping_off_gives_no_groups_and_a_tag_groups_by_its_value():
    nodes, edges = lake()
    assert graph_collapse.plan(nodes[:10], []) ["groups"] == []
    assert graph_collapse.plan(nodes, edges, {"by": "none"})["groups"] == []
    tags = {n["id"]: ("pii" if i % 2 else "plain") for i, n in enumerate(nodes)}
    p = graph_collapse.plan(nodes, edges, {"by": "tag:class"}, tags)
    assert sorted(by_key(p)) == ["pii", "plain"]


def test_a_table_whose_only_edges_the_filters_hide_is_not_counted():
    nodes, edges = lake()
    nodes.append(node("lake.bronze.t10"))
    edges.append(edge("lake.bronze.t10", "lake.bronze.t0", "sketch"))  # meaning edges are off by default
    assert by_key(graph_collapse.plan(nodes, edges))["lake.bronze"]["count"] == 10


def chain():
    nodes = [node("d.s.src"), node("d.s.v1", "view"), node("d.s.v2", "materialized_view"), node("d.s.dst")]
    edges = [edge("d.s.src", "d.s.v1", "view_dep"), edge("d.s.v1", "d.s.v2", "view_dep"), edge("d.s.v2", "d.s.dst")]
    return nodes, edges


def test_table_view_view_table_is_one_chain_of_two_views():
    nodes, edges = chain()
    c = graph_collapse.plan(nodes, edges)["chains"]
    assert len(c) == 1 and (c[0]["source"], c[0]["target"], c[0]["views"]) == ("d.s.src", "d.s.dst", ["d.s.v1", "d.s.v2"])
    assert graph_collapse.plan(nodes, edges, {"chains": False})["chains"] == []


def test_a_view_with_a_second_reader_a_reference_or_a_pin_is_not_elided_and_a_direct_edge_stops_the_chain():
    nodes, edges = chain()
    nodes.append(node("d.s.other"))
    assert graph_collapse.plan(nodes, edges + [edge("d.s.v1", "d.s.other", "view_dep")])["chains"][0]["views"] == ["d.s.v2"]
    nodes, edges = chain()
    assert graph_collapse.plan(nodes, edges + [edge("d.s.v1", "d.s.dst", "fk")])["chains"][0]["views"] == ["d.s.v2"]
    nodes[1]["pinned"] = True
    assert graph_collapse.plan(nodes, edges)["chains"][0]["views"] == ["d.s.v2"]
    nodes, edges = chain()
    assert graph_collapse.plan(nodes, edges + [edge("d.s.src", "d.s.dst")])["chains"] == []


def test_grouping_is_validated_and_saved_and_kept_when_the_tables_change(connected):
    ok = {"name": "g", "nodes": [], "edges": [], "grouping": {"by": "tag:domain", "collapsed": ["a"], "chains": False}}
    assert connected.post("/api/diagrams", json=ok).status_code == 200
    assert connected.get("/api/diagrams/g").get_json()["grouping"]["collapsed"] == ["a"]
    for bad in ({"by": "owner"}, {"collapsed": "a"}, {"chains": 1}, {"extra": 1}, "schema"):
        assert connected.post("/api/diagrams", json={**ok, "name": "h", "grouping": bad}).status_code == 400
    with pytest.raises(graphs.GraphInvalid):
        graphs.write_graph({**ok, "grouping": {"by": ""}})
    body = graphs.build_body("g", [{"id": "demo.sales.orders", "kind": "managed"}], [], previous=ok)
    assert body["grouping"] == ok["grouping"]
    assert "grouping" not in graphs.build_body("g", [{"id": "demo.sales.orders", "kind": "managed"}], [])


def test_get_graph_lists_the_groups_and_the_elided_chains(agent, connected):
    nodes, edges = lake()
    cn, ce = chain()
    body = {"name": "Lake", "nodes": [{"data": {**n, "pinned": False}, "position": {"x": 0, "y": 0}} for n in nodes + cn],
            "edges": [{"data": e} for e in edges + ce], "grouping": {"expanded": ["lake.silver"]}}
    assert connected.post("/api/diagrams", json=body).status_code == 200
    text = agent.ok("get_graph", name="Lake")
    assert "Groups (by schema):" in text and "lake.bronze: 10 tables, collapsed (by the default rule)" in text
    assert "d.s.src -> d.s.dst via 2 views: d.s.v1, d.s.v2" in text
    j = json.loads(agent.ok("get_graph", name="Lake", format="json"))
    assert j["grouping"] == {"by": "schema", "chains": True}
    assert {g["key"]: g["collapsed"] for g in j["groups"]}["lake.bronze"] is True
    assert j["chains"][0]["views"] == ["d.s.v1", "d.s.v2"]
