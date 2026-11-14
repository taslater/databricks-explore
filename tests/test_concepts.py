"""Concepts: the model, the migration, links, search, candidates, tag suggestions, export/import and the routes.

dbx.DATA points at tmp_path in every test, so the real data directory is never written. No warehouse is used: the
tag run is fed a fake query result, and the route test uses a fake Explorer.
"""
import sqlite3

import pytest

from databricks_explore import app as app_module
from databricks_explore import concepts
from databricks_explore import dbx
from databricks_explore import relationships as rel

A, B = "main.sales.orders", "main.sales.customers"
PH = "ph:7f0c2d3e-1111-4222-8333-444455556666"
MISSING = "0b1c2d3e-1111-4222-8333-444455556666"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    return tmp_path


@pytest.fixture
def store():
    with rel.Store(":memory:") as s:
        yield s


def make(store, name="Customer", **kw):
    return concepts.create(store, concepts.parse_create({"name": name, **kw}))


def link(store, c, table=A, relation="defines", column=None, **kw):
    body = concepts.parse_link({"target": {"table": table, "column": column}, "relation": relation, **kw})
    return concepts.add_link(store, c.id, body)[0]


# ---------- the model and the migration ----------

def test_migration_adds_the_concept_table_and_relation_column(data_dir):
    path = rel.db_path("dev")
    with rel.Store(path):
        pass
    db = sqlite3.connect(path)
    assert db.execute("PRAGMA user_version").fetchone()[0] == len(rel.MIGRATIONS) == 2
    assert {r[1] for r in db.execute("PRAGMA table_info(concept)")} >= {"id", "name", "status", "provenance"}
    assert "relation" in {r[1] for r in db.execute("PRAGMA table_info(edge)")}


def test_a_version_1_database_keeps_its_edges_through_the_upgrade(data_dir):
    path = rel.db_path("dev")
    path.parent.mkdir(parents=True)
    db = sqlite3.connect(path)
    db.executescript(rel._V1 + "PRAGMA user_version = 1;")
    db.execute("INSERT INTO edge VALUES ('e_1','manual',?,'',?,'',1,'{\"origin\":\"user\"}',NULL,'accepted','',?,?)",
               (A, B, "t", "t"))
    db.commit()
    db.close()
    with rel.Store(path) as s:
        (e,) = s.all_edges()
        assert e.id == "e_1" and e.relation is None


def test_endpoint_accepts_a_concept_but_not_with_a_column():
    cid = "7f0c2d3e-1111-4222-8333-444455556666"
    assert rel.Endpoint(table=f"concept:{cid.upper()}").table == f"concept:{cid}"
    with pytest.raises(ValueError, match="concept"):
        rel.Endpoint(table="concept:nope")
    with pytest.raises(ValueError, match="no columns"):
        rel.Endpoint(table=f"concept:{cid}", column="x")


def test_concept_fields_are_cleaned():
    c = rel.Concept(name="  Customer ", synonyms=[" client", "Client", "", "buyer"], domain="  ", tags=["a", "A"])
    assert c.name == "Customer" and c.synonyms == ["client", "buyer"] and c.domain is None and c.tags == ["a"]
    assert c.status == "draft" and c.provenance.origin == "manual"
    with pytest.raises(ValueError):
        rel.Concept(name="x", status="final")
    with pytest.raises(ValueError):
        rel.Concept(name="x", provenance={"origin": "user"})


# ---------- CRUD ----------

def test_create_get_update_delete(store):
    c = make(store, "Customer", definition="Someone who buys.", synonyms=["client"], domain="Sales", tags=["core"])
    got = concepts.detail(store, c.id)
    assert got["name"] == "Customer" and got["links"] == [] and got["provenance"]["origin"] == "manual"
    concepts.update(store, c.id, concepts.parse_patch({"status": "certified", "domain": None}))
    got = concepts.detail(store, c.id)
    assert got["status"] == "certified" and got["domain"] is None and got["definition"] == "Someone who buys."
    assert got["updated_at"] >= got["created_at"]
    assert concepts.remove(store, c.id) == {"deleted": c.id, "links_removed": 0}
    with pytest.raises(rel.RelationshipNotFound, match="concept not found"):
        store.concept(c.id)


def test_names_are_unique_case_insensitively(store):
    make(store, "Customer")
    with pytest.raises(rel.RelationshipInvalid, match="already exists"):
        make(store, "customer")
    other = make(store, "Order")
    with pytest.raises(rel.RelationshipInvalid, match="already exists"):
        concepts.update(store, other.id, concepts.parse_patch({"name": "CUSTOMER"}))
    concepts.update(store, other.id, concepts.parse_patch({"name": "ORDER"}))  # its own name in another case is fine


def test_names_are_unique_per_profile_not_across_them(data_dir):
    with rel.open_store("one") as s:
        make(s, "Customer")
    with rel.open_store("two") as s:
        make(s, "Customer")


@pytest.mark.parametrize("body, message", [
    ([], r"^\(root\): body must be a JSON object"),
    ({}, r"^name: "),
    ({"name": ""}, r"^name: "),
    ({"name": "x", "status": "final"}, r"^status: "),
    ({"name": "x", "synonyms": "a"}, r"^synonyms: "),
    ({"name": "x", "extra": 1}, r"^extra: "),
])
def test_create_rejects_bad_bodies(body, message):
    with pytest.raises(rel.RelationshipInvalid, match=message):
        concepts.parse_create(body)


def test_patch_needs_a_field_and_refuses_null_for_required_ones():
    with pytest.raises(rel.RelationshipInvalid, match="at least one"):
        concepts.parse_patch({})
    with pytest.raises(rel.RelationshipInvalid, match="name: cannot be null"):
        concepts.parse_patch({"name": None})


def test_listing_searches_name_synonyms_and_definition_and_filters(store):
    a = make(store, "Customer", synonyms=["client"], domain="Sales", status="certified")
    make(store, "Invoice", definition="Bill sent to a client after delivery.", domain="Finance")
    make(store, "Warehouse", domain="sales")
    names = lambda **kw: [c["name"] for c in concepts.listing(store, **kw)["concepts"]]  # noqa: E731
    assert names() == ["Customer", "Invoice", "Warehouse"]
    assert names(q="CLIENT") == ["Customer", "Invoice"]  # a synonym and a definition
    assert names(q="warehouse") == ["Warehouse"]
    assert names(domain="SALES") == ["Customer", "Warehouse"]
    assert names(status="certified") == ["Customer"]
    assert names(q="client", domain="finance", status="draft") == ["Invoice"]
    assert concepts.listing(store)["domains"] == ["Finance", "Sales"]
    with pytest.raises(rel.RelationshipInvalid, match="status"):
        concepts.listing(store, status="final")
    link(store, a)
    assert concepts.listing(store, q="customer")["concepts"][0]["link_count"] == 1


# ---------- links ----------

def test_links_to_tables_columns_and_concepts(store):
    c, parent = make(store, "Customer"), make(store, "Party")
    t = link(store, c, A, "defines")
    col = link(store, c, B, "identifies", column="id", note="the key")
    sub = link(store, c, f"concept:{parent.id}", "is_a")
    assert (t.relation, t.status, t.provenance.origin, t.target.column) == ("defines", "accepted", "user", None)
    assert col.target.column == "id" and col.note == "the key" and sub.target.table == f"concept:{parent.id}"
    got = concepts.detail(store, c.id)
    assert [e["relation"] for e in got["links"]] == ["defines", "identifies", "is_a"]
    assert [e["source"]["table"] for e in concepts.detail(store, parent.id)["incoming"]] == [f"concept:{c.id}"]
    assert {e.kind for e in store.all_edges()} == {"concept_link"}


def test_linking_again_changes_the_relation_instead_of_duplicating(store):
    c = make(store)
    first, second = link(store, c, A, "defines"), link(store, c, A, "measures")
    assert first.id == second.id and second.relation == "measures"
    assert len(store.concept_links(c.id)) == 1


@pytest.mark.parametrize("target, relation, message", [
    ({"table": A}, "is_a", r"^relation: a link to a table or column is one of defines"),
    ({"table": f"concept:{MISSING}"}, "defines", r"^relation: a link to a concept is one of is_a"),
    ({"table": A}, "nope", r"^relation: "),
    ({"table": PH}, "defines", r"^target.table: a concept links to"),
    ({"table": "bad"}, "defines", r"^target.table: "),
])
def test_link_bodies_are_checked(target, relation, message):
    with pytest.raises(rel.RelationshipInvalid, match=message):
        concepts.parse_link({"target": target, "relation": relation})


def test_links_need_existing_concepts_and_no_self_link(store):
    c = make(store)
    with pytest.raises(rel.RelationshipNotFound, match="concept not found"):
        concepts.add_link(store, MISSING, concepts.parse_link({"target": {"table": A}, "relation": "defines"}))
    with pytest.raises(rel.RelationshipNotFound, match="concept not found"):
        link(store, c, f"concept:{MISSING}", "is_a")
    with pytest.raises(rel.RelationshipInvalid, match="itself"):
        link(store, c, f"concept:{c.id}", "related_to")


def test_store_refuses_malformed_concept_links_and_stray_concept_endpoints(store):
    c = make(store)
    src = rel.Endpoint(table=f"concept:{c.id}")
    tgt = rel.Endpoint(table=A)
    prov = rel.Provenance(origin="user")
    bad = [
        rel.Edge(kind="concept_link", source=tgt, target=src, provenance=prov, relation="defines"),  # starts at a table
        rel.Edge(kind="concept_link", source=src, target=tgt, provenance=prov),  # no relation
        rel.Edge(kind="manual", source=src, target=tgt, provenance=prov),  # concept in a non-concept edge
        rel.Edge(kind="manual", source=tgt, target=rel.Endpoint(table=B), provenance=prov, relation="defines"),
    ]
    for e in bad:
        with pytest.raises(rel.RelationshipInvalid):
            store.upsert(e)


def test_remove_link(store):
    c, d = make(store, "Customer"), make(store, "Party")
    t, sub = link(store, c, A), link(store, c, f"concept:{d.id}", "part_of")
    assert concepts.remove_link(store, c.id, t.id) == {"deleted": t.id}
    concepts.remove_link(store, d.id, sub.id)  # the target concept may remove an incoming link too
    assert store.concept_links(c.id) == []
    other = store.upsert(rel.Edge(kind="manual", source=rel.Endpoint(table=A), target=rel.Endpoint(table=B),
                                  provenance=rel.Provenance(origin="user"), status="accepted"))[0]
    with pytest.raises(rel.RelationshipNotFound):
        concepts.remove_link(store, c.id, other.id)  # not a link
    with pytest.raises(rel.RelationshipNotFound):
        concepts.remove_link(store, c.id, "e_missing")


def test_deleting_a_concept_deletes_its_links_both_ways(store):
    c, d, e = make(store, "Customer"), make(store, "Party"), make(store, "Order")
    link(store, c, A)
    link(store, c, f"concept:{d.id}", "is_a")
    link(store, e, f"concept:{c.id}", "related_to")  # points at c
    keep = link(store, e, B, "describes")
    assert concepts.remove(store, c.id)["links_removed"] == 3
    assert [x.id for x in store.all_edges()] == [keep.id]
    assert {x.name for x in store.concepts()} == {"Party", "Order"}


def test_concept_links_stay_out_of_the_table_graph(store):
    c = make(store)
    link(store, c, A)
    store.upsert(rel.Edge(kind="manual", source=rel.Endpoint(table=A), target=rel.Endpoint(table=B),
                          provenance=rel.Provenance(origin="user"), status="accepted"))
    assert [e.kind for e in store.edges_for(A)] == ["manual"]
    assert [e.kind for e in store.table_view()] == ["manual"]
    out = rel.unified(store, A)
    assert [e["kind"] for e in out["edges"]] == ["manual"]
    assert all(not n["id"].startswith("concept:") for n in out["nodes"])


def test_manual_edges_cannot_touch_concepts():
    with pytest.raises(rel.RelationshipInvalid, match="concept"):
        rel.parse_create({"source": {"table": f"concept:{MISSING}"}, "target": {"table": A}})
    with pytest.raises(rel.RelationshipInvalid, match="concept is not a table"):
        rel.check_table(f"concept:{MISSING}")


def test_for_tables_returns_the_concepts_linked_to_tables_or_their_columns(store):
    c, d = make(store, "Customer"), make(store, "Order")
    link(store, c, B, "defines")
    link(store, c, A, "identifies", column="customer_id")
    link(store, d, A, "defines")
    got = concepts.for_tables(store, [A])
    assert [x["name"] for x in got["concepts"]] == ["Customer", "Order"]
    assert [(e["target"]["column"], e["relation"]) for e in got["links"]] == [("customer_id", "identifies"), (None, "defines")]
    assert concepts.for_tables(store, []) == {"concepts": [], "links": []}
    assert concepts.for_tables(store, ["main.sales.none"]) == {"concepts": [], "links": []}


# ---------- candidates ----------

META = [
    {"table": "main.sales.dim_customers", "type": "MANAGED", "comment": "One row per account",
     "columns": [{"name": "customer_id", "comment": "Key"}, {"name": "region", "comment": "Where the client is based"},
                 {"name": "customerid_legacy", "comment": None}]},
    {"table": "main.sales.orders", "type": "MANAGED", "comment": "Orders placed by each customer", "columns": None},
    {"table": "main.hr.employees", "type": "MANAGED", "comment": None, "columns": [{"name": "salary", "comment": None}]},
]


def test_candidates_match_whole_words_in_names_and_comments(store):
    c = make(store, "Customer", synonyms=["client"])
    got = concepts.candidates(store, c.id, META)
    found = [(h["table"].split(".")[-1], h["column"], h["field"], h["matched"]) for h in got["hits"]]
    assert found == [("dim_customers", None, "name", "Customer"), ("dim_customers", "customer_id", "name", "Customer"),
                     ("dim_customers", "region", "comment", "client"), ("orders", None, "comment", "Customer")]
    assert got["terms"] == ["Customer", "client"]  # customerid_legacy is not a whole-word hit
    assert got["searched"] == {"tables": 3, "tables_with_columns": 2, "columns": 4}
    assert got["truncated"] is False and all(h["linked"] is False for h in got["hits"])


def test_candidates_flag_what_is_already_linked(store):
    c = make(store, "Customer")
    link(store, c, "main.sales.dim_customers", "identifies", column="customer_id")
    hits = {(h["table"], h["column"]): h["linked"] for h in concepts.candidates(store, c.id, META)["hits"]}
    assert hits[("main.sales.dim_customers", "customer_id")] is True
    assert hits[("main.sales.dim_customers", None)] is False


def test_candidates_with_a_multiword_name_and_an_empty_cache(store):
    c = make(store, "Order Line")
    meta = [{"table": "a.b.order_lines", "type": None, "comment": None, "columns": None}]
    assert len(concepts.candidates(store, c.id, meta)["hits"]) == 1
    assert concepts.candidates(store, c.id, [])["hits"] == []


# ---------- suggestions from tags ----------

def result(*rows):
    names = ["scope", "catalog_name", "schema_name", "table_name", "column_name", "tag_name", "tag_value"]
    return {"columns": [{"name": n} for n in names], "rows": [list(r) for r in rows], "truncated": False}


TAGS = result(
    ("table", "main", "sales", "orders", None, "domain", "sales"),
    ("table", "main", "sales", "customers", None, "domain", "sales"),
    ("column", "main", "sales", "customers", "email", "pii", "email"),
    ("table", "main", "sales", "orders", None, "certified", ""),
    ("schema", "main", "sales", None, None, "domain", "sales"),
    ("catalog", "main", None, None, None, "env", "prod"),
)


def test_the_plan_is_read_only_sql_over_the_four_tag_tables():
    plan = concepts.tag_plan("wh-1")
    sql = plan["queries"][0]["sql"]
    assert plan["warehouse_id"] == "wh-1" and plan["row_cap"] == concepts.TAG_ROW_CAP
    for t in ("catalog_tags", "schema_tags", "table_tags", "column_tags"):
        assert f"system.information_schema.{t}" in sql
    assert sql.lstrip().upper().startswith("SELECT") and ";" not in sql


def test_a_tag_run_makes_draft_concepts_linked_with_describes(store):
    out = concepts.tag_run(store, TAGS)
    assert out["skipped"] == [] and out["updated"] == [] and out["rows"] == 6 and out["truncated"] is False
    assert sorted(c["name"] for c in out["created"]) == ["certified", "domain=sales", "env=prod", "pii=email"]
    by_name = {c.name: c for c in store.concepts()}
    dom = by_name["domain=sales"]
    assert (dom.status, dom.provenance.origin, dom.provenance.source_ref) == ("draft", "uc_tag", "domain=sales")
    assert "schema main.sales" in dom.definition and dom.tags == ["domain"]
    links = store.concept_links(dom.id)
    assert sorted(e.target.table for e in links) == [B, A]
    assert {(e.relation, e.provenance.origin, e.provenance.source_ref) for e in links} == {("describes", "uc_tag", "domain=sales")}
    (pii,) = store.concept_links(by_name["pii=email"].id)
    assert (pii.target.table, pii.target.column) == (B, "email")
    assert store.concept_links(by_name["env=prod"].id) == []  # a catalog tag has nothing to link
    assert by_name["certified"].definition.startswith("Unity Catalog tag certified.")


def test_a_second_run_updates_and_never_duplicates_or_overwrites_edits(store):
    concepts.tag_run(store, TAGS)
    dom = next(c for c in store.concepts() if c.name == "domain=sales")
    concepts.update(store, dom.id, concepts.parse_patch({"definition": "Our sales domain.", "status": "reviewed",
                                                         "name": "Sales domain"}))
    link(store, dom, "main.sales.returns", "describes")  # a person's own link
    again = result(
        ("table", "main", "sales", "orders", None, "domain", "sales"),
        ("table", "main", "sales", "shipments", None, "domain", "sales"),  # newly tagged; customers lost the tag
        ("column", "main", "sales", "customers", "email", "pii", "email"))
    out = concepts.tag_run(store, again)
    assert out["created"] == [] and sorted(c["name"] for c in out["updated"]) == ["Sales domain", "pii=email"]
    assert len(store.concepts()) == 4  # nothing new
    changed = next(c for c in out["updated"] if c["name"] == "Sales domain")
    assert (changed["links_added"], changed["links_removed"]) == (1, 1)
    now = store.concept(dom.id)
    assert (now.name, now.definition, now.status) == ("Sales domain", "Our sales domain.", "reviewed")
    assert now.provenance.origin == "uc_tag" and now.provenance.source_ref == "domain=sales"
    assert sorted(e.target.table for e in store.concept_links(dom.id)) == [
        A, "main.sales.returns", "main.sales.shipments"]  # customers went; the person's link stayed
    assert concepts.tag_run(store, again)["updated"][0]["links_added"] == 0  # idempotent


def test_a_tag_run_does_not_take_over_a_manual_link_or_name(store):
    manual = make(store, "pii=email", definition="mine")
    concepts.tag_run(store, TAGS)
    assert store.concept(manual.id).provenance.origin == "manual"
    assert "pii=email (UC tag)" in {c.name for c in store.concepts()}
    again = concepts.tag_run(store, TAGS)  # found by its tag now, so no new name and no skip
    assert again["skipped"] == [] and len(store.concepts()) == 5


def test_a_tag_run_handles_rows_it_cannot_use(store):
    out = concepts.tag_run(store, {"columns": [{"name": "scope"}, {"name": "tag_name"}], "rows": [["table", ""]],
                                   "truncated": True})
    assert out["created"] == [] and out["truncated"] is True
    assert concepts.tag_run(store, {}) == {"created": [], "updated": [], "skipped": [], "rows": 0, "truncated": False}


# ---------- export / import ----------

def test_export_and_import_round_trip_concepts_and_links(store):
    c, d = make(store, "Customer", synonyms=["client"], domain="Sales", status="certified"), make(store, "Party")
    link(store, c, A, "defines")
    link(store, c, B, "identifies", column="id")
    link(store, c, f"concept:{d.id}", "is_a")
    dump = store.export()
    assert len(dump["concepts"]) == 2 and len(dump["edges"]) == 3
    only = store.export(concepts_only=True)
    assert only["concepts"] == dump["concepts"] and only["overlays"] == []
    with rel.Store(":memory:") as other:
        counts = other.import_file(rel.parse_export(dump))
        assert counts["concepts"] == 2 and counts["concepts_created"] == 2 and counts["created"] == 3
        assert other.export()["concepts"] == dump["concepts"] and other.export()["edges"] == dump["edges"]
        again = other.import_file(rel.parse_export(dump))
        assert again["concepts_created"] == 0 and again["created"] == 0 and again["updated"] == 3
        assert len(other.concepts()) == 2 and len(other.all_edges()) == 3


def test_import_is_all_or_nothing_for_concepts(store):
    existing = make(store, "Customer")
    other = rel.Concept(name="customer")  # same name, different id
    fresh = rel.Concept(name="Fresh")
    dump = {"version": 1, "concepts": [fresh.model_dump(mode="json"), other.model_dump(mode="json")], "edges": []}
    with pytest.raises(rel.RelationshipInvalid, match="already exists"):
        store.import_file(rel.parse_export(dump))
    assert [c.name for c in store.concepts()] == ["Customer"] and store.concept(existing.id)
    # a link to a concept that is nowhere
    stray = rel.Edge(kind="concept_link", source=rel.Endpoint(table=f"concept:{fresh.id}"), target=rel.Endpoint(table=A),
                     provenance=rel.Provenance(origin="user"), status="accepted", relation="defines")
    dump = {"version": 1, "concepts": [], "edges": [stray.model_dump(mode="json")]}
    with pytest.raises(rel.RelationshipNotFound):
        store.import_file(rel.parse_export(dump))
    assert len(store.concepts()) == 1 and store.all_edges() == []


@pytest.mark.parametrize("edit, message", [
    (lambda d: d["concepts"].append(d["concepts"][0]), "share a id"),
    (lambda d: d["concepts"].append({**d["concepts"][0], "id": MISSING, "name": "CUSTOMER"}), "share a name"),
    (lambda d: d["concepts"][0].update(status="final"), r"^concepts\[0\]\.status"),
    (lambda d: d["edges"][0].update(relation="is_a"), r"^edges\[0\]\.relation"),
    (lambda d: d["edges"][0].update(relation=None), r"^edges\[0\]\.relation"),
])
def test_parse_export_validates_concepts(store, edit, message):
    c = make(store, "Customer")
    link(store, c, A)
    dump = store.export()
    edit(dump)
    with pytest.raises(rel.RelationshipInvalid, match=message):
        rel.parse_export(dump)


# ---------- routes ----------

class FakeExplorer:
    def __init__(self, tmp_path, query_result=None):
        self.profile, self.warehouse_id, self.root = "dev", "wh-1", tmp_path / "cache"
        self.query_result, self.queries = query_result, []

    def query(self, sql, params=None, max_rows=5000):
        self.queries.append((sql, max_rows))
        return self.query_result


@pytest.fixture
def client(data_dir, monkeypatch):
    ex = FakeExplorer(data_dir, TAGS)
    monkeypatch.setitem(app_module.STATE, "ex", ex)
    c = app_module.app.test_client()
    c.fake = ex
    return c


def test_crud_routes(client):
    r = client.post("/api/concepts", json={"name": "Customer", "synonyms": ["client"], "domain": "Sales"})
    assert r.status_code == 201 and r.json["links"] == []
    cid = r.json["id"]
    assert client.post("/api/concepts", json={"name": "customer"}).status_code == 400
    assert client.get(f"/api/concepts/{cid}").json["name"] == "Customer"
    patched = client.patch(f"/api/concepts/{cid}", json={"status": "reviewed", "definition": "A buyer."})
    assert patched.status_code == 200 and patched.json["status"] == "reviewed" and patched.json["definition"] == "A buyer."
    assert client.patch(f"/api/concepts/{cid}", json={}).status_code == 400
    listed = client.get("/api/concepts?q=client&domain=sales&status=reviewed").json
    assert [c["name"] for c in listed["concepts"]] == ["Customer"] and listed["domains"] == ["Sales"]
    assert client.get("/api/concepts?status=final").status_code == 400
    assert client.delete(f"/api/concepts/{cid}").json == {"deleted": cid, "links_removed": 0}
    assert client.get(f"/api/concepts/{cid}").status_code == 404
    assert client.get("/api/concepts/not-a-uuid").status_code == 404
    assert client.delete(f"/api/concepts/{cid}").status_code == 404


def test_link_routes(client):
    cid = client.post("/api/concepts", json={"name": "Customer"}).json["id"]
    pid = client.post("/api/concepts", json={"name": "Party"}).json["id"]
    r = client.post(f"/api/concepts/{cid}/links", json={"target": {"table": A, "column": "id"}, "relation": "identifies"})
    assert r.status_code == 201 and r.json["relation"] == "identifies" and r.json["source"]["table"] == f"concept:{cid}"
    again = client.post(f"/api/concepts/{cid}/links", json={"target": {"table": A, "column": "id"}, "relation": "describes"})
    assert again.status_code == 200 and again.json["id"] == r.json["id"]
    sub = client.post(f"/api/concepts/{cid}/links", json={"target": {"table": f"concept:{pid}"}, "relation": "is_a"})
    assert sub.status_code == 201
    assert client.post(f"/api/concepts/{cid}/links", json={"target": {"table": A}, "relation": "is_a"}).status_code == 400
    assert client.post(f"/api/concepts/{MISSING}/links", json={"target": {"table": A}, "relation": "defines"}).status_code == 404
    detail = client.get(f"/api/concepts/{cid}").json
    assert len(detail["links"]) == 2 and len(client.get(f"/api/concepts/{pid}").json["incoming"]) == 1
    got = client.get(f"/api/concepts/for-tables?table={A}&table=main.x.y").json
    assert [c["name"] for c in got["concepts"]] == ["Customer"] and len(got["links"]) == 1
    assert client.delete(f"/api/concepts/{cid}/links/{r.json['id']}").json == {"deleted": r.json["id"]}
    assert client.delete(f"/api/concepts/{cid}/links/{r.json['id']}").status_code == 404
    assert client.delete(f"/api/concepts/{pid}").json["links_removed"] == 1
    assert len(client.get(f"/api/concepts/{cid}").json["links"]) == 0
    # concept links never show up as table relationships
    assert client.get(f"/api/concepts/for-tables?table={A}").json["links"] == []


def test_candidates_route_reads_only_the_cache(client, data_dir):
    cache = data_dir / "cache" / "main" / "sales"
    (cache / "obj").mkdir(parents=True)
    (cache / "objects.json").write_text('{"data": [{"name": "customers", "full_name": "main.sales.customers", '
                                        '"type": "MANAGED", "comment": "Who buys"}]}')
    (cache / "obj" / "main.sales.customers.json").write_text(
        '{"data": {"full_name": "main.sales.customers", "comment": "Who buys", '
        '"columns": [{"name": "customer_id", "comment": "Key"}]}}')
    cid = client.post("/api/concepts", json={"name": "Customer"}).json["id"]
    out = client.get(f"/api/concepts/{cid}/candidates").json
    assert [(h["table"], h["column"]) for h in out["hits"]] == [("main.sales.customers", None),
                                                               ("main.sales.customers", "customer_id")]
    assert out["searched"] == {"tables": 1, "tables_with_columns": 1, "columns": 1}
    assert client.fake.queries == []  # no warehouse call
    assert client.get(f"/api/concepts/{MISSING}/candidates").status_code == 404


def test_suggest_routes(client):
    plan = client.get("/api/concepts/suggest/plan").json
    assert plan["queries"][0]["sql"] == concepts.TAG_SQL and plan["warehouse_id"] == "wh-1"
    assert client.fake.queries == []  # a plan runs nothing
    run = client.post("/api/concepts/suggest/run").json
    assert len(run["created"]) == 4 and client.fake.queries == [(concepts.TAG_SQL, concepts.TAG_ROW_CAP)]
    again = client.post("/api/concepts/suggest/run").json
    assert again["created"] == [] and len(again["updated"]) == 4
    assert len(client.get("/api/concepts").json["concepts"]) == 4


def test_export_import_routes(client):
    cid = client.post("/api/concepts", json={"name": "Customer"}).json["id"]
    client.post(f"/api/concepts/{cid}/links", json={"target": {"table": A}, "relation": "defines"})
    dump = client.get("/api/concepts/export").json
    assert len(dump["concepts"]) == 1 and len(dump["edges"]) == 1
    assert len(client.get("/api/relationships/export").json["concepts"]) == 1
    client.delete(f"/api/concepts/{cid}")
    assert client.get("/api/concepts").json["concepts"] == []
    r = client.post("/api/relationships/import", json=dump)
    assert r.status_code == 200 and r.json["concepts_created"] == 1 and r.json["created"] == 1
    assert client.get(f"/api/concepts/{cid}").json["links"][0]["relation"] == "defines"
    bad = {**dump, "concepts": []}
    client.delete(f"/api/concepts/{cid}")
    assert client.post("/api/relationships/import", json=bad).status_code == 404
    assert client.get("/api/concepts").json["concepts"] == []
