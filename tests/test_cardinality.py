"""Crow's-foot ends of reference edges: each rule on its own, then the route on the demo lakehouse."""
import pytest

from databricks_explore import app as app_module
from databricks_explore import cardinality, dbx, demo, demo_lake
from databricks_explore.cardinality import edge_cardinality

LAKE = demo_lake.LAKE


def table(pk=None, not_null=(), cols=("id",)):
    return {"table_constraints": [{"primary_key_constraint": {"name": "pk", "child_columns": list(pk)}}] if pk else None,
            "columns": [{"name": c, "nullable": c not in not_null} for c in cols]}


def ends(c):
    return (c["source"] and c["source"]["end"], c["target"] and c["target"]["end"]) if c else None


def test_a_foreign_key_to_a_primary_key_is_many_to_exactly_one_when_the_columns_are_not_null():
    child = table(pk=["order_id"], not_null=["customer_id"], cols=("order_id", "customer_id"))
    parent = table(pk=["customer_id"])
    c = edge_cardinality("fk", "orders", "customers", [[("customer_id", "customer_id")]], child, parent)
    assert ends(c) == ("zero_many", "one")
    assert c["target"]["basis"] == "constraint" and "NOT NULL on customer_id" in c["target"]["why"]
    assert "Each row of `orders` has exactly one row of `customers` (" in c["sentence"]


def test_a_nullable_foreign_key_column_makes_the_parent_end_zero_or_one():
    child = table(pk=["order_id"], cols=("order_id", "customer_id"))
    c = edge_cardinality("fk", "orders", "customers", [[("customer_id", "customer_id")]], child, table(pk=["customer_id"]))
    assert ends(c) == ("zero_many", "zero_one")


def test_a_composite_key_needs_every_column_and_every_column_not_null():
    parent = table(pk=["a", "b"], cols=("a", "b"))
    child = table(pk=["id"], not_null=["x", "y"], cols=("id", "x", "y"))
    assert ends(edge_cardinality("fk", "c", "p", [[("x", "a"), ("y", "b")]], child, parent)) == ("zero_many", "one")
    half = table(pk=["id"], not_null=["x"], cols=("id", "x", "y"))
    assert ends(edge_cardinality("fk", "c", "p", [[("x", "a"), ("y", "b")]], half, parent)) == ("zero_many", "zero_one")
    # The FK covers only part of the parent's key: the parent end is unknown, never "one".
    assert ends(edge_cardinality("fk", "c", "p", [[("x", "a")]], child, parent)) == ("zero_many", None)


def test_a_foreign_key_that_is_also_the_childs_primary_key_is_one_to_one():
    child = table(pk=["customer_id"], not_null=["customer_id"], cols=("customer_id",))
    c = edge_cardinality("fk", "profile", "customers", [[("customer_id", "customer_id")]], child, table(pk=["customer_id"]))
    assert ends(c) == ("zero_one", "one") and c["source"]["basis"] == "primary_key"


def test_a_foreign_key_to_a_column_that_is_not_the_primary_key_draws_no_parent_end():
    assert ends(edge_cardinality("fk", "o", "c", [[("email", "email")]], table(cols=("email",)), table(pk=["id"], cols=("id", "email")))) == ("zero_many", None)


def test_a_self_referencing_key_is_read_the_same_way():
    t = table(pk=["id"], cols=("id", "parent_id"))
    assert ends(edge_cardinality("fk", "t", "t", [[("parent_id", "id")]], t, t)) == ("zero_many", "zero_one")


def test_a_mined_join_draws_an_end_only_where_the_columns_are_exactly_the_primary_key():
    a, b = table(pk=["id"], cols=("id", "x")), table(pk=["k"], cols=("k", "y"))
    assert ends(edge_cardinality("join_mined", "a", "b", [[("x", "k")]], a, b)) == (None, "one")
    assert ends(edge_cardinality("join_mined", "a", "b", [[("id", "k")]], a, b)) == ("one", "one")
    assert edge_cardinality("join_mined", "a", "b", [[("x", "y")]], a, b) is None  # non-key columns: no ends at all
    assert edge_cardinality("manual", "a", "b", [[("x", "k")]], a, None) is None  # unknown metadata: unknown
    assert edge_cardinality("join_mined", "a", "b", [[("x", "k"), ("id", "k2")]], a, b) is None  # a composite not matching the key


def test_key_sets_that_disagree_give_no_end_and_other_kinds_give_none():
    a, b = table(pk=["id"], cols=("id", "x")), table(pk=["k"], cols=("k", "y"))
    assert ends(edge_cardinality("join_mined", "a", "b", [[("x", "k")], [("x", "y")]], a, b)) is None
    assert ends(edge_cardinality("join_mined", "a", "b", [[("x", "k")], [("id", "k")]], a, b)) == (None, "one")
    assert edge_cardinality("lineage", "a", "b", [[("x", "k")]], a, b) is None
    assert edge_cardinality("fk", "a", "b", [], a, b) is None


# ---- through the route, on the demo lakehouse

@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    c = app_module.app.test_client()
    assert c.post("/api/connect", json={"profile": "demo"}).status_code == 200
    return c


def test_the_route_reads_the_demo_lakehouse_keys_and_nullability(client):
    fact, other = f"{LAKE}.gold.fact_order_lines", f"{LAKE}.gold.dim_"
    edges = [{"id": "fk:cust", "kind": "fk", "source": fact, "target": other + "customer"},
             {"id": "fk:sku", "kind": "fk", "source": fact, "target": other + "product"},
             {"id": "fk:store", "kind": "fk", "source": fact, "target": other + "store"},
             {"id": "fk:self", "kind": "fk", "source": other + "customer", "target": other + "customer"},
             {"id": "l", "kind": "lineage", "source": fact, "target": other + "date"}]
    out = client.post("/api/relationships/cardinality", json={"edges": edges}).json["cardinality"]
    assert {k: ends(v) for k, v in out.items()} == {
        "fk:cust": ("zero_many", "zero_one"),  # guest checkouts: customer_id is nullable
        "fk:sku": ("zero_many", "one"),
        "fk:store": ("zero_many", "one"),      # composite key, both columns NOT NULL
        "fk:self": ("zero_many", "zero_one")}  # lineage is not a reference: not answered
    assert client.post("/api/relationships/cardinality", json={"edges": "x"}).status_code == 400
