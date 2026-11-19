"""What the Graph draws for neighbors: one edge per pair, superseded edges, missing objects and true kinds."""
import json
from types import SimpleNamespace

import pytest

from databricks_explore import dbx, neighbors, relationships, lineage


def info(full, type_, deps=(), created=None):
    return {"full_name": full, "table_type": type_, "created_at": created,
            "view_dependencies": {"dependencies": [{"table": {"table_full_name": d}} for d in deps]} if deps else None}


class Tables:
    def __init__(self, infos):
        self.infos, self.gets = infos, []

    def get(self, full_name):
        self.gets.append(full_name)
        if full_name not in self.infos:
            cat = full_name.split(".")[0]
            if cat in {n.split(".")[0] for n in self.infos}:
                raise LookupError(f"Table '{full_name}' does not exist")
            raise LookupError(f"Catalog '{cat}' does not exist")
        return SimpleNamespace(as_dict=lambda: self.infos[full_name])


class Api:
    def __init__(self, lineage):
        self.lineage = lineage

    def do(self, method, path, body=None, **_):
        return self.lineage.get(body["table_name"], {})


def item(full, type_="TABLE", ts="2026-11-14 12:00:00.0"):
    c, s, n = full.split(".")
    return {"tableInfo": {"catalog_name": c, "schema_name": s, "name": n, "table_type": type_, "lineage_timestamp": ts}}


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    """An Explorer over a fake client: `infos` is what tables.get knows, `lin` what the lineage API says."""
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)

    def make(infos, lin, profile="p"):
        client = SimpleNamespace(tables=Tables(infos), api_client=Api(lin), config=SimpleNamespace(host="https://h"))
        monkeypatch.setattr(dbx, "WorkspaceClient", lambda profile=None: client)
        ex = dbx.Explorer(profile)
        ex.client = client
        return ex
    return make


V = "c.s.v"
A, B, C, D = "c.s.a", "c.s.b", "c.s.c", "other.s.d"


def kinds(rel):
    return {e["id"]: e["kind"] for e in rel["edges"]}


def test_a_view_and_its_source_are_one_edge_with_the_lineage_time_as_last_read(workspace):
    ex = workspace({V: info(V, "VIEW", [A]), A: info(A, "MANAGED")},
                   {V: {"upstreams": [item(A, ts="2026-11-15 10:42:00.0")]}})
    rel = ex.relations(V)
    assert kinds(rel) == {f"view_dep:{A}->{V}": "view_dep"}
    assert rel["edges"][0]["last_read"] == "2026-11-15 10:42:00.0" and not rel["edges"][0].get("superseded")


def test_the_pair_is_one_edge_from_the_sources_side_too(workspace):
    ex = workspace({V: info(V, "VIEW", [A]), A: info(A, "MANAGED")},
                   {A: {"downstreams": [item(V, "PERSISTED_VIEW")]}})
    rel = ex.relations(A)
    assert kinds(rel) == {f"view_dep:{A}->{V}": "view_dep"}
    assert {n["id"]: n["kind"] for n in rel["nodes"]}[V] == "view"


def test_sources_a_view_no_longer_reads_are_superseded_however_recent(workspace):
    sources = [A, B, C, D]
    ex = workspace({V: info(V, "VIEW", [A]), **{s: info(s, "MANAGED") for s in sources}},
                   {V: {"upstreams": [item(s, ts="2026-11-18 23:00:00.0") for s in sources]}})
    rel = ex.relations(V)
    by_id = {e["id"]: e for e in rel["edges"]}
    assert not by_id[f"view_dep:{A}->{V}"].get("superseded")
    lineage_ids = [f"lineage:{'<->'.join(sorted([s, V]))}" for s in (B, C, D)]
    assert all(by_id[i]["superseded"] for i in lineage_ids) and len(by_id) == 4


def test_an_old_edge_that_still_holds_is_never_superseded(workspace):
    ex = workspace({V: info(V, "VIEW", [A]), A: info(A, "MANAGED")}, {V: {"upstreams": [item(A, ts="2020-01-01 00:00:00.0")]}})
    assert not any(e.get("superseded") for e in ex.relations(V)["edges"])


def test_a_table_recreated_after_the_event_supersedes_it(workspace):
    created = 1763500000000  # 2025-11-18 21:06 UTC
    ex = workspace({C: info(C, "MANAGED", created=created), A: info(A, "MANAGED")},
                   {C: {"upstreams": [item(A, ts="2025-11-18 20:00:00.0")]}})
    assert ex.relations(C)["edges"][0]["superseded"] is True
    ex = workspace({C: info(C, "MANAGED", created=created), A: info(A, "MANAGED")},
                   {C: {"upstreams": [item(A, ts="2025-11-18 22:00:00.0")]}}, profile="q")
    assert "superseded" not in ex.relations(C)["edges"][0]


def test_a_downstream_neighbor_is_judged_by_its_own_metadata(workspace):
    ex = workspace({A: info(A, "MANAGED"), V: info(V, "VIEW", [B])}, {A: {"downstreams": [item(V, "VIEW")]}})
    edge = ex.relations(A)["edges"][0]
    assert edge["kind"] == "lineage" and edge["superseded"] is True


def test_a_view_with_no_view_dependencies_falls_back_to_its_creation_time(workspace):
    ex = workspace({V: info(V, "VIEW", created=1763500000000), A: info(A, "MANAGED")},
                   {V: {"upstreams": [item(A, ts="2025-11-18 20:00:00.0")]}})
    assert ex.relations(V)["edges"][0]["superseded"] is True


def test_a_missing_catalog_marks_the_node_and_is_not_an_error(workspace):
    gone = "old_cat.shop.orders"
    ex = workspace({V: info(V, "VIEW", [gone, A]), A: info(A, "MANAGED"), "new_cat.shop.orders": info("new_cat.shop.orders", "MANAGED")}, {})
    rel = ex.relations(V)
    node = {n["id"]: n for n in rel["nodes"]}[gone]
    assert node["missing"] is True and node["missing_reason"] == "catalog `old_cat` does not exist"
    assert rel["errors"] == [] and "missing" not in {n["id"]: n for n in rel["nodes"]}[A]
    assert not any(n.get("missing") for n in rel["nodes"] if n["id"] == V)


def test_a_missing_table_in_an_existing_schema_and_the_likely_new_name(workspace, tmp_path):
    ex = workspace({V: info(V, "VIEW", ["c.shop.orders"])}, {})
    # the cache knows a table of the same schema and name in another catalog
    for rel, data in (("catalogs.json", [{"name": "c"}, {"name": "new_cat"}]),
                      ("c/schemas.json", [{"name": "s"}, {"name": "shop"}]),
                      ("new_cat/shop/objects.json", [{"name": "orders", "full_name": "new_cat.shop.orders", "type": "MANAGED"}])):
        p = ex.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"fetched_at": "x", "data": data}))
    node = {n["id"]: n for n in ex.relations(V)["nodes"]}["c.shop.orders"]
    assert node["missing"] and node["missing_reason"] == "table `c.shop.orders` does not exist"
    assert node["renamed_to"] == "new_cat.shop.orders"


def test_an_object_that_exists_is_not_missing_and_a_listed_one_costs_no_call(workspace):
    ex = workspace({V: info(V, "VIEW", [A])}, {})
    listing = ex.root / "c/s/objects.json"
    listing.parent.mkdir(parents=True, exist_ok=True)
    listing.write_text(json.dumps({"fetched_at": "x", "data": [{"name": "a", "full_name": A, "type": "MATERIALIZED_VIEW"}]}))
    rel = ex.relations(V)
    node = {n["id"]: n for n in rel["nodes"]}[A]
    assert "missing" not in node and node["kind"] == "materialized_view"
    assert ex.client.tables.gets == [V]


def test_a_missing_object_is_looked_up_once_until_a_refresh(workspace):
    ex = workspace({V: info(V, "VIEW", ["gone.s.t"])}, {})
    ex.relations(V)
    ex.relations(V)
    assert ex.client.tables.gets.count("gone.s.t") == 1
    ex.relations(V, refresh=True)
    assert ex.client.tables.gets.count("gone.s.t") == 2


def test_the_neighbor_lookups_are_capped(workspace, monkeypatch):
    monkeypatch.setattr(dbx, "MAX_NEIGHBOR_READS", 2)
    names = [f"c.s.t{i}" for i in range(5)]
    ex = workspace({V: info(V, "VIEW", names), **{n: info(n, "EXTERNAL") for n in names}}, {})
    rel = ex.relations(V)
    assert len(ex.client.tables.gets) == 3  # the object and two neighbors
    assert all("missing" not in n for n in rel["nodes"]) and len(rel["nodes"]) == 6


def test_kind_follows_the_object_chain_not_the_lineage_guess(workspace):
    ex = workspace({"c.s.t": info("c.s.t", "MANAGED"), "c.s.v1": info("c.s.v1", "VIEW", ["c.s.t"]),
                    "c.s.v2": info("c.s.v2", "VIEW", ["c.s.v1"]), "c.s.m": info("c.s.m", "METRIC_VIEW", ["c.s.v2"])},
                   {"c.s.v2": {"upstreams": [item("c.s.v1", "TABLE")], "downstreams": [item("c.s.m", "TABLE")]}})
    got = {n["id"]: n["kind"] for n in ex.relations("c.s.v2")["nodes"]}
    assert got == {"c.s.v2": "view", "c.s.v1": "view", "c.s.m": "metric_view"}


@pytest.mark.parametrize("given,want", [("PERSISTED_VIEW", "view"), ("VIEW", "view"), ("MANAGED", "table"), ("EXTERNAL", "table"),
                                        ("TABLE", "table"), ("MATERIALIZED_VIEW", "materialized_view"), ("STREAMING_TABLE", "streaming_table"),
                                        ("METRIC_VIEW", "metric_view"), ("FOREIGN", "table"), (None, "table"), ("Weird", "weird")])
def test_the_lineage_and_tables_vocabularies_map_to_one(given, want):
    assert neighbors.normalize_kind(given) == want


def test_an_objects_own_type_wins_over_the_guess():
    assert neighbors.kind_of("MANAGED", "VIEW") == "managed" and neighbors.kind_of("PERSISTED_VIEW") == "view"
    assert neighbors.kind_of(None, "PERSISTED_VIEW") == "view" and neighbors.kind_of(None, "TABLE") == "table"


def test_parse_ts_reads_lineage_iso_and_epoch_forms():
    assert neighbors.parse_ts("2026-10-26 14:02:52.0") == neighbors.parse_ts("2026-10-26T14:02:52Z")
    assert neighbors.parse_ts(1763500000000).year == 2025 and neighbors.parse_ts("soon") is None


def test_superseded_edges_become_the_superseded_status_and_a_live_member_wins():
    rel = {"nodes": [], "edges": [
        {"id": "lineage:a<->b", "source": "c.s.a", "target": "c.s.b", "kind": "lineage", "last_seen": "t",
         "last_seen_by_dir": {"c.s.a->c.s.b": "t"}, "superseded": True},
        {"id": "view_dep:c.s.c->c.s.b", "source": "c.s.c", "target": "c.s.b", "kind": "view_dep", "last_read": "2026-11-15 10:42:00.0"}]}
    out = {(e.kind, e.source.table): e for e in relationships.derive_edges(rel)}
    assert out[("lineage", "c.s.a")].status == "superseded" and out[("view_dep", "c.s.c")].status == "derived"
    assert out[("view_dep", "c.s.c")].evidence.last_seen == "2026-11-15 10:42:00.0"
    rolled = relationships.rollup(list(out.values()))
    assert {r.kind: r.status for r in rolled} == {"lineage": "superseded", "view_dep": "derived"}


def test_a_superseded_status_is_never_stored():
    edge = relationships.Edge(kind="manual", source=relationships.Endpoint(table="c.s.a"), target=relationships.Endpoint(table="c.s.b"),
                              provenance=relationships.Provenance(origin="user"), status="superseded")
    with pytest.raises(relationships.RelationshipInvalid):
        relationships.check_storable(edge)


def test_walk_and_connectors_skip_superseded_edges():
    rel = {"nodes": [], "edges": [
        {"id": "x", "source": "a", "target": "b", "kind": "lineage", "superseded": True},
        {"id": "y", "source": "a", "target": "c", "kind": "view_dep"}]}
    out = lineage.walk(lambda t: rel, "a", "downstream", 1)
    assert [n["table"] for n in out["nodes"]] == ["a", "c"]
    assert [(p["source"], p["target"]) for p in lineage.among(lambda t: rel, ["a", "b", "c"])] == [("a", "c")]


def test_a_refresh_notices_a_cached_neighbor_that_was_dropped_since(workspace):
    # live on dbx-free: a view's source dropped after the graph was read stayed a plain table (its object was cached) until the cache was cleared
    ex = workspace({V: info(V, "VIEW", [A]), A: info(A, "MANAGED")}, {})
    assert "missing" not in {n["id"]: n for n in ex.relations(V)["nodes"]}[A]
    del ex.client.tables.infos[A]
    assert "missing" not in {n["id"]: n for n in ex.relations(V)["nodes"]}[A]  # an ordinary read keeps what it cached
    node = {n["id"]: n for n in ex.relations(V, refresh=True)["nodes"]}[A]
    assert node["missing"] is True and node["missing_reason"] == f"table `{A}` does not exist"


def test_a_refresh_reads_cached_neighbors_again_within_the_budget(workspace, monkeypatch):
    ex = workspace({V: info(V, "VIEW", [A, B]), A: info(A, "MANAGED"), B: info(B, "MANAGED")}, {})
    ex.relations(V)
    ex.client.tables.gets.clear()
    monkeypatch.setattr(dbx, "MAX_NEIGHBOR_READS", 1)
    ex.relations(V, refresh=True)
    assert sorted(ex.client.tables.gets) == sorted([V, A])  # the object itself, then one neighbor; the other keeps its cached copy


def test_a_dropped_object_reports_not_found_and_not_the_lineage_apis_permission_answer(workspace):
    ex = workspace({A: info(A, "MANAGED"), B: info(B, "MANAGED")}, {})

    def lineage_for_a_dropped_table(method, path, body=None, **_):  # as the lineage API answered live for a table that was dropped
        raise PermissionError("This user does not have permission to query table c.s.gone in unity catalog.")
    ex.client.api_client.do = lineage_for_a_dropped_table
    rel = ex.relations("c.s.gone")
    assert rel["errors"] == ["tables.get: Table 'c.s.gone' does not exist"]


def test_a_ctas_event_a_fraction_of_a_second_before_created_at_is_not_superseded(workspace):
    # live on dbx-free: orders_daily was created at 13:00:27.300 and its lineage event was stamped 13:00:27.0
    created = 1795093227300  # ms
    ex = workspace({A: info(A, "MANAGED"), B: info(B, "MANAGED", created=created)}, {A: {"downstreams": [item(B, ts="2026-11-19 13:00:27.0")]}})
    (edge,) = ex.relations(A)["edges"]
    assert edge["kind"] == "lineage" and not edge.get("superseded")
    ex = workspace({A: info(A, "MANAGED"), B: info(B, "MANAGED", created=created)}, {A: {"downstreams": [item(B, ts="2026-11-19 12:50:00.0")]}}, profile="q")
    assert ex.relations(A)["edges"][0]["superseded"] is True  # ten minutes older: an earlier table


def test_a_materialized_view_is_judged_by_its_creation_time_not_by_its_backing_table(workspace):
    # live: a materialized view's view_dependencies name only __materialization_..., never its sources
    mv = "c.s.mv"
    backing = "c.s.__materialization_mat_c68c7ebe_mv_1"
    ex = workspace({A: info(A, "MANAGED"), mv: info(mv, "MATERIALIZED_VIEW", [backing], created=1795093302241)},
                   {A: {"downstreams": [item(mv, "MATERIALIZED_VIEW", ts="2026-11-19 13:01:55.0")]}})
    (edge,) = ex.relations(A)["edges"]
    assert edge["kind"] == "lineage" and not edge.get("superseded")
