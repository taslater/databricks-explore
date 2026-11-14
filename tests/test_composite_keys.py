"""Composite keys: several column pairs between two tables in one join condition, from extraction to stored evidence."""
from datetime import timedelta

import pytest

import relationships as rel
from sqltools import join_analysis, join_pairs
from test_mining import NOW, O, C, S, FakeEx, Q_OS, data_dir, mine, stmt, stored  # noqa: F401

L, PS = "demo.sales.lineitem", "demo.sales.partsupp"
K_PART, K_SUPP = (L, "l_partkey", PS, "ps_partkey"), (L, "l_suppkey", PS, "ps_suppkey")
Q_COMPOSITE = ("SELECT * FROM demo.sales.lineitem l JOIN demo.sales.partsupp ps "
               "ON l.l_partkey = ps.ps_partkey AND l.l_suppkey = ps.ps_suppkey")
Q_PART = "SELECT * FROM demo.sales.lineitem l JOIN demo.sales.partsupp ps ON l.l_partkey = ps.ps_partkey"
BOTH = (("l_partkey", "ps_partkey"), ("l_suppkey", "ps_suppkey"))
ON2 = "SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c ON o.a = c.a AND o.b = c.b"


# ---------- sqltools.join_analysis ----------

def test_two_pairs_in_one_on_condition_are_one_composite_key():
    found, composites = join_analysis(Q_COMPOSITE)
    assert {tuple(p)[:4] for p in found} == {K_PART, K_SUPP}
    assert composites == [(K_PART, K_SUPP)]


def test_join_pairs_returns_the_same_pairs_as_the_analysis():
    assert join_pairs(Q_COMPOSITE) == join_analysis(Q_COMPOSITE)[0]


def test_using_with_two_columns_is_a_composite_key():
    _, composites = join_analysis("SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c USING (a, b)")
    assert composites == [((C, "a", O, "a"), (C, "b", O, "b"))]


def test_three_pairs_are_one_composite_of_three():
    sql = "SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c ON o.a = c.a AND o.b = c.b AND c.c = o.c"
    (composite,) = join_analysis(sql)[1]
    assert len(composite) == 3


def test_a_single_pair_is_not_composite():
    assert join_analysis("SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c ON o.a = c.a")[1] == []


def test_pairs_from_separate_conditions_are_not_composite():
    sql = ("SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c ON o.a = c.a "
           "JOIN demo.sales.customers c2 ON o.b = c2.b")
    assert join_analysis(sql)[1] == []


def test_pairs_to_different_tables_in_one_condition_are_not_composite():
    sql = ("SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c ON o.a = c.a "
           "JOIN demo.sales.products p ON o.b = p.b")
    assert join_analysis(sql)[1] == []
    sql = ("SELECT * FROM demo.sales.orders o, demo.sales.customers c, demo.sales.products p "
           "WHERE o.a = c.a AND o.b = p.b")
    assert join_analysis(sql)[1] == []


def test_an_or_condition_is_not_composite():
    sql = "SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c ON o.a = c.a OR o.b = c.b"
    assert join_analysis(sql)[1] == []


def test_the_same_pair_written_twice_is_not_composite():
    sql = "SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c ON o.a = c.a AND c.a = o.a"
    assert join_analysis(sql)[1] == []


def test_the_same_composite_in_two_places_is_reported_once():
    assert len(join_analysis(f"{ON2}; {ON2}")[1]) == 1


def test_implicit_join_where_equalities_are_composite():
    sql = "SELECT * FROM demo.sales.orders o, demo.sales.customers c WHERE o.a = c.a AND o.b = c.b"
    assert len(join_analysis(sql)[1]) == 1


def test_merge_on_with_two_pairs_is_composite():
    sql = "MERGE INTO demo.sales.orders o USING demo.sales.customers c ON o.a = c.a AND o.b = c.b WHEN MATCHED THEN DELETE"
    assert len(join_analysis(sql)[1]) == 1


# ---------- mining: evidence ----------

def test_pairs_joined_together_record_their_siblings_and_how_often(data_dir):
    rows = [stmt(1, Q_COMPOSITE, lineage=[L, PS]), stmt(2, Q_COMPOSITE, lineage=[L, PS]), stmt(3, Q_PART, lineage=[L, PS])]
    mine(FakeEx(rows))
    part, supp = stored()[K_PART], stored()[K_SUPP]
    assert [(tuple(t.columns), t.runs) for t in part.evidence.together] == [(BOTH, 2)]
    assert [(tuple(t.columns), t.runs) for t in supp.evidence.together] == [(BOTH, 2)]
    assert (part.evidence.runs, supp.evidence.runs) == (3, 2)  # the part pair also appears on its own once


def test_a_pair_that_is_never_composite_has_no_siblings(data_dir):
    mine(FakeEx([stmt(1, Q_OS, lineage=[O, S])]))
    assert stored()[(O, "order_id", S, "order_id")].evidence.together == []


def test_composite_counts_add_up_across_incremental_runs(data_dir):
    mine(FakeEx([stmt(1, Q_COMPOSITE, lineage=[L, PS])]))
    mine(FakeEx([stmt(2, Q_COMPOSITE, day=13, lineage=[L, PS])]), now=NOW + timedelta(days=2))
    (t,) = stored()[K_PART].evidence.together
    assert t.runs == 2


def test_a_declared_key_stays_in_the_composite_columns_but_gets_no_edge(data_dir):
    mine(FakeEx([stmt(1, Q_COMPOSITE, lineage=[L, PS])], fks={L: (L, PS, "l_suppkey", "ps_suppkey")}))
    assert list(stored()) == [K_PART]
    (t,) = stored()[K_PART].evidence.together
    assert tuple(t.columns) == BOTH


# ---------- relationships.Evidence ----------

def _mined(runs, *sets):
    e = rel.Edge(kind="join_mined", directed=False, status="proposed",
                 source=rel.Endpoint(table="main.s.a", column="id"), target=rel.Endpoint(table="main.s.b", column="oid"),
                 provenance=rel.Provenance(origin="query_history", source_ref="s1"),
                 evidence=rel.Evidence(runs=runs, users=1, first_seen="2026-10-01", last_seen="2026-11-01"))
    e.evidence.together = [rel.Together(columns=cols, runs=n) for cols, n in sets]
    return e


def test_together_counts_are_added_by_column_set_most_runs_first_and_capped():
    ab = (("id", "oid"), ("k", "k"))
    other = (("id", "oid"), ("z", "z"))
    with rel.Store(":memory:") as store:
        store.upsert_mined([_mined(3, (ab, 2))])
        store.upsert_mined([_mined(2, (ab, 1), (other, 1))])
        (e,) = store.all_edges()
        assert [(tuple(t.columns), t.runs) for t in e.evidence.together] == [(ab, 3), (other, 1)]
        many = [((("id", "oid"), (f"c{i}", f"c{i}")), i + 1) for i in range(8)]
        store.upsert_mined([_mined(1, *many)])
        assert len(store.all_edges()[0].evidence.together) == rel.MAX_TOGETHER


def test_stored_evidence_without_together_still_loads():
    assert rel.Evidence.model_validate({"runs": 1, "sample_refs": []}).together == []


def test_a_replacing_run_swaps_the_together_counts():
    ab = (("id", "oid"), ("k", "k"))
    with rel.Store(":memory:") as store:
        store.upsert_mined([_mined(3, (ab, 3))])
        store.upsert_mined([_mined(1, (ab, 1))], replace=True)
        assert store.all_edges()[0].evidence.together[0].runs == 1
