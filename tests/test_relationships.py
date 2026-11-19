"""Relationship store: models, SQLite CRUD, upsert by natural key, notes on derived edges, rollup,
export/import round trip, and the /api/relationships routes (fake Explorer, no workspace).

dbx.DATA points at tmp_path in every test, so the real data directory is never written.
"""
import sqlite3

import pytest

from databricks_explore import app as app_module
from databricks_explore import dbx
from databricks_explore import relationships as rel

A, B, C = "main.sales.orders", "main.sales.customers", "main.sales.raw"
PH = "ph:7f0c2d3e-1111-4222-8333-444455556666"


class FakeExplorer:
    """Stands in for dbx.Explorer: a canned relations() answer and a cache directory."""

    def __init__(self, tmp_path=None, profile="dev"):
        self.profile = profile
        self.root = tmp_path / "cache" if tmp_path else None
        self.warehouse_id = None
        self.calls = []

    def relations(self, name, refresh=False):
        self.calls.append((name, refresh))
        return {
            "nodes": [{"id": A, "label": "orders", "kind": "table", "focus": True},
                      {"id": B, "label": "customers", "kind": "table"},
                      {"id": C, "label": "raw", "kind": "view"}],
            "edges": [
                {"id": f"fk:{A}->{B}", "source": A, "target": B, "kind": "fk", "constraint": "fk_cust",
                 "child_columns": ["cust_id", "region"], "parent_columns": ["id", "region"], "label": "cust_id, region"},
                {"id": f"view_dep:{C}->{A}", "source": C, "target": A, "kind": "view_dep"},
                {"id": f"lineage:{A}<->{C}", "source": C, "target": A, "kind": "lineage", "bidir": True,
                 "last_seen": "2026-11-10 00:00:00.0",
                 "last_seen_by_dir": {f"{C}->{A}": "2026-11-10 00:00:00.0", f"{A}->{C}": "2026-11-01 00:00:00.0"}},
            ],
            "errors": ["lineage: partial"],
        }


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    return tmp_path


@pytest.fixture
def store():
    s = rel.Store(":memory:")
    yield s
    s.close()


@pytest.fixture
def client(data_dir, monkeypatch):
    monkeypatch.setitem(app_module.STATE, "ex", FakeExplorer(data_dir))
    return app_module.app.test_client()


def edge(**kw):
    base = dict(kind="join_mined", source=rel.Endpoint(table=A), target=rel.Endpoint(table=B),
                provenance=rel.Provenance(origin="query_history", source_ref="stmt-1"), status="proposed")
    base.update(kw)
    return rel.Edge(**base)


# ---------- models ----------

def test_endpoint_accepts_three_part_names_and_placeholders():
    assert rel.Endpoint(table=A, column="id").column == "id"
    assert rel.Endpoint(table=PH).table == PH
    assert rel.Endpoint(table=PH.upper().replace("PH:", "ph:")).table == PH  # uuid is normalized


@pytest.mark.parametrize("bad", ["orders", "main.orders", "a.b.c.d", "a..c", "ph:not-a-uuid", "ph:", ""])
def test_endpoint_rejects_bad_tables(bad):
    with pytest.raises(Exception):
        rel.Endpoint(table=bad)


def test_derived_kinds_and_status_are_never_stored(store):
    with pytest.raises(rel.RelationshipInvalid, match=r"kind: .fk. is derived"):
        store.upsert(edge(kind="fk"))
    with pytest.raises(rel.RelationshipInvalid, match="status"):
        store.upsert(edge(status="derived"))
    assert store.all_edges() == []


def test_an_edge_cannot_join_an_endpoint_to_itself(store):
    with pytest.raises(rel.RelationshipInvalid, match="itself"):
        store.upsert(edge(target=rel.Endpoint(table=A)))
    # two columns of one table are fine
    store.upsert(edge(source=rel.Endpoint(table=A, column="x"), target=rel.Endpoint(table=A, column="y")))


# ---------- store CRUD and upsert ----------

def test_upsert_creates_then_updates_by_natural_key(store):
    first, created = store.upsert(edge(evidence=rel.Evidence(runs=3, users=1, sample_refs=["s1"])))
    assert created and first.id.startswith("e_")
    again, created = store.upsert(edge(id="e_other", status="accepted", note="n",
                                       evidence=rel.Evidence(runs=9, users=2)))
    assert not created
    assert again.id == first.id and again.created_at == first.created_at
    assert (again.status, again.note, again.evidence.runs) == ("accepted", "n", 9)
    assert len(store.all_edges()) == 1


def test_columns_are_part_of_the_natural_key(store):
    store.upsert(edge())
    store.upsert(edge(source=rel.Endpoint(table=A, column="cust_id"), target=rel.Endpoint(table=B, column="id")))
    store.upsert(edge(source=rel.Endpoint(table=A, column="cust_id"), target=rel.Endpoint(table=B, column="id")))
    assert len(store.all_edges()) == 2


def test_kind_is_part_of_the_natural_key(store):
    store.upsert(edge(kind="join_mined"))
    store.upsert(edge(kind="ontology"))
    assert len(store.all_edges()) == 2


def test_undirected_edges_are_one_edge_either_way_round(store):
    store.upsert(edge(kind="ontology", directed=False))
    _, created = store.upsert(edge(kind="ontology", directed=False,
                                   source=rel.Endpoint(table=B), target=rel.Endpoint(table=A)))
    assert not created
    (only,) = store.all_edges()
    assert (only.source.table, only.target.table) == (B, A)  # sorted: customers < orders
    # directed edges keep their direction, so the reverse is a different edge
    store.upsert(edge(kind="manual"))
    _, created = store.upsert(edge(kind="manual", source=rel.Endpoint(table=B), target=rel.Endpoint(table=A)))
    assert created


def test_incoming_id_that_belongs_to_another_edge_is_replaced(store):
    one, _ = store.upsert(edge())
    two, _ = store.upsert(edge(id=one.id, source=rel.Endpoint(table=C)))
    assert two.id != one.id


def test_patch_get_delete(store):
    e, _ = store.upsert(edge())
    p = store.patch(e.id, status="accepted", note="looks right")
    assert (p.status, p.note) == ("accepted", "looks right")
    assert store.patch(e.id, note="").note == ""
    with pytest.raises(rel.RelationshipInvalid):
        store.patch(e.id, status="derived")
    store.delete(e.id)
    with pytest.raises(rel.RelationshipNotFound):
        store.get(e.id)
    with pytest.raises(rel.RelationshipNotFound):
        store.delete(e.id)
    with pytest.raises(rel.RelationshipNotFound):
        store.patch("e_missing", note="x")


def test_create_manual_is_accepted_and_redrawing_reaccepts(store):
    body = rel.parse_create({"source": {"table": A}, "target": {"table": B}, "note": "mine"})
    e, created = store.create_manual(body)
    assert created and (e.kind, e.status, e.provenance.origin) == ("manual", "accepted", "user")
    store.patch(e.id, status="rejected")
    again, created = store.create_manual(rel.parse_create({"source": {"table": A}, "target": {"table": B}}))
    assert not created and again.id == e.id and again.status == "accepted" and again.note == "mine"


def test_edges_for_matches_either_end(store):
    store.upsert(edge())
    store.upsert(edge(source=rel.Endpoint(table=C), target=rel.Endpoint(table=PH)))
    assert len(store.edges_for(A)) == 1 and len(store.edges_for(B)) == 1
    assert len(store.edges_for(PH)) == 1 and store.edges_for("main.sales.none") == []


# ---------- migrations ----------

def test_migration_sets_user_version_and_is_idempotent(data_dir):
    path = rel.db_path("dev")
    with rel.Store(path) as s:
        s.upsert(edge())
    assert path == data_dir / "relationships" / "dev.sqlite"
    with rel.Store(path) as s:  # reopening must not rerun the migration or lose rows
        assert len(s.all_edges()) == 1
    assert sqlite3.connect(path).execute("PRAGMA user_version").fetchone()[0] == len(rel.MIGRATIONS) == 3


def test_a_database_from_the_future_is_refused(data_dir):
    path = rel.db_path("dev")
    path.parent.mkdir(parents=True)
    sqlite3.connect(path).execute("PRAGMA user_version = 99").connection.close()
    with pytest.raises(RuntimeError, match="schema version 99"):
        rel.Store(path)


def test_migrations_apply_in_order(monkeypatch):
    monkeypatch.setattr(rel, "MIGRATIONS", [rel._V1, "ALTER TABLE edge ADD COLUMN extra TEXT;"])
    with rel.Store(":memory:") as s:
        assert s.conn.execute("PRAGMA user_version").fetchone()[0] == 2
        s.conn.execute("SELECT extra FROM edge")


def test_database_is_per_profile(data_dir):
    with rel.open_store("one") as s:
        s.upsert(edge())
    with rel.open_store("two") as s:
        assert s.all_edges() == []


# ---------- derived edges, notes, rollup ----------

def test_derive_edges_normalizes_relations():
    fake = FakeExplorer().relations(A)
    derived = rel.derive_edges(fake, {"object": "t1", "lineage": "t2"})
    by_kind = {}
    for e in derived:
        by_kind.setdefault(e.kind, []).append(e)
    assert all(e.status == "derived" for e in derived)
    fks = by_kind["fk"]  # one per column pair
    assert [(e.source.column, e.target.column) for e in fks] == [("cust_id", "id"), ("region", "region")]
    assert fks[0].provenance.source_ref == "fk_cust" and fks[0].provenance.fetched_at == "t1"
    assert fks[0].id == f"fk:{A}#cust_id->{B}#id"
    (vd,) = by_kind["view_dep"]
    assert (vd.source.table, vd.target.table, vd.id) == (C, A, f"view_dep:{C}->{A}")
    # lineage seen both ways is two directed edges, each with its own last_seen
    assert {(e.source.table, e.evidence.last_seen) for e in by_kind["lineage"]} == {
        (C, "2026-11-10 00:00:00.0"), (A, "2026-11-01 00:00:00.0")}
    assert by_kind["lineage"][0].provenance.fetched_at == "t2"


def test_derived_id_round_trips():
    s, t = rel.Endpoint(table=A, column="x"), rel.Endpoint(table=B)
    assert rel.parse_derived_id(rel.derived_id("fk", s, t)) == ("fk", s, t)
    assert rel.parse_derived_id("manual:a.b.c->d.e.f") is None
    assert rel.parse_derived_id("fk:nonsense") is None


def test_rollup_merges_column_edges_into_one_table_edge():
    derived = rel.derive_edges(FakeExplorer().relations(A))
    rolled = {(r.kind, r.source.table, r.target.table): r for r in rel.rollup(derived)}
    fk = rolled[("fk", A, B)]
    assert fk.id == f"fk:{A}->{B}" and len(fk.members) == 2
    assert [(c.source, c.target) for c in fk.columns] == [("cust_id", "id"), ("region", "region")]
    assert fk.source.column is None
    # table-level derived edges keep their column list empty and their own id
    vd = rolled[("view_dep", C, A)]
    assert vd.members == [vd.id] and vd.columns == []
    # directed lineage stays one rolled edge per direction
    assert ("lineage", C, A) in rolled and ("lineage", A, C) in rolled


def test_a_column_edge_implies_its_table_edge(store):
    store.upsert(edge(source=rel.Endpoint(table=A, column="cust_id"), target=rel.Endpoint(table=B, column="id"),
                      evidence=rel.Evidence(runs=2, users=1, first_seen="2026-10-01", last_seen="2026-10-05")))
    store.upsert(edge(source=rel.Endpoint(table=A, column="region"), target=rel.Endpoint(table=B, column="region"),
                      evidence=rel.Evidence(runs=5, users=3, first_seen="2026-09-01", last_seen="2026-11-01"),
                      status="accepted"))
    (r,) = store.table_view(A)
    assert (r.source, r.target) == (rel.Endpoint(table=A), rel.Endpoint(table=B))
    assert r.status == "accepted"  # the strongest member wins
    assert (r.evidence.runs, r.evidence.users) == (7, 3)
    assert (r.evidence.first_seen, r.evidence.last_seen) == ("2026-09-01", "2026-11-01")
    assert len(r.members) == 2 and len(r.columns) == 2
    assert store.table_view() == store.table_view(B)


def test_a_table_level_stored_edge_keeps_its_id_in_the_rollup(store):
    e, _ = store.upsert(edge(kind="manual", status="accepted"))
    (r,) = store.table_view(A)
    assert r.id == e.id and r.members == [e.id]


def test_rollup_ignores_direction_only_for_undirected_edges():
    d = [edge(kind="ontology", directed=False),
         edge(kind="ontology", directed=False, source=rel.Endpoint(table=B, column="id"),
              target=rel.Endpoint(table=A, column="cust_id"))]
    (r,) = rel.rollup(d)
    assert (r.source.table, r.target.table) == (B, A)  # undirected groups are oriented by sorted table name
    assert [(c.source, c.target) for c in r.columns] == [("id", "cust_id")]  # and so are their column pairs
    two = rel.rollup([edge(kind="manual"), edge(kind="manual", source=rel.Endpoint(table=B), target=rel.Endpoint(table=A))])
    assert len(two) == 2


def test_notes_on_derived_edges_live_in_an_overlay(store):
    fk_id = f"fk:{A}#cust_id->{B}#id"
    e = store.set_derived_note(fk_id, "check with the owner")
    assert (e.status, e.note) == ("derived", "check with the owner")
    relations = FakeExplorer().relations(A)
    out = rel.unified(store, A, relations, level="column")
    by_id = {x["id"]: x for x in out["edges"]}
    assert by_id[fk_id]["note"] == "check with the owner"
    assert by_id[f"fk:{A}#region->{B}#region"]["note"] == ""
    assert store.all_edges() == []  # nothing derived was stored
    # a note on the table-level key shows on the rolled edge
    store.set_derived_note(f"fk:{A}->{B}", "table note")
    rolled = {x["id"]: x for x in rel.unified(store, A, relations)["edges"]}
    assert rolled[f"fk:{A}->{B}"]["note"] == "table note"
    # an empty note clears the overlay
    store.set_derived_note(fk_id, "")
    assert fk_id not in {rel.derived_id(*k[:1], rel.Endpoint(table=k[1], column=k[2] or None),
                                        rel.Endpoint(table=k[3], column=k[4] or None)) for k in store.derived_notes()}
    with pytest.raises(rel.RelationshipNotFound):
        store.set_derived_note("manual:nope", "x")
    with pytest.raises(rel.RelationshipNotFound):
        store.clear_derived_note(fk_id)


def test_unified_merges_derived_and_stored_and_adds_nodes(store):
    store.upsert(edge(kind="manual", status="accepted", target=rel.Endpoint(table=PH)))
    out = rel.unified(store, A, FakeExplorer().relations(A))
    kinds = sorted(e["kind"] for e in out["edges"])
    assert kinds == ["fk", "lineage", "lineage", "manual", "view_dep"]
    ph = next(n for n in out["nodes"] if n["id"] == PH)
    assert ph["kind"] == "placeholder"
    assert out["errors"] == ["lineage: partial"] and out["level"] == "table"
    with pytest.raises(rel.RelationshipInvalid, match="level"):
        rel.unified(store, A, level="row")


def test_unified_with_no_relations_still_lists_the_focus_node(store):
    out = rel.unified(store, PH)
    assert out["nodes"] == [{"id": PH, "label": PH.split(".")[-1], "kind": "table", "focus": True}]


# ---------- export / import ----------

def test_export_import_round_trip(store):
    store.upsert(edge(evidence=rel.Evidence(runs=3, users=2, first_seen="a", last_seen="b", sample_refs=["s1", "s2"])))
    store.upsert(edge(kind="ontology", directed=False, status="accepted"))
    store.set_derived_note(f"fk:{A}->{B}", "keep")
    dump = store.export()
    assert dump["version"] == 1 and len(dump["edges"]) == 2 and len(dump["overlays"]) == 1 and dump["concepts"] == []
    with rel.Store(":memory:") as other:
        counts = other.import_file(rel.parse_export(dump))
        assert counts == {"imported": 2, "created": 2, "updated": 0, "overlays": 1, "concepts": 0, "concepts_created": 0}
        again = other.export()
        assert again["edges"] == dump["edges"] and again["overlays"] == dump["overlays"]
        # importing again upserts, it does not duplicate
        counts = other.import_file(rel.parse_export(dump))
        assert counts["created"] == 0 and counts["updated"] == 2
        assert len(other.all_edges()) == 2


def test_import_is_all_or_nothing(store):
    good = edge().model_dump(mode="json")
    bad = edge(kind="fk").model_dump(mode="json")
    with pytest.raises(rel.RelationshipInvalid, match=r"^edges\[1\]\.kind: .fk. is derived"):
        rel.parse_export({"version": 1, "edges": [good, bad]})
    assert store.all_edges() == []


@pytest.mark.parametrize("body, message", [
    ([], r"^\(root\): body must be a JSON object"),
    ({"edges": []}, r"^version: Field required"),
    ({"version": 2, "edges": []}, r"^version: "),
    ({"version": 1}, r"^edges: Field required"),
    ({"version": 1, "edges": [{"kind": "manual"}]}, r"^edges\[0\]\.source: Field required"),
    ({"version": 1, "edges": [{"kind": "bogus", "source": {"table": A}, "target": {"table": B},
                               "provenance": {"origin": "x"}}]}, r"^edges\[0\]\.kind: "),
    ({"version": 1, "edges": [{"kind": "manual", "source": {"table": "nope"}, "target": {"table": B},
                               "provenance": {"origin": "x"}}]}, r"^edges\[0\]\.source\.table: .*catalog\.schema\.table"),
    ({"version": 1, "edges": [{"kind": "manual", "source": {"table": A}, "target": {"table": B},
                               "provenance": {"origin": "x"}, "status": "derived"}]}, r"^edges\[0\]\.status: "),
])
def test_import_validation_messages(body, message):
    with pytest.raises(rel.RelationshipInvalid, match=message):
        rel.parse_export(body)


# ---------- routes ----------

def test_get_relationships_returns_derived_and_stored(client, data_dir):
    client.post("/api/relationships", json={"source": {"table": A}, "target": {"table": PH}})
    r = client.get("/api/relationships", query_string={"table": A})
    assert r.status_code == 200
    body = r.get_json()
    assert sorted(e["kind"] for e in body["edges"]) == ["fk", "lineage", "lineage", "manual", "view_dep"]
    assert body["errors"] == ["lineage: partial"]
    assert {n["id"] for n in body["nodes"]} == {A, B, C, PH}
    fk = next(e for e in body["edges"] if e["kind"] == "fk")
    assert fk["status"] == "derived" and fk["columns"][0] == {"source": "cust_id", "target": "id"}
    col = client.get("/api/relationships", query_string={"table": A, "level": "column"}).get_json()
    assert sum(e["kind"] == "fk" for e in col["edges"]) == 2


def test_get_relationships_passes_refresh_through(client, data_dir):
    client.get("/api/relationships", query_string={"table": A, "refresh": "1"})
    assert app_module.STATE["ex"].calls == [(A, True)]


def test_get_relationships_for_a_placeholder_skips_the_workspace(client, data_dir):
    r = client.get("/api/relationships", query_string={"table": PH})
    assert r.status_code == 200 and app_module.STATE["ex"].calls == []


def test_get_relationships_validates_the_query(client):
    assert client.get("/api/relationships").status_code == 400
    r = client.get("/api/relationships", query_string={"table": "orders"})
    assert r.status_code == 400 and r.get_json()["error"].startswith("table: ")
    r = client.get("/api/relationships", query_string={"table": A, "level": "row"})
    assert r.status_code == 400 and r.get_json()["error"].startswith("level: ")


def test_relationship_routes_need_a_connection(data_dir, monkeypatch):
    monkeypatch.setitem(app_module.STATE, "ex", None)
    r = app_module.app.test_client().get("/api/relationships", query_string={"table": A})
    assert r.status_code == 500 and "Not connected" in r.get_json()["error"]


def test_post_creates_a_manual_edge_then_returns_it_again(client):
    r = client.post("/api/relationships", json={"source": {"table": A, "column": "cust_id"},
                                                "target": {"table": B, "column": "id"}, "note": "x"})
    assert r.status_code == 201
    e = r.get_json()
    assert (e["kind"], e["status"], e["directed"], e["note"]) == ("manual", "accepted", True, "x")
    assert e["provenance"]["origin"] == "user"
    again = client.post("/api/relationships", json={"source": {"table": A, "column": "cust_id"},
                                                    "target": {"table": B, "column": "id"}})
    assert again.status_code == 200 and again.get_json()["id"] == e["id"]


@pytest.mark.parametrize("body, message", [
    (None, "(root): body must be a JSON object"),
    ({}, "source: Field required"),
    ({"source": {"table": A}}, "target: Field required"),
    ({"source": {"table": "x"}, "target": {"table": B}}, "source.table: "),
    ({"source": {"table": A}, "target": {"table": B, "column": " "}}, "target.column: "),
    ({"source": {"table": A}, "target": {"table": A}}, "target: an edge cannot connect"),
    ({"source": {"table": A}, "target": {"table": B}, "kind": "fk"}, "kind: Extra inputs are not permitted"),
])
def test_post_validation_is_400_with_a_path(client, body, message):
    r = client.post("/api/relationships", json=body) if body is not None else client.post(
        "/api/relationships", data="not json", content_type="application/json")
    assert r.status_code == 400
    assert r.get_json()["error"].startswith(message)


def test_patch_sets_status_and_note_on_a_stored_edge(client):
    eid = client.post("/api/relationships", json={"source": {"table": A}, "target": {"table": B}}).get_json()["id"]
    r = client.patch(f"/api/relationships/{eid}", json={"status": "rejected", "note": "wrong"})
    assert r.status_code == 200 and (r.get_json()["status"], r.get_json()["note"]) == ("rejected", "wrong")
    assert client.patch(f"/api/relationships/{eid}", json={}).status_code == 400
    r = client.patch(f"/api/relationships/{eid}", json={"status": "derived"})
    assert r.status_code == 400 and r.get_json()["error"].startswith("status: ")
    r = client.patch(f"/api/relationships/{eid}", json={"status": "maybe"})
    assert r.status_code == 400 and r.get_json()["error"].startswith("status: ")
    assert client.patch("/api/relationships/e_missing", json={"note": "x"}).status_code == 404


def test_patch_a_derived_edge_takes_a_note_only(client):
    rid = f"fk:{A}#cust_id->{B}#id"
    from urllib.parse import quote
    url = f"/api/relationships/{quote(rid, safe='')}"
    r = client.patch(url, json={"note": "hello"})
    assert r.status_code == 200 and r.get_json()["status"] == "derived"
    r = client.patch(url, json={"status": "accepted"})
    assert r.status_code == 400 and "only take a note" in r.get_json()["error"]
    col = client.get("/api/relationships", query_string={"table": A, "level": "column"}).get_json()
    assert next(e for e in col["edges"] if e["id"] == rid)["note"] == "hello"
    assert client.delete(url).get_json() == {"deleted": rid}
    assert client.delete(url).status_code == 404
    assert client.patch("/api/relationships/bogus:a->b", json={"note": "x"}).status_code == 404


def test_delete_removes_a_stored_edge(client):
    eid = client.post("/api/relationships", json={"source": {"table": A}, "target": {"table": B}}).get_json()["id"]
    assert client.delete(f"/api/relationships/{eid}").get_json() == {"deleted": eid}
    assert client.delete(f"/api/relationships/{eid}").status_code == 404
    body = client.get("/api/relationships", query_string={"table": A}).get_json()
    assert "manual" not in {e["kind"] for e in body["edges"]}


def test_export_then_import_into_another_profile(client, data_dir):
    client.post("/api/relationships", json={"source": {"table": A}, "target": {"table": PH}, "note": "n"})
    client.patch("/api/relationships/" + f"fk:{A}->{B}".replace(">", "%3E"), json={"note": "derived note"})
    dump = client.get("/api/relationships/export").get_json()
    assert dump["version"] == 1 and len(dump["edges"]) == 1 and len(dump["overlays"]) == 1
    app_module.STATE["ex"] = FakeExplorer(data_dir, profile="other")
    assert client.get("/api/relationships/export").get_json()["edges"] == []
    r = client.post("/api/relationships/import", json=dump)
    assert r.status_code == 200 and r.get_json() == {"imported": 1, "created": 1, "updated": 0, "overlays": 1,
                                                  "concepts": 0, "concepts_created": 0}
    assert client.get("/api/relationships/export").get_json()["edges"] == dump["edges"]
    again = client.post("/api/relationships/import", json=dump).get_json()
    assert (again["created"], again["updated"]) == (0, 1)


def test_import_rejects_bad_files_with_a_path(client):
    r = client.post("/api/relationships/import", json={"version": 1, "edges": [{"kind": "fk"}]})
    assert r.status_code == 400 and r.get_json()["error"].startswith("edges[0].")
    r = client.post("/api/relationships/import", data="[", content_type="application/json")
    assert r.status_code == 400
