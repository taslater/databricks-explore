"""connect_known: planned connectors from foreign keys, mined joins and manual edges, and the tool and route that draw them."""
from databricks_explore import app as app_module
from databricks_explore import canvases
from databricks_explore import relationships as rel
from mcp_helpers import Agent, agent, connected, env  # noqa: F401

O, C, I = "demo.sales.orders", "demo.sales.customers", "demo.sales.order_items"


def mined(a, ac, b, bc, runs=1, together=(), status="proposed"):
    ev = rel.Evidence(runs=runs, users=1, together=[rel.Together(columns=list(t), runs=n) for t, n in together])
    return rel.Edge(kind="join_mined", directed=False, status=status, source=rel.Endpoint(table=a, column=ac),
                    target=rel.Endpoint(table=b, column=bc), provenance=rel.Provenance(origin="query_history", source_ref="s"),
                    evidence=ev)


def fk(child, parent, pairs, name="fk1"):
    return [rel.Edge(kind="fk", source=rel.Endpoint(table=child, column=c), target=rel.Endpoint(table=parent, column=p),
                     provenance=rel.Provenance(origin="unity_catalog:table_constraints", source_ref=name), status="derived")
            for c, p in pairs]


def plan(edges, **kw):
    return rel.connector_plan(edges, **kw)


def test_a_single_column_foreign_key_is_one_directed_connector_labeled_with_the_column():
    (p,), skipped = plan(fk(O, C, [("customer_id", "customer_id")]))
    assert (p["source"], p["target"], p["label"], p["directed"], p["proposed"]) == (O, C, "customer_id", True, False)
    assert skipped == {"rejected": 0, "proposed": 0}


def test_a_composite_foreign_key_is_one_label_joined_with_plus():
    (p,), _ = plan(fk("a.b.lines", "a.b.orders", [("order_id", "order_id"), ("line_no", "line_no")]))
    assert p["label"] == "order_id + line_no"


def test_columns_named_differently_show_both_sides_and_separate_keys_are_comma_separated():
    es = fk(O, C, [("cust", "id")], "fk_a") + fk(O, C, [("region", "region")], "fk_b")
    (p,), _ = plan(es)
    assert p["label"] == "cust = id, region"


def test_mined_composite_key_is_grouped_by_together_and_single_pairs_stay_single():
    both = ((("l_partkey", "ps_partkey"), ("l_suppkey", "ps_suppkey")), 5)
    es = [mined("d.s.li", "l_partkey", "d.s.ps", "ps_partkey", together=[both]),
          mined("d.s.li", "l_suppkey", "d.s.ps", "ps_suppkey", together=[both]),
          mined("d.s.li", "l_sku", "d.s.ps", "sku")]
    (p,), _ = plan(es, include_proposed=True)
    assert p["label"] == "l_partkey + l_suppkey = ps_partkey + ps_suppkey, l_sku = sku"
    assert not p["directed"] and p["proposed"]


def test_proposed_rejected_and_the_flag():
    es = [mined(O, "a", C, "a")]
    assert plan(es) == ([], {"rejected": 0, "proposed": 1})
    assert plan(es, include_proposed=True)[0][0]["proposed"] is True
    assert plan([mined(O, "a", C, "a", status="rejected")], include_proposed=True) == ([], {"rejected": 1, "proposed": 0})
    assert plan([mined(O, "a", C, "a", status="accepted")])[0][0]["proposed"] is False
    both = [mined(O, "a", C, "a", status="accepted"), mined(O, "b", C, "b", status="rejected")]
    assert plan(both)[0][0]["label"] == "a"  # the rejected key is not drawn


def test_a_pair_seen_as_a_foreign_key_and_a_mined_join_is_one_connector_with_the_key_once_and_the_fk_orientation():
    es = [mined(C, "customer_id", O, "customer_id", status="accepted"), *fk(O, C, [("customer_id", "customer_id")])]
    (p,), _ = plan(es)
    assert (p["source"], p["target"], p["label"], p["directed"]) == (O, C, "customer_id", True)


def test_known_edges_among_keeps_only_join_keys_between_the_given_tables():
    store = rel.Store(":memory:")
    store.upsert_mined([mined(O, "a", C, "a"), mined(O, "a", "demo.sales.other", "a")])
    relations = {"edges": [{"kind": "fk", "source": O, "target": C, "child_columns": ["customer_id"], "parent_columns": ["customer_id"]},
                           {"kind": "lineage", "source": O, "target": C}, {"kind": "view_dep", "source": C, "target": O}]}
    out = rel.known_edges_among(store, [O, C.upper()], lambda t: relations if t == O else None)
    assert sorted(e.kind for e in out) == ["fk", "join_mined"]
    store.close()


# ---------------------------------------------------------------- the tool

def cards(a, name="d", tables=(O, C, I)):
    a.ok("create_canvas", name=name)
    a.ok("add_nodes", name=name, nodes=[{"type": "table", "id": t.split(".")[-1], "table": t, "at": {"x": 400 * i, "y": 0}}
                                        for i, t in enumerate(tables)])


def drawn(name="d"):
    return {(e["source"], e["target"]): e for e in canvases.load_canvas(name)["edges"]}


def test_connect_known_draws_the_foreign_keys_between_the_cards_and_is_undoable(agent):
    cards(agent)
    out = agent.ok("connect_known", name="d")
    assert out.startswith("connected 2 known relationship(s)") and "undo_canvas reverts it" in out and "doctor score" in out
    e = drawn()
    assert e[("orders", "customers")]["label"] == "customer_id" and e[("order_items", "orders")]["label"] == "order_id"
    assert e[("orders", "customers")]["arrow_end"] is True and not e[("orders", "customers")]["dashed"]
    agent.ok("undo_canvas", name="d")
    assert drawn() == {}


def test_connect_known_does_not_duplicate_and_skips_pairs_already_joined(agent):
    cards(agent)
    agent.ok("connect", name="d", source="customers", target="orders", label="mine")  # the other direction counts
    out = agent.ok("connect_known", name="d")
    assert "connected 1 known relationship" in out and "1 already connected" in out
    assert set(drawn()) == {("customers", "orders"), ("order_items", "orders")}
    again = agent.ok("connect_known", name="d")
    assert again.startswith("no connectors added") and len(canvases.load_canvas("d")["edges"]) == 2


def test_connect_known_limits_to_ids_and_checks_them(agent):
    cards(agent)
    agent.ok("connect_known", name="d", ids=["orders", "customers"])
    assert set(drawn()) == {("orders", "customers")}
    assert "not table cards" in agent.fails("connect_known", name="d", ids=["orders", "nope"])
    agent.ok("add_nodes", name="d", nodes=[{"type": "sticky", "id": "s", "label": "x", "at": {"x": 0, "y": 900}}])
    assert "not table cards" in agent.fails("connect_known", name="d", ids=["orders", "s"])


def test_connect_known_proposed_joins_only_with_the_flag_and_rejected_never(agent):
    cards(agent)
    with app_module.rel_store() as st:
        st.upsert_mined([mined(I, "sku", C, "sku", runs=4), mined(I, "x", O, "x", runs=1)])
        [bad] = [e for e in st.all_edges() if e.source.column == "x"]
        st.patch(bad.id, "rejected")
    out = agent.ok("connect_known", name="d")
    assert "1 proposed (include_proposed: true draws them)" in out and len(drawn()) == 2
    agent.ok("connect_known", name="d", include_proposed=True)
    e = next(v for k, v in drawn().items() if set(k) == {"order_items", "customers"})  # a mined join has no direction
    assert e["label"] == "sku" and e["dashed"] is True and e["arrow_end"] is False
    assert drawn()[("order_items", "orders")]["label"] == "order_id"  # the rejected x is not added to it


def test_connect_known_needs_two_cards(agent):
    agent.ok("create_canvas", name="one")
    agent.ok("add_nodes", name="one", nodes=[{"type": "table", "table": O}])
    assert "at least two table cards" in agent.fails("connect_known", name="one")


def test_connect_known_without_a_connection_says_so(env):
    a = Agent(env)
    a.initialize()
    a.ok("create_canvas", name="d")
    assert "Not connected" in a.fails("connect_known", name="d")


def test_connect_known_route_does_the_same_and_the_page_can_undo_it(connected):
    connected.post("/api/canvases", json={"version": 2, "name": "r", "profile": None, "edges": [], "windows": [
        {"id": "a", "type": "table", "table": O, "title": "a", "position": {"x": 0, "y": 0}, "size": {"w": 320, "h": 300}},
        {"id": "b", "type": "table", "table": C, "title": "b", "position": {"x": 400, "y": 0}, "size": {"w": 320, "h": 300}}]})
    r = connected.post("/api/canvases/r/connect-known", json={})
    body = r.get_json()
    assert r.status_code == 200 and len(body["added"]) == 1 and "connected 1 known relationship" in body["message"]
    assert canvases.load_canvas("r")["edges"][0]["label"] == "customer_id"
    assert connected.post("/api/canvases/r/undo").status_code == 200 and canvases.load_canvas("r")["edges"] == []
    assert connected.post("/api/canvases/r/connect-known", json={"ids": "a"}).status_code == 400
    assert connected.post("/api/canvases/r/connect-known", json={"ids": ["a"]}).status_code == 400  # one card: nothing to connect
    assert connected.post("/api/canvases/missing/connect-known", json={}).status_code == 404
