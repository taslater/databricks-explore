"""How a table is known to join: declared foreign keys, mined joins (single and composite) and manual edges."""
import pytest

from databricks_explore import app as app_module
from databricks_explore import dbx
from databricks_explore import relationships as rel

OI, RT, OR = "demo.sales.order_items", "demo.sales.returns", "demo.sales.orders"


@pytest.fixture
def store():
    s = rel.Store(":memory:")
    yield s
    s.close()


def mined(a, ac, b, bc, runs, together=(), status="proposed"):
    return rel.Edge(
        kind="join_mined", directed=False, status=status,
        source=rel.Endpoint(table=a, column=ac), target=rel.Endpoint(table=b, column=bc),
        provenance=rel.Provenance(origin="query_history", source_ref="s1"),
        evidence=rel.Evidence(runs=runs, together=[rel.Together(columns=c, runs=n) for c, n in together]))


def seed(store, *edges):
    store.upsert_mined(list(edges))


def keys_of(out, other):
    (j,) = [j for j in out["joins"] if j["table"] == other]
    return j["keys"]


def pairs(key):
    return [(p["here"], p["there"]) for p in key["pairs"]]


BOTH = (("order_id", "order_id"), ("line_no", "line_no"))
COMPOSITE = [(BOTH, 20)]
INFO = {"table_constraints": [
    {"primary_key_constraint": {"name": "pk", "child_columns": ["order_id", "line_no"]}},
    {"foreign_key_constraint": {"name": "fk_o", "child_columns": ["order_id"], "parent_table": OR,
                                "parent_columns": ["order_id"]}},
]}


def test_foreign_key_is_a_derived_key_read_from_this_tables_side(store):
    out = rel.join_keys(store, OI, INFO)
    (k,) = keys_of(out, OR)
    assert (pairs(k), k["source"], k["status"], k["name"], k["runs"]) == (
        [("order_id", "order_id")], "fk", "derived", "fk_o", None)


def test_composite_foreign_key_is_one_key_in_declared_order(store):
    info = {"table_constraints": [{"foreign_key_constraint": {
        "name": "fk", "child_columns": ["a", "b"], "parent_table": OR, "parent_columns": ["x", "y"]}}]}
    (k,) = keys_of(rel.join_keys(store, OI, info), OR)
    assert pairs(k) == [("a", "x"), ("b", "y")]


def test_internal_parent_tables_and_constraints_without_pairs_are_skipped(store):
    info = {"table_constraints": [
        {"foreign_key_constraint": {"name": "f", "child_columns": ["a"], "parent_table": "c.s.__mat_1",
                                    "parent_columns": ["a"]}},
        {"foreign_key_constraint": {"name": "g", "child_columns": [], "parent_table": OR, "parent_columns": []}}]}
    assert rel.join_keys(store, OI, info)["joins"] == []


def test_mined_single_and_composite_keys_with_their_own_runs(store):
    seed(store,
         mined(OI, "line_no", RT, "line_no", 20, COMPOSITE),
         mined(OI, "order_id", RT, "order_id", 37, COMPOSITE))
    keys = keys_of(rel.join_keys(store, OI), RT)
    by_pairs = {tuple(sorted(pairs(k))): k for k in keys}
    single = by_pairs[(("order_id", "order_id"),)]
    comp = by_pairs[tuple(sorted(BOTH))]
    # The single key counts every statement that used the pair, composites included, as the suggestions list does.
    assert single["runs"] == 37 and single["source"] == "mined"
    assert comp["runs"] == 20 and len(keys) == 2  # line_no alone is wholly inside the composite: no key of its own


def test_columns_are_flipped_to_the_asked_tables_side(store):
    seed(store, mined(OI, "oid", RT, "order_ref", 5))
    (k,) = keys_of(rel.join_keys(store, RT), OI)
    assert pairs(k) == [("order_ref", "oid")]


def test_composite_status_is_rejected_if_any_member_is_and_accepted_only_if_all_are(store):
    both = [((("a", "a"), ("b", "b")), 3)]
    seed(store, mined(OI, "a", RT, "a", 3, both), mined(OI, "b", RT, "b", 3, both))
    (k,) = keys_of(rel.join_keys(store, OI), RT)
    assert k["status"] == "proposed"
    ids = {e.source.column: e.id for e in store.all_edges()}
    store.set_status_many([ids["a"]], "accepted")
    assert keys_of(rel.join_keys(store, OI), RT)[0]["status"] == "proposed"
    store.set_status_many([ids["b"]], "accepted")
    assert keys_of(rel.join_keys(store, OI), RT)[0]["status"] == "accepted"
    store.set_status_many([ids["b"]], "rejected")
    assert keys_of(rel.join_keys(store, OI), RT)[0]["status"] == "rejected"


def test_manual_edges_with_and_without_columns(store):
    store.create_manual(rel.EdgeCreate(source=rel.Endpoint(table=OI, column="sku"),
                                       target=rel.Endpoint(table=RT, column="sku")))
    store.create_manual(rel.EdgeCreate(source=rel.Endpoint(table=OI), target=rel.Endpoint(table=OR)))
    out = rel.join_keys(store, OI)
    (k,) = keys_of(out, RT)
    assert (pairs(k), k["source"], k["status"]) == ([("sku", "sku")], "manual", "accepted")
    (k,) = keys_of(out, OR)
    assert k["pairs"] == [] and k["source"] == "manual"


def test_other_stored_kinds_are_not_join_keys(store):
    store.upsert_edges([rel.Edge(kind="sketch", source=rel.Endpoint(table=OI), target=rel.Endpoint(table=RT),
                                 provenance=rel.Provenance(origin="user"), status="accepted")])
    assert rel.join_keys(store, OI)["joins"] == []


# ---------- the route ----------

class Ex:
    profile = "dev"

    def __init__(self, info=None, boom=False):
        self.info, self.boom = info, boom

    def object(self, name, refresh=False):
        if self.boom:
            raise RuntimeError("no such table")
        return {"data": self.info or {}}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    monkeypatch.setitem(app_module.STATE, "ex", Ex(INFO))
    return app_module.app.test_client()


def test_route_returns_fk_and_stored_keys(client):
    with app_module.rel_store() as s:
        seed(s, mined(OI, "order_id", RT, "order_id", 4))
    r = client.get("/api/relationships/joins", query_string={"table": OI})
    body = r.get_json()
    assert r.status_code == 200 and body["table"] == OI and body["errors"] == []
    assert {j["table"] for j in body["joins"]} == {OR, RT}


def test_route_still_answers_from_the_store_when_the_table_cannot_be_read(client, monkeypatch):
    monkeypatch.setitem(app_module.STATE, "ex", Ex(boom=True))
    with app_module.rel_store() as s:
        seed(s, mined(OI, "order_id", RT, "order_id", 4))
    body = client.get("/api/relationships/joins", query_string={"table": OI}).get_json()
    assert [j["table"] for j in body["joins"]] == [RT] and "no such table" in body["errors"][0]


def test_route_validates_the_table(client):
    assert client.get("/api/relationships/joins").status_code == 400
    assert client.get("/api/relationships/joins", query_string={"table": "nope"}).status_code == 400
