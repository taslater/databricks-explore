"""Store support for mined edges: evidence merging, the suggestions list, bulk status, and column lineage edges."""
import pytest

from databricks_explore import relationships as rel

A, B, C = "main.sales.orders", "main.sales.customers", "main.sales.raw"


def mined(src, sc, tgt, tc, runs=1, users=1, last="2026-11-01", refs=("s1",), first="2026-10-01"):
    return rel.Edge(kind="join_mined", directed=False, status="proposed",
                    source=rel.Endpoint(table=src, column=sc), target=rel.Endpoint(table=tgt, column=tc),
                    provenance=rel.Provenance(origin="query_history", source_ref=refs[0]),
                    evidence=rel.Evidence(runs=runs, users=users, first_seen=first, last_seen=last,
                                          sample_refs=list(refs)))


@pytest.fixture
def store():
    s = rel.Store(":memory:")
    yield s
    s.close()


def test_new_mined_edges_are_stored_as_given(store):
    assert store.upsert_mined([mined(A, "id", B, "oid")]) == (1, 0)
    (e,) = store.all_edges()
    assert (e.status, e.evidence.runs) == ("proposed", 1)


def test_the_same_pair_written_the_other_way_round_is_one_edge(store):
    store.upsert_mined([mined(A, "id", B, "oid")])
    assert store.upsert_mined([mined(B, "oid", A, "id", runs=2)]) == (0, 1)
    assert len(store.all_edges()) == 1


def test_evidence_is_added_users_take_the_larger_count_and_refs_are_newest_first_and_capped(store):
    store.upsert_mined([mined(A, "id", B, "oid", runs=3, users=4, last="2026-11-01", refs=("a", "b", "c"))])
    store.upsert_mined([mined(A, "id", B, "oid", runs=2, users=1, first="2026-11-05", last="2026-11-09",
                              refs=("d", "e", "f"))])
    (e,) = store.all_edges()
    assert (e.evidence.runs, e.evidence.users) == (5, 4)
    assert (e.evidence.first_seen, e.evidence.last_seen) == ("2026-10-01", "2026-11-09")
    assert e.evidence.sample_refs == ["d", "e", "f", "a", "b"]
    assert e.provenance.source_ref == "d"


def test_replace_swaps_the_evidence_and_status_and_notes_survive_either_way(store):
    store.upsert_mined([mined(A, "id", B, "oid", runs=9)])
    (e,) = store.all_edges()
    store.patch(e.id, "accepted", "checked")
    store.upsert_mined([mined(A, "id", B, "oid", runs=2)], replace=True)
    (e2,) = store.all_edges()
    assert (e2.id, e2.status, e2.note, e2.evidence.runs) == (e.id, "accepted", "checked", 2)


def test_upsert_mined_refuses_derived_kinds_and_loops(store):
    bad = mined(A, "id", B, "oid")
    bad.kind = "fk"
    with pytest.raises(rel.RelationshipInvalid, match="derived"):
        store.upsert_mined([bad])
    with pytest.raises(rel.RelationshipInvalid, match="itself"):
        store.upsert_mined([mined(A, "id", A, "id")])


def test_suggestions_sort_by_runs_then_users_then_recency_and_filter_by_status_and_table(store):
    store.upsert_mined([mined(A, "a", B, "a", runs=5, users=1), mined(A, "b", B, "b", runs=9, users=2),
                        mined(A, "c", B, "c", runs=5, users=3), mined(A, "d", C, "d", runs=5, users=3, last="2026-11-09")])
    order = [e.source.column for e in store.suggestions()]
    assert order == ["b", "d", "c", "a"]
    assert [e.source.column for e in store.suggestions(table=C)] == ["d"]
    store.patch(store.suggestions()[0].id, "rejected")
    assert [e.source.column for e in store.suggestions()] == ["d", "c", "a"]
    assert [e.source.column for e in store.suggestions(("rejected",))] == ["b"]
    assert store.status_counts() == {"proposed": 3, "accepted": 0, "rejected": 1}


def test_suggestions_ignore_other_kinds(store):
    store.upsert_mined([mined(A, "a", B, "a")])
    store.create_manual(rel.EdgeCreate(source=rel.Endpoint(table=A), target=rel.Endpoint(table=C)))
    assert len(store.suggestions()) == 1 and store.suggestions(kind="manual") == []


def test_bulk_status_is_all_or_none(store):
    store.upsert_mined([mined(A, "a", B, "a"), mined(A, "b", B, "b")])
    ids = [e.id for e in store.all_edges()]
    assert store.set_status_many(ids + ids[:1], "accepted") == 2
    assert {e.status for e in store.all_edges()} == {"accepted"}
    with pytest.raises(rel.RelationshipNotFound):
        store.set_status_many([ids[0], "e_missing"], "rejected")
    assert {e.status for e in store.all_edges()} == {"accepted"}
    with pytest.raises(rel.RelationshipInvalid, match="status"):
        store.set_status_many(ids, "derived")


def test_bulk_body_and_status_filter_validation():
    assert rel.parse_bulk({"ids": ["e_1"], "status": "rejected"}).status == "rejected"
    for body in ({"ids": [], "status": "accepted"}, {"ids": ["e_1"], "status": "derived"}, {"ids": ["e_1"]},
                 {"ids": ["fk:a->b"], "status": "accepted"}, {"ids": ["e_1"], "status": "accepted", "x": 1}, []):
        with pytest.raises(rel.RelationshipInvalid):
            rel.parse_bulk(body)
    assert rel.check_statuses(["proposed", "accepted"]) == ("proposed", "accepted")
    for bad in ([], ["derived"], ["nope"]):
        with pytest.raises(rel.RelationshipInvalid):
            rel.check_statuses(bad)


ROWS = [
    {"source_table_full_name": A, "source_column_name": "amount", "target_table_full_name": C,
     "target_column_name": "revenue", "last_seen": "2026-11-10T08:00:00.000Z"},
    {"source_table_full_name": A, "source_column_name": "amount", "target_table_full_name": C,
     "target_column_name": "revenue", "last_seen": "2026-11-09T08:00:00.000Z"},  # duplicate pair
    {"source_table_full_name": "s3://bucket/path", "source_column_name": "x", "target_table_full_name": C,
     "target_column_name": "y"},  # a path, not a table
    {"source_table_full_name": A, "source_column_name": "id", "target_table_full_name": A, "target_column_name": "id"},
    {"source_table_full_name": A, "source_column_name": "id"},  # incomplete
]


def test_column_lineage_rows_become_derived_edges_and_junk_is_skipped():
    edges = rel.derive_column_lineage(ROWS, "2026-11-12T00:00:00+00:00")
    assert len(edges) == 1
    e = edges[0]
    assert e.id == f"lineage:{A}#amount->{C}#revenue" and e.status == "derived" and e.kind == "lineage"
    assert (e.provenance.origin, e.provenance.fetched_at) == ("unity_catalog:column_lineage", "2026-11-12T00:00:00+00:00")
    assert e.evidence.last_seen == "2026-11-10T08:00:00.000Z"


def test_unified_adds_column_lineage_only_at_column_level_and_keeps_notes(store):
    payload = {"fetched_at": "2026-11-12T00:00:00+00:00", "data": ROWS}
    rid = f"lineage:{A}#amount->{C}#revenue"
    store.set_derived_note(rid, "sum of amount")
    table_level = rel.unified(store, A, None, None, "table", payload)
    assert table_level["edges"] == []
    column_level = rel.unified(store, A, None, None, "column", payload)
    (edge,) = column_level["edges"]
    assert edge["id"] == rid and edge["note"] == "sum of amount" and edge["source"]["column"] == "amount"
    assert C in {n["id"] for n in column_level["nodes"]}
    assert rel.unified(store, A, None, None, "column", None)["edges"] == []
