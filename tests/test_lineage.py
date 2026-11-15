"""The lineage walk, the lineage tool, connect_known's include_lineage, add_lineage and the connectors route."""
import json

import pytest

from databricks_explore import canvases
from databricks_explore import demo
from databricks_explore import lineage
from databricks_explore import ontology
from mcp_helpers import Agent, agent, connected, env  # noqa: F401

P, I, O, V, R, S = ("demo.sales.products", "demo.sales.order_items", "demo.sales.orders", "demo.sales.v_daily_revenue",
                    "demo.sales.returns", "demo.sales.shipments")
C = "demo.sales.customers"


def rel(*edges, nodes=()):
    """An Explorer.relations()-shaped response from (kind, source, target[, bidir]) tuples."""
    return {"nodes": [{"id": n, "kind": k} for n, k in nodes],
            "edges": [{"id": f"{k}:{s}->{t}", "kind": k, "source": s, "target": t, "bidir": bool(b[0]) if b else False}
                      for k, s, t, *b in edges], "errors": []}


def graph(*edges):
    """A relations_of over a whole graph of (kind, source, target) edges: each table sees the edges that touch it."""
    calls = []

    def relations_of(t):
        calls.append(t)
        return rel(*[e for e in edges if t in e[1:3]])
    relations_of.calls = calls
    return relations_of


CHAIN = [("lineage", "a", "b"), ("lineage", "b", "c"), ("lineage", "c", "d"), ("lineage", "d", "e")]


def test_walk_downstream_follows_hops_and_stops_at_depth():
    f = graph(*CHAIN)
    out = lineage.walk(f, "b", "downstream", 2)
    assert [(n["table"], n["hop"], n["side"]) for n in out["nodes"]] == [("b", 0, "start"), ("c", 1, "down"), ("d", 2, "down")]
    assert [(e["source"], e["target"], e["hop"]) for e in out["edges"]] == [("b", "c", 1), ("c", "d", 2)]
    assert "e" not in f.calls and "d" not in f.calls  # depth 2 reads b and c only: d's neighbors are not needed


def test_walk_upstream_and_both():
    f = graph(*CHAIN)
    up = lineage.walk(f, "c", "upstream", 6)
    assert [(n["table"], n["hop"], n["side"]) for n in up["nodes"]] == [("c", 0, "start"), ("b", 1, "up"), ("a", 2, "up")]
    assert [(e["source"], e["target"]) for e in up["edges"]] == [("b", "c"), ("a", "b")]  # still source to target
    both = lineage.walk(f, "c", "both", 1)
    assert [(n["table"], n["side"]) for n in both["nodes"]] == [("c", "start"), ("b", "up"), ("d", "down")]


def test_walk_ignores_foreign_keys_and_clamps_depth():
    f = graph(("fk", "a", "b"), ("lineage", "a", "c"), ("view_dep", "a", "d"))
    out = lineage.walk(f, "a", "downstream", 99)
    assert out["depth"] == lineage.MAX_DEPTH
    assert {(e["kind"], e["target"]) for e in out["edges"]} == {("lineage", "c"), ("view_dep", "d")}
    with pytest.raises(ValueError):
        lineage.walk(f, "a", "sideways")


def test_walk_survives_cycles_and_diamonds():
    f = graph(("lineage", "a", "b"), ("lineage", "b", "c"), ("lineage", "c", "a"), ("lineage", "a", "c"))
    out = lineage.walk(f, "a", "downstream", 6)
    assert sorted(n["table"] for n in out["nodes"]) == ["a", "b", "c"]
    assert {(e["source"], e["target"]) for e in out["edges"]} == {("a", "b"), ("b", "c"), ("c", "a"), ("a", "c")}
    assert next(n for n in out["nodes"] if n["table"] == "c")["hop"] == 1  # the nearest way wins
    assert sorted(f.calls) == sorted(set(f.calls))  # nothing is read twice


def test_walk_follows_a_bidirectional_lineage_edge_either_way():
    def f(t):
        return rel(("lineage", "a", "b", True))
    assert [n["table"] for n in lineage.walk(f, "b", "downstream", 1)["nodes"]] == ["b", "a"]
    assert [n["table"] for n in lineage.walk(f, "a", "upstream", 1)["nodes"]] == ["a", "b"]


def test_walk_caps_the_tables_and_says_so():
    f = graph(*[("lineage", "root", f"t{i:02d}") for i in range(10)])
    out = lineage.walk(f, "root", "downstream", 1, node_cap=4)
    assert len(out["nodes"]) == 4 and out["truncated"] is True
    assert len(out["edges"]) == 3  # no edge to a table that was left out
    assert lineage.walk(f, "root", "downstream", 1)["truncated"] is False


def test_walk_collects_errors_and_keeps_going():
    def f(t):
        if t == "b":
            raise RuntimeError("no access")
        return rel(*[e for e in CHAIN if t in e[1:3]])
    out = lineage.walk(f, "a", "downstream", 3)
    assert [n["table"] for n in out["nodes"]] == ["a", "b"] and out["errors"] == ["b: no access"]
    partial = lineage.walk(lambda t: {**rel(("lineage", "a", "b")), "errors": ["lineage: 403"]}, "a")
    assert partial["errors"][0] == "a: lineage: 403"


def test_connector_plan_one_per_pair_view_beats_lineage_and_both_ways_is_marked():
    plan = lineage.connector_plan([{"kind": "lineage", "source": "a", "target": "b"}, {"kind": "view_dep", "source": "a", "target": "b"},
                                   {"kind": "lineage", "source": "b", "target": "c"}, {"kind": "lineage", "source": "c", "target": "b"},
                                   {"kind": "fk", "source": "x", "target": "y"}])
    assert [(p["source"], p["target"], p["label"], p["bidir"]) for p in plan] == [("a", "b", "view", False), ("b", "c", "lineage", True)]
    assert all(p["directed"] and not p["proposed"] for p in plan)


def test_among_keeps_only_pairs_inside_the_set():
    f = graph(*CHAIN)
    plan = lineage.among(f, ["a", "B", "d"])
    assert [(p["source"], p["target"]) for p in plan] == [("a", "b")]


# ---------------------------------------------------------------- over MCP, on the demo workspace with a deeper chain

@pytest.fixture
def chain(monkeypatch):
    """products -> order_items -> orders -> v_daily_revenue -> returns -> shipments, and shipments -> products closing a cycle."""
    monkeypatch.setattr(demo, "LINEAGE", [(P, I, "1"), (I, O, "2"), (O, V, "3"), (V, R, "4"), (R, S, "5"), (S, P, "6")])


def lines(out):
    return [x for x in out.splitlines() if x.startswith("hop ")]


def test_lineage_tool_lists_edges_by_hop_then_the_tables(agent, chain):
    out = agent.ok("lineage", table=O, direction="downstream", depth=2)
    assert out.splitlines()[0] == f"lineage of {O}, downstream, depth 2: 2 other table(s), 3 edge(s)"
    assert lines(out) == [f"hop 1 lineage {O} -> {V}", f"hop 1 view_dep {O} -> {V}", f"hop 2 lineage {V} -> {R}"]
    assert f"  {V} view (hop 1 down)" in out and f"  {R} managed (hop 2 down)" in out and f"  {O} managed (start)" in out
    assert "certification cache not loaded" in out


def test_lineage_tool_defaults_and_cycle(agent, chain):
    default = agent.ok("lineage", table=O)  # downstream, depth 3: v_daily_revenue, returns, shipments
    assert "3 other table(s)" in default and "downstream, depth 3" in default
    full = agent.ok("lineage", table=O, direction="both", depth=6)
    assert full.splitlines()[0].startswith(f"lineage of {O}, both, depth 6: 5 other table(s)")  # the cycle visits each table once
    up = agent.ok("lineage", table=O, direction="upstream", depth=1)
    assert lines(up) == [f"hop 1 lineage {I} -> {O}"]


def test_lineage_tool_json_and_certification_marks(agent, chain, monkeypatch):
    cache = {"fetched_at": "2026-11-10T00:00:00Z", "tables": {V: "certified", R: "deprecated"}, "columns": {}}
    monkeypatch.setattr(ontology, "cached_certification", lambda ex: cache)
    text = agent.ok("lineage", table=O, depth=2)
    assert f"  {V} view (hop 1 down) [certified]" in text and f"  {R} managed (hop 2 down) [deprecated]" in text
    assert "certification cache not loaded" not in text
    out = json.loads(agent.ok("lineage", table=O, depth=2, format="json"))
    assert set(out) == {"nodes", "edges", "truncated", "errors"}
    assert {n["table"]: n.get("certification") for n in out["nodes"]} == {O: None, V: "certified", R: "deprecated"}
    assert all(set(e) == {"id", "kind", "source", "target", "hop"} for e in out["edges"])


def test_lineage_tool_without_lineage_and_validation(agent, chain):
    out = agent.ok("lineage", table="demo.hr.employees")
    assert "0 other table(s), 0 edge(s)" in out and "no lineage or view dependencies found" in out
    assert "depth" in agent.fails("lineage", table=O, depth=7)
    assert "direction" in agent.fails("lineage", table=O, direction="sideways")
    assert "placeholder" in agent.fails("lineage", table="ph:1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed")


def test_lineage_tool_needs_a_connection(env):
    a = Agent(env)
    a.initialize()
    assert "Not connected" in a.fails("lineage", table=O)


def drawn(name="d"):
    return {(e["source"], e["target"]): e for e in canvases.load_canvas(name)["edges"]}


def cards(agent, tables, name="d"):
    agent.ok("create_canvas", name=name)
    agent.ok("add_nodes", name=name, nodes=[{"type": "table", "id": t.split(".")[-1], "table": t, "at": {"x": 400 * i, "y": 0}}
                                            for i, t in enumerate(tables)])


def test_connect_known_include_lineage_draws_directed_labeled_connectors(agent, chain):
    cards(agent, [P, I, O, V])
    assert "connected 1 known relationship" in agent.ok("connect_known", name="d")  # the foreign key only, by default
    assert set(drawn()) == {("order_items", "orders")}
    out = agent.ok("connect_known", name="d", include_lineage=True)
    e = drawn()
    assert set(e) == {("order_items", "orders"), ("products", "order_items"), ("orders", "v_daily_revenue")}
    assert e[("products", "order_items")]["label"] == "lineage" and e[("products", "order_items")]["arrow_end"] is True
    assert e[("orders", "v_daily_revenue")]["label"] == "view"  # the pair has a view dependency as well as lineage
    assert "connected 2 known relationship" in out and "1 lineage pair(s) already drawn" in out  # order_items -> orders is a key
    agent.ok("undo_canvas", name="d")
    assert set(drawn()) == {("order_items", "orders")}


def test_connect_known_include_lineage_does_not_duplicate_a_key_connector(agent, chain):
    cards(agent, [I, O])  # order_items -> orders is both a foreign key and lineage
    out = agent.ok("connect_known", name="d", include_lineage=True)
    assert len(drawn()) == 1 and drawn()[("order_items", "orders")]["label"] == "order_id"
    assert "1 lineage pair(s) already drawn as a key connector" in out


def test_connect_known_without_the_flag_hints_at_it(agent, chain):
    cards(agent, [P, I])
    assert "include_lineage: true" in agent.ok("connect_known", name="d")


def test_add_lineage_adds_cards_connectors_and_lays_out_left_to_right(agent, chain):
    agent.ok("create_canvas", name="d")
    out = agent.ok("add_lineage", name="d", table=P, depth=3)
    assert out.startswith(f"added 4 table card(s) and 3 lineage connector(s) for {P} (downstream, depth 3), laid out left to right by hop")
    c = canvases.load_canvas("d")
    by_table = {w["table"]: w for w in c["windows"]}
    assert sorted(by_table) == sorted([P, I, O, V])
    xs = [by_table[t]["position"]["x"] for t in (P, I, O, V)]
    assert xs == sorted(xs) and len(set(xs)) == 4  # one column per hop, source on the left
    assert {(e["source"], e["target"]) for e in c["edges"]} == {(by_table[a]["id"], by_table[b]["id"]) for a, b in ((P, I), (I, O), (O, V))}
    assert sorted(e["label"] for e in c["edges"]) == ["lineage", "lineage", "view"]
    assert all(e["source_handle"] == "r" and e["target_handle"] == "l" for e in c["edges"])
    assert "undo_canvas reverts it" in out


def test_add_lineage_upstream_both_and_existing_cards(agent, chain):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[{"type": "table", "id": "mine", "table": O, "at": {"x": 0, "y": 0}},
                                            {"type": "sticky", "id": "s", "label": "keep", "at": {"x": 0, "y": 900}}])
    out = agent.ok("add_lineage", name="d", table=O, direction="both", depth=1)
    assert f"added 2 table card(s) and 2 lineage connector(s) for {O} (both, depth 1)" in out and "1 already on the canvas" in out
    c = canvases.load_canvas("d")
    cards_ = {w["table"]: w for w in c["windows"] if w["type"] == "table"}
    assert sorted(cards_) == sorted([I, O, V])
    assert cards_[I]["position"]["x"] < cards_[O]["position"]["x"] < cards_[V]["position"]["x"]
    assert cards_[O]["id"] == "mine" and any(w["id"] == "s" for w in c["windows"])
    again = agent.ok("add_lineage", name="d", table=O, direction="both", depth=1)
    assert "added 0 table card(s) and 0 lineage connector(s)" in again and "2 connector(s) already there" in again


def test_add_lineage_is_one_undoable_write(agent, chain):
    agent.ok("create_canvas", name="d")
    before = canvases.revision_info("d")
    agent.ok("add_lineage", name="d", table=P, depth=2)
    after = canvases.revision_info("d")
    assert after["revision"] == before["revision"] + 1 and after["by"] == "agent" and after["snapshots"] == before["snapshots"] + 1
    agent.ok("undo_canvas", name="d")
    assert canvases.load_canvas("d")["windows"] == [] and canvases.load_canvas("d")["edges"] == []


def test_add_lineage_with_no_lineage_adds_only_the_start_card(agent, chain):
    agent.ok("create_canvas", name="d")
    out = agent.ok("add_lineage", name="d", table="demo.hr.employees")
    assert "added 1 table card(s) and 0 lineage connector(s)" in out and "no lineage or view dependencies found" in out


def test_add_lineage_errors(agent, chain):
    assert agent.fails("add_lineage", name="nope", table=P)
    agent.ok("create_canvas", name="d")
    assert "depth" in agent.fails("add_lineage", name="d", table=P, depth=0)
    assert "placeholder" in agent.fails("add_lineage", name="d", table="ph:1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed")


def test_add_lineage_needs_a_connection(env):
    a = Agent(env)
    a.initialize()
    a.ok("create_canvas", name="d")
    assert "Not connected" in a.fails("add_lineage", name="d", table=P)


# ---------------------------------------------------------------- the routes

def test_connect_known_route_takes_include_lineage(connected, chain):
    connected.post("/api/canvases", json={"version": 2, "name": "r", "profile": None, "edges": [], "windows": [
        {"id": "a", "type": "table", "table": P, "title": "a", "position": {"x": 0, "y": 0}, "size": {"w": 320, "h": 300}},
        {"id": "b", "type": "table", "table": I, "title": "b", "position": {"x": 400, "y": 0}, "size": {"w": 320, "h": 300}}]})
    assert connected.post("/api/canvases/r/connect-known", json={}).get_json()["added"] == []
    body = connected.post("/api/canvases/r/connect-known", json={"include_lineage": True}).get_json()
    assert len(body["added"]) == 1 and canvases.load_canvas("r")["edges"][0]["label"] == "lineage"
    assert connected.post("/api/canvases/r/connect-known", json={"include_lineage": "yes"}).status_code == 400


def test_connectors_route_gives_one_labeled_connector_per_pair(connected, chain):
    r = connected.post("/api/relationships/connectors", json={"tables": [P, I, O, V, C, "ph:x", "concept:y"]})
    body = r.get_json()
    assert r.status_code == 200
    pairs = {(c["source"], c["target"]): c for c in body["connectors"]}
    assert set(pairs) == {(P, I), (I, O), (O, V), (O, C)}
    assert pairs[(P, I)]["label"] == "lineage" and pairs[(O, V)]["label"] == "view"
    assert pairs[(I, O)]["label"] == "order_id" and pairs[(O, C)]["label"] == "customer_id"  # the key wins over lineage
    assert all(c["directed"] for c in pairs.values())
    assert body["skipped"]["lineage_covered"] == 1
    off = connected.post("/api/relationships/connectors", json={"tables": [P, I, O], "include_lineage": False}).get_json()
    assert [(c["source"], c["target"]) for c in off["connectors"]] == [(I, O)]


def test_connectors_route_validates(connected):
    def post(body):
        return connected.post("/api/relationships/connectors", json=body).status_code
    assert [post({}), post({"tables": []}), post({"tables": "a"}), post({"tables": [P], "include_lineage": 1}),
            post({"tables": [f"demo.s.t{i}" for i in range(81)]}), post({"tables": ["nodots"]})] == [400] * 6
